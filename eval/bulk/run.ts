// The bulk test: the same queued submissions 1 at a time on one copy and as batches on another, from the same start
// (technical/updates.md, "High volume mode", "The test of both paths").
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Config, PriceTable } from "../../src/config/index.js";
import type { Logger } from "../../src/log/index.js";
import { closeStore, highestChangeSeq, type Store } from "../../src/store/index.js";
import type { Questions } from "../../src/updates/index.js";
import { JSON_INDENT } from "../../src/constants.js";
import { BulkPath } from "../lib/enums.js";
import { compareCopies } from "./compare.js";
import { findDuplicates } from "./duplicates.js";
import { runPath } from "./paths.js";
import { makeCopy, openCopy, removeDbFiles, type WorkingCopy } from "./prepare.js";
import { scorePath } from "./score.js";
import type { BulkResultFile, PathResult } from "./types.js";

/** The options of `runBulkTest`. */
export interface BulkOptions {
  /** The source copy; read only. */
  db: string;
  /** The submissions in the sample. */
  requests: number;
  /** The environment and the wiki that `db` was resolved from, for the result file; absent for a `--db` run. */
  wiki?: { env: string; name: string };
  /** The folder of the two working copies. */
  workDir: string;
  /** The result file; its folder is made when it is missing. */
  outPath: string;
  /** The config with `highVolume.batchSize`, `concurrency` and `groupCut` already set. */
  config: Config;
  /** Makes the questions of one copy (the group call included); the store is the copy, so the calls write their `model_calls` rows into it. */
  makeQuestions: (store: Store) => Questions;
  /** The questions of the duplicate judging (Q1); no store. */
  judge: Questions;
  prices: PriceTable;
  log: Logger;
  keepCopies?: boolean;
  stub?: boolean;
  /** True to run only the second path: no benchmark copy, no sequential path, no differences. A resume takes it from its file. */
  secondOnly?: boolean;
  /** The result file of a stopped run: the run opens its kept copies and continues each path from its last finished step. */
  resume?: BulkResultFile;
  /** The clock in ms. Default: `Date.now`. */
  now?: () => number;
  /** Receives one progress line. Default: nothing. */
  say?: (line: string) => void;
}

/**
 * Runs the bulk test: copies the source twice, trims each copy to the same first `requests` queued submissions, runs the
 * sequential path on one and the batch path of the worker on the other (one after the other, never at the same time), then judges the
 * duplicates among the facts each path wrote and compares the copies. With `secondOnly`, only the second path runs, on one
 * copy, and the file holds no sequential path and no differences. The result file is rewritten after each request or
 * batch. A rate limit stops the run: the file keeps what was measured and says where it stopped, and the copies stay on disk.
 * With `resume`, the run opens those copies and continues from the file; a path that ended is not run again.
 *
 * @param o - the source, the sample size, the folders, the config, the questions and the clock
 * @returns the result file as written
 * @throws {Error} when the source holds fewer queued submissions than `requests` or a batch that did not end; on a resume, when the
 *   `env` or the `wiki` of the file differs from `wiki`, the file holds no sample or a copy is missing, or the file holds an
 *   `arch` (a run of #60: the architecture is gone)
 * @sideEffects writes the working copies (the sequential and the batch copy, or with `secondOnly` the batch copy only; removed at the end unless `keepCopies` or the run did not end) and `outPath`; model calls; embedder
 *   runs; the source is only read
 */
