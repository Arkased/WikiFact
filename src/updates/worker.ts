// technical/updates.md, "Queue and worker" and technical/deployment.md, "Install and run": the update worker loop. One per database, held by a lock file (see lock.ts).
import type { Config } from "../config/index.js";
import { BatchRunStatus, LogEvent, LogLevel, PauseReason, ProcessOutcome, RunOnceStatus } from "../domain/enums.js";
import { embed } from "../embed/index.js";
import { stderrLogger, type Logger } from "../log/index.js";
import {
  closeStore,
  getRequest,
  openStoreFor,
  queuedRepairIds,
  readQueuePause,
  resetRunning,
  writeWorkerStatus,
  type Store,
  type WorkerStatus,
} from "../store/index.js";
import { errorMessage } from "../must.js";
import { batchStep } from "./batch/index.js";
import { cleanupIfDue } from "./cleanup-run.js";
import { acquireLock } from "./lock.js";
import type { Questions } from "./types.js";
import { runOnce, runRequest } from "./run-once.js";
import {
  afterSoloStep,
  initialWorkerStatus,
  nextRateLimitPauseMs,
  nextBatchWorkerStatus,
  nextWorkerStatus,
  operatorPausedWorkerStatus,
  pausedWorkerStatus,
  RATE_LIMIT_RESET_MARGIN_MS,
  rateLimitResetAt,
  resumedWorkerStatus,
} from "./worker-status.js";

/** How often a running worker refreshes `lastPollAt` while a request is in progress, in milliseconds. */
const DEFAULT_HEARTBEAT_MS = 15000;

/** The poll interval when the queue is empty, in milliseconds (technical/deployment.md, "Install and run"). */
const DEFAULT_POLL_MS = 1000;

/** The base delay after a failed attempt, in milliseconds. The loop waits attempts times this. */
export const DEFAULT_RETRY_DELAY_MS = 10000;

/** The options of `runWorker`. */
export interface RunWorkerOptions {
  dbPath: string;
  config: Config;
  questions: Questions;
  /** Poll interval when the queue is empty, in ms. Default `DEFAULT_POLL_MS`. */
  pollMs?: number;
  /** Base delay after a failed attempt: the loop waits attempts * this, in ms. Default `DEFAULT_RETRY_DELAY_MS`. */
  retryDelayMs?: number;
  /**
   * How often the worker refreshes `lastPollAt` in the status, in ms, so that a long request does not read as a
   * worker that stopped. Default `DEFAULT_HEARTBEAT_MS`.
   */
  heartbeatMs?: number;
  /** Abort to stop the loop after the current request. */
  signal?: AbortSignal;
  log?: Logger;
}

// Resolves after `ms`, or at once when the signal aborts: an abort ends the wait quietly. Hand-written because fake
// timers do not patch `node:timers/promises`, so the tests could not control its wait.
const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });

/**
 * Runs the worker loop on a database until the signal aborts: takes the lock, resets running requests, then runs
 * one request after another and waits when the queue is empty or an attempt failed, and pauses (no poll, no request)
 * after a rate limit of the model.
 *
 * @param opts - the database, the config, the questions, the delays, the abort signal and the logger
 * @returns when the signal aborts and the current request is done; never otherwise
 * @throws {LockError} when another worker holds the lock of the database
 * @throws {StoreMismatchError} when the database `meta` disagrees with the config
 * @sideEffects creates the lock file `<db>.lock` and removes it at the end; installs a process `exit` hook that
 *   removes it; opens the write connection and closes it at the end; sets `running` rows back to `queued`; loads
 *   the embedding model; the loop sleeps (timers) when idle or after a failed attempt, keeps in memory the retry wait of each `cleanupRepair`
 *   row that failed an attempt in the cleanup step (the step and the normal take pass over it until the wait ends;
 *   a restart loses it), writes to the store and
 *   calls the questions; writes the `worker_status` row of `meta` at start, on a heartbeat timer, and after every
 *   step; reads the clock; after each step that ends a request, and after a poll with no queued row, runs the cleanup step of technical/cleanup.md, "When it runs" (runs the queued
 *   `cleanupRepair` rows 1 at a time, runs the trigger with `meta.cleanup_seq`, then the repairs it queued; a rate limit pauses); logs `LogEvent.WorkerStart`, `LogEvent.WorkerStop`, `LogEvent.LockTakeover` and the
 *   lines of each request; after a rate limit writes the paused status and logs `LogEvent.RateLimitPause` (`warn`,
 *   once per pause); reads the `queue_pause` key at the top of each loop and, while it exists, takes no request, writes
 *   the operator paused status and logs `LogEvent.QueuePause` once and `LogEvent.QueueResume` when it is gone; when
 *   a batch did not end, drops its staging set, and takes a batch in place of one request when the front of the queue holds
 *   a full batch, its oldest submission waited long enough, or the operator asked for it (see `batchStep`, which may delete
 *   the `batch_now` key); while submissions wait for their batch, polls and runs no request; after a batch whose promotion
 *   failed, takes the requests of that batch 1 at a time before the next batch, and the status holds `lastBatchError`
 */
