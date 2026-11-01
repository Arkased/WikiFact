// The two paths of the bulk test: the sampled requests 1 at a time, and as batches of the high volume mode.
import type { Config, PriceTable } from "../../src/config/index.js";
import { BatchRunStatus, RunOnceStatus } from "../../src/domain/index.js";
import type { Logger } from "../../src/log/index.js";
import type { Store } from "../../src/store/index.js";
import { batchStep, runOnce, type Questions } from "../../src/updates/index.js";
import { BulkPath, BulkStop } from "../lib/enums.js";
import { countOutcomes, countUnfinished, measureUsage, readRequests } from "./measure.js";
import type { PathResult } from "./types.js";

/** The steps that a path may take per sampled request before the harness gives up (a pipeline that never idles). */
const MAX_STEPS_PER_REQUEST = 20;

/** The extra steps allowed over the per-request bound, for the follow-up requests of a split. */
const SPARE_STEPS = 100;

/** What a path run needs. */
export interface PathOptions {
  path: BulkPath;
  store: Store;
  questions: Questions;
  config: Config;
  prices: PriceTable;
  log: Logger;
  /** The sampled requests, in queue order. */
  ids: string[];
  /** The clock in ms. */
  now: () => number;
  /** Called with the result so far after each step; the caller writes the file. Its time counts as snapshot time. */
  onProgress: (r: PathResult) => void;
  /** The result of an earlier run of this path that stopped; the path continues from its last finished step. */
  resume?: PathResult;
}

/** How a path ended. */
export interface PathEnd {
  result: PathResult;
  stoppedBy?: BulkStop;
}

/** The counters and the clocks of a path run, with the one function that builds its result. */
interface PathTracker {
  startedAt: number;
  attemptErrors: string[];
  batches: PathResult["batches"];
  steps: number;
  wallMs: number;
  snapshotMs: number;
  /** Fields that only a result of #60 holds (`rounds`, `queuedAfter`); they carry over into each result. */
  extra: Pick<PathResult, "rounds" | "queuedAfter" | "roundGroups">;
  /**
   * Builds the result so far. The snapshot and the progress call are not work of the path: their time goes to `snapshotMs`,
   * never to `wallMs`.
   *
   * @param complete - whether the path ran to the end of its queue
   * @param progress - true to hand the result to `onProgress`
   * @returns the result
   * @sideEffects reads the copy; reads the clock; calls `onProgress` when `progress` is true
   */
  report: (complete: boolean, progress: boolean) => PathResult;
}

/**
 * Starts the counters and the clocks of a path run; with `resume` they carry over from the earlier result.
 *
 * @param opts - the options of the path
 * @returns the tracker
 * @sideEffects reads the clock
 */
function createTracker(opts: PathOptions): PathTracker {
  const { store, path, ids } = opts;
  const t: PathTracker = {
    startedAt: opts.resume?.startedAtMs ?? opts.now(),
    attemptErrors: [...(opts.resume?.attemptErrors ?? [])],
    batches: [...(opts.resume?.batches ?? [])],
    steps: opts.resume?.steps ?? 0,
    wallMs: opts.resume?.wallMs ?? 0,
    snapshotMs: opts.resume?.snapshotMs ?? 0,
    extra: {},
    report: (complete, progress) => {
      const start = opts.now();
      const requests = readRequests(store, ids);
      const built: PathResult = {
        path,
        complete,
        startedAtMs: t.startedAt,
        wallMs: t.wallMs,
        snapshotMs: t.snapshotMs,
        usage: measureUsage(store, t.startedAt, opts.prices),
        outcomes: countOutcomes(requests),
        steps: t.steps,
        batches: t.batches,
        attemptErrors: t.attemptErrors,
        requests,
        ...t.extra,
      };
      t.snapshotMs += opts.now() - start;
      const r = { ...built, snapshotMs: t.snapshotMs };
      if (progress) {
        const start2 = opts.now();
        opts.onProgress(r);
        t.snapshotMs += opts.now() - start2;
      }
      return r;
    },
  };
  return t;
}

