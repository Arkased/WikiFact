// technical/updates.md, "High volume mode": one batch. The requests run side by side against a staging set (the head of each
// request, the groups, one group call for each group), the reconciliation repairs the staging set, and 1 transaction promotes
// it to the live wiki.
import {
  BatchReconciliation,
  BatchRunStatus,
  LogEvent,
  LogLevel,
  RunOnceStatus,
  type BatchStopReason,
  type ProcessOutcome,
} from "../../domain/enums.js";
import type { HighVolumeConfig } from "../../config/index.js";
import type { Logger } from "../../log/index.js";
import { errorMessage } from "../../must.js";
import {
  StaleChangeError,
  clearBatchStartSeq,
  clearStaging,
  closeStore,
  countStagedChanges,
  finishRequest,
  highestChangeSeq,
  openOverlay,
  promoteStaging,
  releaseRequest,
  releaseStagedRequest,
  resetStaging,
  writeBatchProgress,
  writeBatchStartSeq,
  type BatchProgress,
  type ChangeRequestRow,
  type PriorQueryCheck,
  type PromotedRequest,
  type Store,
} from "../../store/index.js";
import { processRequest } from "../agent/index.js";
import type { AgentDeps, PipelineConfig, ProcessResult } from "../agent/types.js";
import { settleFailure } from "../settle-failure.js";
import type { Questions } from "../types.js";
import { createControl, halted, isRateLimit, type Control } from "./control.js";
import { keptFact, reconcileBatch, type ReconcileResult } from "./reconcile.js";
import { runRound, type RoundEnv, type Settled } from "./round.js";

/** The result of `runBatch`. */
export type BatchRunResult =
  | {
      status: BatchRunStatus.Done;
      /** The requests that the batch took. */
      size: number;
      /** The requests that ended, by outcome. */
      outcomes: Partial<Record<ProcessOutcome, number>>;
      /** The requests that failed an attempt (queued again or failed). */
      failed: number;
      /** The error text of the last failed request; absent when none failed. */
      error?: string;
      /** The requests that waited for the promotion and ran again alone: a refused write, or a scope of 2 or more live facts. */
      stale: number;
      /** The merges that the reconciliation wrote to the staging set. */
      merged: number;
      /** The changes that the promotion wrote to the live wiki. */
      promoted: number;
    }
  | { status: BatchRunStatus.Stopped; reason: BatchStopReason }
  | {
      /** The promotion failed: the staging set is dropped and the live wiki is unchanged (technical/updates.md, "High volume mode", rule 6). */
      status: BatchRunStatus.Dropped;
      error: string;
      /** The requests that went back to the queue with no attempt counted, in queue order; the worker runs them 1 at a time. */
      ids: string[];
    }
  | { status: BatchRunStatus.RateLimited; requestId: string; error: string };

/** The options of `runBatch`. */
export interface RunBatchOptions {
  store: Store;
  questions: Questions;
  config: PipelineConfig;
  settings: HighVolumeConfig;
  log: Logger;
  /** The check between 2 requests: a reason to stop, or undefined. */
  probe: () => BatchStopReason | undefined;
  /** The clock in ms. Default: `Date.now`. */
  now?: () => number;
  /** The requests of the batch, in queue order. */
  ids: string[];
}

