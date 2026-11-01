// The working copies of the bulk test: one backup of the source for each path, trimmed to the same sample.
import { existsSync, rmSync } from "node:fs";
import type { Config } from "../../src/config/index.js";
import { RequestKind } from "../../src/domain/index.js";
import {
  backupDatabase,
  clearQueuePause,
  closeStore,
  failRequest,
  openStoreFor,
  peekQueue,
  readBatchStartSeq,
  resetRunning,
  type Store,
} from "../../src/store/index.js";
import { assertWikiCurrent } from "./wiki.js";

/** The error text that the harness leaves on a queued row that is not in the sample. */
const NOT_IN_SAMPLE = "bulk test: not in the sample";

/** More than any queue holds; `peekQueue` takes a limit. */
const WHOLE_QUEUE = 1_000_000;

/** One working copy, open. */
export interface WorkingCopy {
  store: Store;
  /** The sampled requests, in queue order. */
  ids: string[];
  /** The queued submissions of the copy before the trim. */
  queued: number;
}

/**
 * Removes a database file and its side files.
 *
 * @param path - the database file
 * @sideEffects deletes files; a missing file is fine
 */
export function removeDbFiles(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
}

/**
 * Opens a working copy that an earlier run kept, for a resume: it clears the queue pause that a rate limit may have set and
 * puts the requests that the stop left `running` back in the queue (`resetRunning`, as the worker does at its start).
 *
 * @param file - the working copy of the earlier run
 * @param config - the store settings of the wiki
 * @param ids - the sampled requests, in queue order, from the result file
 * @returns the open copy; `queued` is 0 because the queue is not read again
 * @throws {Error} when the copy file is missing (the earlier run removed it, or it ran without a stop)
 * @sideEffects opens the copy; clears the `queue_pause` key; sets the `running` requests to `queued`
 */
export function openCopy(file: string, config: Config, ids: string[]): WorkingCopy {
  if (!existsSync(file))
    throw new Error(`the working copy ${file} is missing: a resume needs the copies of the stopped run`);
  const store = openStoreFor(config, file);
  clearQueuePause(store);
  // The stop left the requests of its step `running`, and no step takes those; the worker does the same at its start.
  resetRunning(store);
  return { store, ids, queued: 0 };
}

/**
 * Copies the source with the SQLite backup API, opens the copy (it migrates to the schema of this code), clears the
 * queue pause and trims the queue to the first `n` queued submissions: every other queued row fails with a note. The source is
 * never written.
 *
 * @param source - the source database; read only
 * @param to - the working copy; an earlier file there is removed
 * @param config - the store settings of the wiki
 * @param n - the number of submissions in the sample
 * @returns the open copy, the sample ids and the queued submissions it held
 * @throws {Error} when the source is a bulk-test wiki that is stale against `fakes/bulk-submissions.ts`, or the copy holds fewer than `n` queued submissions or a batch that did not end
 * @sideEffects writes `to`; the copy is written (queue rows, the `queue_pause` key); the source is read
 */
export async function makeCopy(source: string, to: string, config: Config, n: number): Promise<WorkingCopy> {
  assertWikiCurrent(source);
  removeDbFiles(to);
  await backupDatabase(source, to);
  const store = openStoreFor(config, to);
  try {
    if (readBatchStartSeq(store) !== undefined) {
      throw new Error("the source holds a batch that did not end: take a copy of a quiet wiki");
    }
    clearQueuePause(store);
    const queue = peekQueue(store, WHOLE_QUEUE);
    const submissions = queue.filter((r) => r.kind === RequestKind.Submission);
    if (submissions.length < n)
      throw new Error(`the source holds ${submissions.length} queued submissions, fewer than --requests ${n}`);
    const ids = submissions.slice(0, n).map((r) => r.id);
    const keep = new Set(ids);
    for (const r of queue) if (!keep.has(r.id)) failRequest(store, r.id, NOT_IN_SAMPLE);
    return { store, ids, queued: submissions.length };
  } catch (e) {
    closeStore(store);
    removeDbFiles(to);
    throw e;
  }
}