export async function runBulkTest(o: BulkOptions): Promise<BulkResultFile> {
  const say = o.say ?? ((): void => undefined);
  const now = o.now ?? Date.now;
  if (o.resume?.arch !== undefined) {
    throw new Error(
      `--resume cannot continue a run of the architecture ${o.resume.arch} (#60): the architecture is gone; start the run again`,
    );
  }
  if (o.resume && (o.resume.env !== o.wiki?.env || o.resume.wiki !== o.wiki?.name)) {
    const named = (env?: string, wiki?: string): string =>
      wiki === undefined ? "a --db run" : `wiki ${wiki} of env ${env ?? "?"}`;
    throw new Error(
      `the result file is of ${named(o.resume.env, o.resume.wiki)}, not of ${named(o.wiki?.env, o.wiki?.name)}; resume with the same --wiki and --env`,
    );
  }
  mkdirSync(o.workDir, { recursive: true });
  const seqPath = join(o.workDir, "bulk-sequential.sqlite");
  const batchPath = join(o.workDir, "bulk-batch.sqlite");
  // A resume continues the run as its file recorded it, whatever the options say.
  const secondOnly = o.resume ? (o.resume.secondOnly ?? false) : (o.secondOnly ?? false);
  const copies: { path: BulkPath; file: string; copy?: WorkingCopy }[] = [
    ...(secondOnly ? [] : [{ path: BulkPath.Sequential, file: seqPath }]),
    { path: BulkPath.Batch, file: batchPath },
  ];
  const file: BulkResultFile = o.resume ?? {
    startedAt: new Date(now()).toISOString(),
    complete: false,
    source: basename(o.db),
    ...(o.wiki ? { env: o.wiki.env, wiki: o.wiki.name } : {}),
    requests: o.requests,
    queuedInSource: 0,
    startSeq: 0,
    batchSize: o.config.highVolume.batchSize,
    concurrency: o.config.highVolume.concurrency,
    groupCut: o.config.highVolume.groupCut,
    stub: o.stub ?? false,
    ...(secondOnly ? { secondOnly } : {}),
  };
  const flush = (): void => {
    mkdirSync(dirname(o.outPath), { recursive: true });
    writeFileSync(o.outPath, JSON.stringify(file, null, JSON_INDENT) + "\n");
  };
  if (o.resume) {
    file.complete = false;
    delete file.stoppedBy;
  }
  flush();
  try {
    if (o.resume) {
      const ids = (o.resume.sequential ?? o.resume.batch)?.requests.map((r) => r.requestId);
      if (!ids) throw new Error("the result file holds no path to resume");
      for (const c of copies) {
        c.copy = openCopy(c.file, o.config, ids);
        say(`${c.path}: copy reopened, sample of ${ids.length}`);
      }
    } else {
      for (const c of copies) {
        c.copy = await makeCopy(o.db, c.file, o.config, o.requests);
        say(`${c.path}: copy made, ${c.copy.queued} queued submissions in the source, sample of ${c.copy.ids.length}`);
      }
    }
    const seq = copies.find((c) => c.path === BulkPath.Sequential)?.copy;
    const batch = copies.find((c) => c.path === BulkPath.Batch)?.copy;
    if (!batch || (!secondOnly && !seq)) throw new Error("the working copies were not made");
    if (!o.resume) {
      file.queuedInSource = batch.queued;
      file.startSeq = highestChangeSeq(batch.store);
    }
    const startSeq = file.startSeq;
    flush();
    const run = async (c: WorkingCopy, path: BulkPath): Promise<PathResult | undefined> => {
      const earlier = file[path];
      if (earlier?.complete) return earlier;
      say(`${path}: ${earlier ? "resume" : "start"}`);
      const end = await runPath({
        path,
        store: c.store,
        questions: o.makeQuestions(c.store),
        config: o.config,
        prices: o.prices,
        log: o.log,
        ids: c.ids,
        now,
        ...(earlier ? { resume: earlier } : {}),
        onProgress: (r) => {
          file[path] = r;
          flush();
        },
      });
      file[path] = end.result;
      if (end.stoppedBy !== undefined) file.stoppedBy = end.stoppedBy;
      flush();
      say(
        `${path}: ${end.result.complete ? "done" : "stopped"} in ${end.result.wallMs} ms, ${end.result.usage.calls} calls`,
      );
      return end.stoppedBy === undefined ? end.result : undefined;
    };
    const first = seq ? await run(seq, BulkPath.Sequential) : undefined;
    if (seq && !first) return file;
    const second = await run(batch, BulkPath.Batch);
    if (!second) return file;
    const judged: [WorkingCopy, PathResult][] = [[batch, second]];
    if (seq && first) judged.unshift([seq, first]);
    for (const [c, r] of judged) {
      if (!r.duplicates?.complete) {
        say(`${r.path}: judging the duplicates`);
        r.duplicates = await findDuplicates({
          store: c.store,
          questions: o.judge,
          subject: o.config.subject,
          sinceSeq: startSeq,
          distance: c.store.config.neighborDistance,
        });
      }
      const score = scorePath(c.store, startSeq, r);
      if (score) {
        r.score = score;
        say(score.line);
      }
      file[r.path] = r;
      flush();
    }
    if (seq && first) {
      file.differences = compareCopies({
        sequentialStore: seq.store,
        batchStore: batch.store,
        sinceSeq: startSeq,
        sequential: first,
        batch: second,
      });
    }
    file.complete = (first?.complete ?? true) && second.complete;
    flush();
    return file;
  } finally {
    for (const c of copies) {
      if (c.copy) closeStore(c.copy.store);
      // A run that did not end keeps its copies, so that `resume` can open them.
      const resumable = !file.complete && (file.sequential ?? file.batch) !== undefined;
      if (!o.keepCopies && !resumable) removeDbFiles(c.file);
    }
  }
}