/**
 * Closes a path run: builds the last result and counts the requests that no step can take any more.
 *
 * @param t - the tracker of the run
 * @param complete - whether the queue went idle (or the rounds ended) with no rate limit
 * @param stoppedBy - the reason the run stopped early; absent when it did not
 * @returns the result (not complete when a request of the sample is still `running` or `queued`, which `unfinished` counts) and the stop reason
 * @sideEffects reads the copy and the clock
 */
function endPath(t: PathTracker, complete: boolean, stoppedBy: BulkStop | undefined): PathEnd {
  const ended = t.report(complete, false);
  // A request that is still `running` or `queued` at the idle queue is one that no step can take: the path did not end.
  const unfinished = complete ? countUnfinished(ended.requests) : 0;
  const result: PathResult = unfinished > 0 ? { ...ended, complete: false, unfinished } : ended;
  return { result, ...(stoppedBy === undefined ? {} : { stoppedBy }) };
}

/**
 * Runs one path to the end of its queue, or to the first rate limit. The sequential path runs `runOnce` until the queue is
 * idle. The batch path is the worker's: it runs `batchStep` with no wait (`waitMs` 0, so a batch starts at once with the
 * submissions at the front) until it takes no batch; a request that is not a submission, or that no batch took, runs with
 * `runOnce`. The wall time is the sum of the time of the steps; the time of
 * the snapshots (reading the requests, measuring the usage, the `onProgress` call) is kept apart as `snapshotMs`. With
 * `resume`, the counters, the times and the start of the usage window carry over from the earlier result.
 *
 * @param opts - the copy, the questions, the config, the prices, the logger, the sample and the progress callback
 * @returns the result (complete unless a rate limit stopped the path, the step bound was hit or a request of the sample is still
 *   `running` or `queued` at the idle queue, which `unfinished` counts) and the stop reason
 * @sideEffects writes the copy (the pipeline); model calls; embedder runs; reads the clock; calls `onProgress` after each step
 */
export async function runPath(opts: PathOptions): Promise<PathEnd> {
  const { store, path, ids } = opts;
  const tracker = createTracker(opts);
  const { batches, attemptErrors, report } = tracker;
  // No wait: the oldest front submission has always waited long enough, so the step never holds.
  const config: Config = { ...opts.config, highVolume: { ...opts.config.highVolume, waitMs: 0 } };
  const limit = ids.length * MAX_STEPS_PER_REQUEST + SPARE_STEPS;
  let complete = false;
  let stoppedBy: BulkStop | undefined;
  while (tracker.steps < limit) {
    const stepStart = opts.now();
    const b =
      path === BulkPath.Batch
        ? await batchStep({ store, questions: opts.questions, config, log: opts.log, now: opts.now })
        : ({ ran: false, hold: false } as const);
    if (b.ran) {
      tracker.steps++;
      const r = b.result;
      switch (r.status) {
        case BatchRunStatus.Done:
          batches.push({ status: r.status, size: r.size });
          if (r.error !== undefined) attemptErrors.push(r.error);
          break;
        case BatchRunStatus.RateLimited:
          batches.push({ status: r.status });
          attemptErrors.push(r.error);
          stoppedBy = BulkStop.RateLimit;
          break;
        case BatchRunStatus.Stopped:
          batches.push({ status: r.status });
          break;
        case BatchRunStatus.Dropped:
          batches.push({ status: r.status });
          attemptErrors.push(r.error);
          break;
      }
      tracker.wallMs += opts.now() - stepStart;
      report(false, true);
      if (stoppedBy !== undefined || r.status === BatchRunStatus.Stopped) break;
      continue;
    }
    const r = await runOnce(store, opts.questions, opts.config, { log: opts.log, now: opts.now });
    tracker.wallMs += opts.now() - stepStart;
    if (r.status === RunOnceStatus.Idle) {
      complete = true;
      break;
    }
    tracker.steps++;
    if (r.status === RunOnceStatus.RateLimited) {
      attemptErrors.push(r.error);
      stoppedBy = BulkStop.RateLimit;
    } else if (r.status !== RunOnceStatus.Done) attemptErrors.push(r.error);
    report(false, true);
    if (stoppedBy !== undefined) break;
  }
  return endPath(tracker, complete, stoppedBy);
}