/**
 * Runs one batch (technical/updates.md, "High volume mode"). The staging tables are emptied first and the overlay store is
 * opened. The run has 2 rounds, the requests of the batch and then the children of their splits; in each round, up to
 * `settings.concurrency` at once: the head of each request (Q7, the gather and Q1, on the live wiki), the grouping, 1 group
 * call for each group with the writes of its answers in queue order (the stale check on each write), and the pipeline of 1
 * request at a time for the members of a group whose call failed. A request whose scope holds 2 or more live facts and a
 * request whose write was refused wait. The reconciliation then runs the duplicate fact repair on the overlay store (the
 * live wiki plus the staged set) against the facts of the other groups. When it ends, 1 transaction promotes the staging
 * tables to the live wiki, marks the requests done and queues the prior query checks that the requests skipped (step 9), each
 * as a lookupRepair request on the fact that the reconciliation kept. Then each waiting request runs again alone, on the live
 * wiki, in queue order. The seq at the start is kept in the meta table while the staging rows exist, and the progress (the
 * counts, the staged changes and the state) is kept there for the Operation page. The queue pause and the stop signal are
 * checked before each request, each group and each pair; a request that has started ends. A stop, a rate limit, a failed
 * reconciliation or a failed promotion (a live wiki that moved) drops the staging set: the requests go back to the queue and
 * the live wiki is unchanged. The staging rows and the start seq key are deleted by the promotion, before the reruns.
 *
 * @param opts - the store, the questions, the settings, the logger, the probe and the requests of the batch
 * @returns how the run ended; `Dropped` when the promotion failed (the requests are queued again with no attempt counted,
 *   and the result names them so that the worker runs them 1 at a time)
 * @throws {Error} on a fault outside the promotion; the staging set is dropped and the requests released first
 * @sideEffects empties the staging tables and opens a second connection; takes the requests (`running`); writes the changes of
 *   the requests and of the merges to the staging tables; model calls; embedder runs; writes and deletes the batch start seq key; writes the
 *   progress key; sets staged child requests to `running` or back to `queued` in the staging tables; one transaction that
 *   writes the promoted changes, finishes the requests and inserts a queued lookupRepair row for each prior query check (so a
 *   stop, a crash or a kill after the promotion loses none); settles the failed requests and runs the waiting ones on the live
 *   wiki; logs change, stale, dropped, attempt failed and batch lines; reads the clock
 */
