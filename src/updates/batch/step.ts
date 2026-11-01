// technical/updates.md, "High volume mode", "The worker loop": the batch step of the worker, in place of `runOnce`.
import type { Config } from "../../config/index.js";
import { BatchReconciliation, BatchStopReason, LogEvent, LogLevel } from "../../domain/enums.js";
import type { Logger } from "../../log/index.js";
import {
  clearBatchStartSeq,
  clearStaging,
  readBatchProgress,
  readBatchStartSeq,
  readQueuePause,
  writeBatchProgress,
  type Store,
} from "../../store/index.js";
import type { Questions } from "../types.js";
import { planBatch } from "./plan.js";
import { runBatch, type BatchRunResult } from "./run.js";

/** The options of `batchStep`. */
export interface BatchStepOptions {
  store: Store;
  questions: Questions;
  config: Config;
  log: Logger;
  /** The stop signal of the worker. */
  signal?: AbortSignal;
  /** The clock in ms. Default: `Date.now`. */
  now?: () => number;
}

/**
 * What the batch step did: no batch ran, or a batch ran and ended as `result` says. `hold` is true when no batch ran and the
 * queue holds submissions at its front that wait for their batch: the worker does not run them 1 at a time.
 */
export type BatchStepResult = { ran: false; hold: boolean } | { ran: true; result: BatchRunResult };

/**
 * The batch step of the worker: first drops the staging set that a crash left (the key of its start seq is in the store;
 * its requests run again), then takes a batch when `planBatch` says so (technical/updates.md, "High volume mode", "The worker
 * loop"). The queue pause and the stop signal are checked between 2 requests of the batch.
 *
 * @param opts - the store, the questions, the config, the logger, the stop signal and the clock
 * @returns `ran: false` when no batch ran (with `hold`); else the end of the batch (`Stopped` when the pause or the signal stopped it)
 * @sideEffects reads the queue, the `batch_now` key and the batch start seq key; may delete the staging rows and the key, set
 *   the progress to pending and log the drop; may delete the `batch_now` key; runs a batch (see `runBatch`); reads the clock
 */
export async function batchStep(opts: BatchStepOptions): Promise<BatchStepResult> {
  const { store, questions, config } = opts;
  const now = opts.now ?? Date.now;
  const probe = (): BatchStopReason | undefined => {
    if (opts.signal?.aborted) return BatchStopReason.Signal;
    return readQueuePause(store) === undefined ? undefined : BatchStopReason.QueuePause;
  };
  dropLeftStaging(store, opts.log);
  const plan = planBatch(store, config.highVolume, now());
  if (plan.ids.length === 0) return { ran: false, hold: plan.hold };
  const result = await runBatch({
    store,
    questions,
    config,
    settings: config.highVolume,
    log: opts.log,
    probe,
    now,
    ids: plan.ids,
  });
  return { ran: true, result };
}

// A crash leaves the key of the start seq and the rows of the staging tables. The staging set is dropped, never resumed: its requests were
// put back to the queue when the worker started, and the live wiki holds none of its changes.
function dropLeftStaging(store: Store, log: Logger): void {
  if (readBatchStartSeq(store) === undefined) return;
  clearStaging(store);
  clearBatchStartSeq(store);
  const progress = readBatchProgress(store);
  if (progress !== undefined) {
    writeBatchProgress(store, { ...progress, reconciliation: BatchReconciliation.Pending });
  }
  log({
    event: LogEvent.BatchDropped,
    level: LogLevel.Warn,
    reason: "a crash left the staging set of a batch",
    staged: progress?.staged ?? 0,
  });
}
