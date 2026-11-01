// technical/updates.md, "High volume mode", "The worker loop": when the worker takes a batch.
import { RequestKind } from "../../domain/enums.js";
import type { HighVolumeConfig } from "../../config/index.js";
import { clearBatchNow, countQueuedSubmissions, peekQueue, readBatchNow, type Store } from "../../store/index.js";

/** What the worker does at one poll. */
export interface BatchPlan {
  /** The requests of the batch, in queue order; empty: no batch starts now. */
  ids: string[];
  /** True when submissions stand at the front of the queue and wait for a batch: the worker must not run them 1 at a time. */
  hold: boolean;
}

/**
 * Decides whether the next step is a batch. The batch takes the submissions at the front of the queue, in queue order, up to
 * `batchSize`, and stops at the first row of another kind, which runs alone first. It starts when the front holds `batchSize`
 * submissions, or when the oldest of them was queued `waitMs` or more ago, or when the operator asked for it (the meta key
 * `batch_now`). The key is deleted when a batch starts, and when no submission is queued (it asks for no batch then).
 *
 * @param store - the open store
 * @param settings - the high volume settings of the config
 * @param now - the clock in ms
 * @returns the plan: the requests of the batch, or none; `hold` is true when submissions wait at the front for their batch
 * @sideEffects reads the queue and the `batch_now` key; deletes the key when a batch starts or no submission is queued
 */
export function planBatch(store: Store, settings: HighVolumeConfig, now: number): BatchPlan {
  const ask = readBatchNow(store) !== undefined;
  if (ask && countQueuedSubmissions(store) === 0) clearBatchNow(store);
  const ids: string[] = [];
  let oldest = Number.POSITIVE_INFINITY;
  for (const r of peekQueue(store, settings.batchSize)) {
    if (r.kind !== RequestKind.Submission) break;
    ids.push(r.id);
    oldest = Math.min(oldest, r.receivedAt);
  }
  if (ids.length === 0) return { ids, hold: false };
  const start = ask || ids.length >= settings.batchSize || now - oldest >= settings.waitMs;
  if (!start) return { ids: [], hold: true };
  if (ask) clearBatchNow(store);
  return { ids, hold: false };
}