export async function runBatch(opts: RunBatchOptions): Promise<BatchRunResult> {
  const { store, ids, questions, config } = opts;
  const now = opts.now ?? Date.now;
  const startedAt = now();
  // The staging set: empty staging tables in the live database, and the overlay store that writes to them. The head of a
  // request runs on `target`, which reads the live wiki and writes through the overlay store; the writes of a group run on
  // the overlay store, which also shows the staged facts of the earlier claims.
  resetStaging(store);
  const staging = openOverlay(store);
  const target: Store = { ...store, stageTo: staging };
  const startSeq = highestChangeSeq(store);
  writeBatchStartSeq(store, startSeq);
  const control = createControl(opts.probe);
  const outcomes: Partial<Record<ProcessOutcome, number>> = {};
  // The requests that ran to their end on the staging set; the promotion marks them done.
  const finished: PromotedRequest[] = [];
  // The requests that wait for the promotion: a refused write, or a scope of 2 or more live facts.
  const waiting: ChangeRequestRow[] = [];
  // The place of each request in the queue order of the batch: the requests first, then the children (in the order of their parents).
  const queueRank = new Map(ids.map((id, i) => [id, i]));
  // The children that the batch took from the staging tables: the queue of the live wiki does not hold them until the promotion.
  const stagedIds = new Set<string>();
  // The children that each finished request staged, by the id of the parent.
  const childrenOf = new Map<string, string[]>();
  // The requests taken from the live queue and not settled: a drop puts them back.
  const inFlight = new Set<string>();
  // The group of each request, over both rounds.
  const groupOf = new Map<string, number>();
  // The requests that skipped step 9, with the search that they ran before and the fact that it should find.
  const priorChecks: PriorQueryCheck[] = [];
  const progress: BatchProgress = {
    taken: 0,
    done: 0,
    staged: 0,
    stale: 0,
    reconciliation: BatchReconciliation.Pending,
  };
  let stagingDropped = false;
  const save = (): void => {
    // The staging set is gone after the promotion; its last count stays.
    if (!stagingDropped) progress.staged = countStagedChanges(store);
    writeBatchProgress(store, progress);
  };
  save();
  let failed = 0;
  let error: string | undefined;
  let rateLimited: { requestId: string; error: string } | undefined;
  let promoted = false;
  const deps = { log: opts.log, now };

  // The result of a request that has run to its end: counted by outcome, or by failure. A request that ran on the staging
  // set stays `running` until the promotion.
  const settle = (r: Settled): void => {
    save();
    switch (r.status) {
      case RunOnceStatus.Done:
        outcomes[r.result.outcome] = (outcomes[r.result.outcome] ?? 0) + 1;
        return;
      case RunOnceStatus.RateLimited:
        rateLimited ??= { requestId: r.requestId, error: r.error };
        control.rateLimit ??= r.error;
        return;
      case RunOnceStatus.Queued:
      case RunOnceStatus.Failed:
        failed++;
        error = r.error;
        return;
    }
  };
  // A request that ran to its end on the staging set: the promotion marks it done, and its prior query check is queued.
  const complete = (row: ChangeRequestRow, result: ProcessResult): void => {
    finished.push({ id: row.id, error: result.error });
    if (result.childIds !== undefined) childrenOf.set(row.id, result.childIds);
    if (result.relevantFactId !== undefined && row.searchId !== null) {
      priorChecks.push({ searchId: row.searchId, factId: result.relevantFactId });
    }
    settle({ status: RunOnceStatus.Done, requestId: row.id, result });
  };
  // A request that waits for the promotion and runs again alone after it.
  const wait = (row: ChangeRequestRow, factIds?: string[]): void => {
    waiting.push(row);
    progress.stale++;
    save();
    if (factIds !== undefined) {
      opts.log({ event: LogEvent.BatchStale, level: LogLevel.Info, request_id: row.id, facts: factIds });
    }
  };
  // The failure of a request. It is settled on the live wiki: the queue row is the live wiki's. A child that is still in the
  // staging tables only goes back to `queued` there, with no attempt counted, and the promotion queues it for a later run alone.
  const fail = (row: ChangeRequestRow, e: unknown): Settled => {
    inFlight.delete(row.id);
    if (stagedIds.has(row.id) && !promoted) {
      const message = errorMessage(e);
      releaseStagedRequest(store, row.id, message);
      return {
        status: isRateLimit(e) ? RunOnceStatus.RateLimited : RunOnceStatus.Queued,
        requestId: row.id,
        error: message,
      };
    }
    return { ...settleFailure(store, opts.log, row, e), requestId: row.id };
  };
  // Runs a taken request through the whole pipeline on `on`, from the gather (Q7 has let it through at its head).
  const runOne = async (
    row: ChangeRequestRow,
    on: Store,
    extra: AgentDeps,
  ): Promise<Settled | { stale: StaleChangeError }> => {
    try {
      const result = await processRequest({
        store: on,
        questions,
        config,
        row,
        deps: { ...deps, claimChecked: true, ...extra },
      });
      return { status: RunOnceStatus.Done, requestId: row.id, result };
    } catch (e) {
      if (e instanceof StaleChangeError && extra.staleCheck === true) return { stale: e };
      return fail(row, e);
    }
  };
  // Closes the overlay store, empties the staging tables and deletes the start seq key, once; the batch needs none of them
  // after the promotion (which has emptied the tables and deleted the key already).
  const dropBatchStaging = (): void => {
    if (stagingDropped) return;
    stagingDropped = true;
    closeStore(staging);
    clearStaging(store);
    clearBatchStartSeq(store);
  };
  // Drops the staging set unpromoted: the requests that ran on it go back to the queue with no attempt counted. A fault of
  // the batch is not a fault of the requests. Returns the released requests in queue order.
  const abandon = (reason: string, level = LogLevel.Warn): string[] => {
    if (promoted) return [];
    const released = new Set<string>();
    // A staged child goes with the staging set (it is never in `inFlight`); its parent is released and splits again.
    for (const id of inFlight) {
      releaseRequest(store, id, reason);
      released.add(id);
    }
    inFlight.clear();
    opts.log({ event: LogEvent.BatchDropped, level, reason, staged: progress.staged });
    finished.length = 0;
    waiting.length = 0;
    return ids.filter((id) => released.has(id));
  };

  const round: RoundEnv = {
    store,
    target,
    staging,
    questions,
    config,
    concurrency: opts.settings.concurrency,
    groupCut: opts.settings.groupCut,
    control,
    log: opts.log,
    now,
    ids,
    queueRank,
    groupOf,
    stagedIds,
    inFlight,
    progress,
    save,
    complete,
    wait,
    settle,
    fail,
    runOne,
    rateLimit: (requestId, message) => {
      rateLimited ??= { requestId, error: message };
      control.rateLimit ??= message;
    },
  };

  try {
    await runRound(round, ids, false);
    if (!halted(control)) {
      // One more round: a child is never split again, so the children of the first round are all there is.
      const children = ids.flatMap((id) => childrenOf.get(id) ?? []);
      for (const [i, id] of children.entries()) queueRank.set(id, ids.length + i);
      await runRound(round, children, true);
    }

    const early = haltedResult(control, rateLimited);
    if (early !== undefined) {
      abandon("the batch stopped before its promotion");
      return early;
    }

    progress.reconciliation = BatchReconciliation.Running;
    save();
    const rec = await reconcileBatch({
      store: staging,
      questions,
      config,
      log: opts.log,
      now,
      control,
      groupOf,
    });
    save();
    const halt = rec.complete ? undefined : haltedResult(control, rateLimited, rec);
    if (halt !== undefined) {
      progress.reconciliation = BatchReconciliation.Pending;
      save();
      abandon("the reconciliation did not end");
      return halt;
    }

    progress.reconciliation = BatchReconciliation.Promoting;
    save();
    let count: number;
    try {
      // A merge of the reconciliation may have deleted the fact that a request wrote: its check follows the fact that stays.
      const checks = priorChecks.map((c) => ({ ...c, factId: keptFact(rec.mergedInto, c.factId) }));
      count = promoteStaging(store, { startSeq, done: finished, priorChecks: checks, now: now() });
    } catch (e) {
      // The transaction rolled back, so the live wiki is unchanged. No request is charged an attempt: the fault is not theirs.
      // The worker runs them 1 at a time, which has no promotion, so no loop of failing batches is possible.
      const message = `the promotion failed: ${errorMessage(e)}`;
      progress.reconciliation = BatchReconciliation.Pending;
      save();
      return { status: BatchRunStatus.Dropped, error: message, ids: abandon(message, LogLevel.Error) };
    }
    promoted = true;
    // The batch is on the live wiki: a crash from here on must not find a staging set to drop.
    dropBatchStaging();
    progress.done = finished.length;
    progress.reconciliation = BatchReconciliation.Done;
    save();

    // The second run of a waiting request: alone, on the live wiki that now holds the batch, in queue order, from the gather
    // on (Q7 let it through), with no stale check, because nothing runs next to it; the change of each is seen by the next.
    waiting.sort((a, b) => (queueRank.get(a.id) ?? ids.length) - (queueRank.get(b.id) ?? ids.length));
    for (const row of waiting) {
      if (halted(control)) {
        releaseRequest(
          store,
          row.id,
          "the request waited for the promotion and the batch stopped before its second run",
        );
        continue;
      }
      const r = await runOne(row, store, {});
      if ("stale" in r) continue;
      if (r.status === RunOnceStatus.Done) {
        finishRequest(store, r.requestId, now(), r.result.error);
        progress.done++;
        inFlight.delete(row.id);
      }
      settle(r);
    }
    if (rateLimited !== undefined) return { status: BatchRunStatus.RateLimited, ...rateLimited };
    if (control.stop !== undefined) return { status: BatchRunStatus.Stopped, reason: control.stop };

    const size = progress.taken;
    opts.log({
      event: LogEvent.BatchDone,
      level: LogLevel.Info,
      size,
      outcomes,
      failed,
      stale: waiting.length,
      merged: rec.merged,
      promoted: count,
      ms: now() - startedAt,
    });
    return {
      status: BatchRunStatus.Done,
      size,
      outcomes,
      failed,
      ...(error === undefined ? {} : { error }),
      stale: waiting.length,
      merged: rec.merged,
      promoted: count,
    };
  } catch (e) {
    abandon(`the batch failed: ${errorMessage(e)}`);
    throw e;
  } finally {
    dropBatchStaging();
  }
}

// The result of a run that was halted by a rate limit or a stop; undefined when nothing halted it.
function haltedResult(
  c: Control,
  rateLimited: { requestId: string; error: string } | undefined,
  rec?: ReconcileResult,
): BatchRunResult | undefined {
  if (rateLimited !== undefined) return { status: BatchRunStatus.RateLimited, ...rateLimited };
  if (c.rateLimit !== undefined) {
    return { status: BatchRunStatus.RateLimited, requestId: rec?.rateLimitedOn ?? "", error: c.rateLimit };
  }
  return c.stop === undefined ? undefined : { status: BatchRunStatus.Stopped, reason: c.stop };
}