export async function runWorker(opts: RunWorkerOptions): Promise<void> {
  const log = opts.log ?? stderrLogger();
  const release = acquireLock(opts.dbPath, (pid) => log({ event: LogEvent.LockTakeover, level: LogLevel.Warn, pid }));
  process.on("exit", release);
  let store: Store | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  try {
    store = openStoreFor(opts.config, opts.dbPath);
    // technical/updates.md, "Queue and worker": a run that did not commit left no trace, so its row goes back to the queue.
    const reset = resetRunning(store);
    log({ event: LogEvent.WorkerStart, level: LogLevel.Info, db: opts.dbPath, resetRunning: reset });
    const open = store;
    let status: WorkerStatus = initialWorkerStatus(Date.now());
    writeWorkerStatus(open, status);
    // A request takes minutes: without this the status would read as a worker that stopped polling.
    heartbeat = setInterval(() => {
      status = { ...status, lastPollAt: Date.now() };
      writeWorkerStatus(open, status);
    }, opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
    heartbeat.unref();
    // The first embedding call loads the model.
    await embed(["warm up"]);
    // The wait of the last rate-limited call in a row; absent after a success.
    let rateLimitPauseMs: number | undefined;
    // True from the first loop that saw the operator pause until the first loop that sees none.
    let operatorPaused = false;
    // technical/updates.md, "High volume mode", rule 6: the steps left to run on the path of 1 request at a time, with no
    // staging and no batch, after a batch whose promotion failed. It makes the requests of that batch run before the next batch.
    let soloLeft = 0;
    // technical/updates.md, "Model call failures": a session limit is a wait. The worker takes no request until the pause ends.
    // The doubled wait stays the fallback; the reset time of the error text, when it parses, replaces it. Returns the wait
    // of this pause, which the next rate limit in a row doubles.
    const pauseForRateLimit = async (requestId: string, error: string): Promise<number> => {
      const next = nextRateLimitPauseMs(rateLimitPauseMs);
      const now = Date.now();
      const resetAt = rateLimitResetAt(error, now);
      const waitMs = resetAt === undefined ? next : resetAt + RATE_LIMIT_RESET_MARGIN_MS - now;
      status = pausedWorkerStatus(status, now, waitMs);
      writeWorkerStatus(open, status);
      log({ event: LogEvent.RateLimitPause, level: LogLevel.Warn, request_id: requestId, waitMs, error });
      await sleep(waitMs, opts.signal);
      status = resumedWorkerStatus(status);
      writeWorkerStatus(open, status);
      return next;
    };
    // technical/updates.md, "Queue and worker": a repair that failed an attempt in the cleanup step waits attempts * the base
    // delay, as after any failed attempt. The loop sleeps for the other requests; a repair must not stop the submissions, so
    // its wait is a time per id: the cleanup step and the normal take both pass over it until that time is past.
    const retryAt = new Map<string, number>();
    const markRetry = (id: string): void => {
      const attempts = getRequest(open, id)?.attempts ?? 1;
      retryAt.set(id, Date.now() + attempts * (opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS));
    };
    const waitingIds = (): Set<string> => {
      const now = Date.now();
      for (const [id, at] of retryAt) if (at <= now) retryAt.delete(id);
      return new Set(retryAt.keys());
    };
    // technical/cleanup.md, "When it runs": the cleanup step between 2 requests. It runs the queued repairs 1 at a time in queue
    // order, runs the trigger, and when the trigger ran a finder, runs the repairs that it queued and the trigger again. A stop,
    // a queue pause or a rate limit ends the step; the repairs left stay queued for the next step. A repair that fails an
    // attempt is queued again and the step goes on to the next one; a repair in its retry wait is passed over.
    const runRepairs = async (): Promise<boolean> => {
      for (const id of queuedRepairIds(open)) {
        if (opts.signal?.aborted || readQueuePause(open) !== undefined) return false;
        if (waitingIds().has(id)) continue;
        const r = await runRequest(open, id, { questions: opts.questions, config: opts.config, deps: { log } });
        if (r.status === RunOnceStatus.Idle) continue;
        status = nextWorkerStatus(status, r, Date.now());
        writeWorkerStatus(open, status);
        if (r.status === RunOnceStatus.Queued) markRetry(id);
        if (r.status === RunOnceStatus.RateLimited) {
          rateLimitPauseMs = await pauseForRateLimit(r.requestId, r.error);
          return false;
        }
        if (r.status === RunOnceStatus.Done && r.result.outcome !== ProcessOutcome.Skipped)
          rateLimitPauseMs = undefined;
      }
      return true;
    };
    // A failed finder must not stop the worker.
    const cleanupStep = async (): Promise<void> => {
      try {
        if (!(await runRepairs())) return;
        if (cleanupIfDue(open, log) === undefined) return;
        if (!(await runRepairs())) return;
        cleanupIfDue(open, log);
      } catch (e) {
        log({ event: LogEvent.Unhandled, level: LogLevel.Error, error: `cleanup: ${errorMessage(e)}` });
      }
    };
    while (!opts.signal?.aborted) {
      // technical/updates.md, "Queue and worker": the key is read between 2 requests; with it the worker starts no request, no cleanup and no job.
      const pause = readQueuePause(store);
      if (pause !== undefined) {
        if (!operatorPaused) {
          operatorPaused = true;
          log({ event: LogEvent.QueuePause, level: LogLevel.Info, note: pause.note });
        }
        status = operatorPausedWorkerStatus(status, Date.now(), pause.at);
        writeWorkerStatus(store, status);
        await sleep(opts.pollMs ?? DEFAULT_POLL_MS, opts.signal);
        continue;
      }
      if (operatorPaused) {
        operatorPaused = false;
        log({ event: LogEvent.QueueResume, level: LogLevel.Info });
      }
      if (status.pauseReason === PauseReason.Operator) {
        status = resumedWorkerStatus(status);
        writeWorkerStatus(store, status);
      }
      // technical/updates.md, "High volume mode", "The worker loop": 1 batch in place of 1 request when the front of the queue
      // holds a full batch, its oldest submission waited long enough, or the operator asked for it.
      const b =
        soloLeft > 0
          ? { ran: false as const, hold: false }
          : await batchStep({ store, questions: opts.questions, config: opts.config, log, signal: opts.signal });
      if (b.ran) {
        status = nextBatchWorkerStatus(status, b.result, Date.now());
        writeWorkerStatus(store, status);
        switch (b.result.status) {
          case BatchRunStatus.Stopped:
            // The pause or the stop signal came between 2 steps of the batch: the top of the loop handles it.
            continue;
          case BatchRunStatus.Done:
            // A batch made model calls and succeeded: the next rate limit starts at the first pause again.
            rateLimitPauseMs = undefined;
            await cleanupStep();
            // A request of the batch that failed an attempt is queued again: the loop waits one base delay, as after a failed request.
            if (b.result.failed > 0) await sleep(opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS, opts.signal);
            continue;
          case BatchRunStatus.Dropped:
            // The promotion failed and no request paid an attempt (the error is in the status and the log). The requests of the
            // batch run now, 1 at a time in queue order: there is no promotion on that path, so the queue does not back up.
            soloLeft = b.result.ids.length;
            await cleanupStep();
            continue;
          case BatchRunStatus.RateLimited:
            rateLimitPauseMs = await pauseForRateLimit(b.result.requestId, b.result.error);
            continue;
        }
      }
      if (b.hold) {
        // Submissions wait at the front for their batch: they never run 1 at a time. The poll only refreshes the status.
        status = { ...status, lastPollAt: Date.now() };
        writeWorkerStatus(store, status);
        await sleep(opts.pollMs ?? DEFAULT_POLL_MS, opts.signal);
        continue;
      }
      const r = await runOnce(store, opts.questions, opts.config, { log, skip: waitingIds() });
      status = nextWorkerStatus(status, r, Date.now());
      // The steps left of the 1-at-a-time run; its end clears the batch error of the status.
      ({ left: soloLeft, status } = afterSoloStep(soloLeft, status, r));
      writeWorkerStatus(store, status);
      if (r.status === RunOnceStatus.Idle) {
        await cleanupStep();
        await sleep(opts.pollMs ?? DEFAULT_POLL_MS, opts.signal);
      } else if (r.status === RunOnceStatus.Queued) {
        // After a failed attempt the loop waits attempts * base before it polls again.
        const attempts = getRequest(store, r.requestId)?.attempts ?? 1;
        await sleep(attempts * (opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS), opts.signal);
      } else if (r.status === RunOnceStatus.RateLimited) {
        rateLimitPauseMs = await pauseForRateLimit(r.requestId, r.error);
      } else if (r.status === RunOnceStatus.Done) {
        // A request that made a model call succeeded: the next rate limit starts at the first pause again.
        if (r.result.outcome !== ProcessOutcome.Skipped) rateLimitPauseMs = undefined;
        await cleanupStep();
      } else if (r.status === RunOnceStatus.Failed) {
        await cleanupStep();
      }
    }
    log({ event: LogEvent.WorkerStop, level: LogLevel.Info });
  } finally {
    clearInterval(heartbeat);
    if (store) closeStore(store);
    process.off("exit", release);
    release();
  }
}
