// technical/updates.md, "High volume mode", "Reconciliation": the duplicate fact repair of the cleanup on each new fact of a
// batch, run on the staging set.
import { LogEvent, LogLevel } from "../../domain/enums.js";
import type { Logger } from "../../log/index.js";
import { errorMessage, must } from "../../must.js";
import {
  DUPLICATE_FACT_NEIGHBORS,
  getBatchRequest,
  getFactMaterial,
  nearestAmong,
  olderFirst,
  stagedFacts,
  type ChangeRequestRow,
  type Store,
} from "../../store/index.js";
import { createContext, requestOf } from "../agent/context.js";
import type { PipelineConfig } from "../agent/types.js";
import { repairFacts } from "../cleanup-repair-fact.js";
import type { Questions } from "../types.js";
import { halted, isRateLimit, type Control } from "./control.js";

/** The options of `reconcileBatch`. */
export interface ReconcileOptions {
  /** The overlay store of the batch: the live wiki plus the staged changes. The repairs are written to the staging tables. */
  store: Store;
  questions: Questions;
  config: PipelineConfig;
  log: Logger;
  now: () => number;
  /** The stop state of the run; the reconciliation checks it before each pair. */
  control: Control;
  /**
   * The group of each request of the batch, by request id (a request that is in none is a group of its own). A staged fact
   * is checked only against the facts that another group staged: a pair inside 1 group gets no check, because the group call
   * saw both claims, and a pair with a fact from before the batch gets none, because the request read that fact at its own Q1.
   */
  groupOf: ReadonlyMap<string, number>;
}

/** What `reconcileBatch` did. */
export interface ReconcileResult {
  /** The pairs that the duplicate fact repair looked at. */
  pairs: number;
  /** The pairs that were merged (a merge change each). */
  merged: number;
  /** True when the reconciliation reached the end; false when a stop or a rate limit halted it. */
  complete: boolean;
  /** The request whose pair met the rate limit; absent when none did. */
  rateLimitedOn?: string;
  /** For each fact that a merge deleted, the fact that the merge kept (the fact itself may be deleted by a later merge). */
  mergedInto: Map<string, string>;
}

/** The options of `repairPair`. */
interface RepairPairOptions {
  store: Store;
  questions: Questions;
  config: PipelineConfig;
  log: Logger;
  now: () => number;
  /** The pair of fact ids, the older first. */
  pair: [string, string];
  /** The request that the change of a merge is written under. */
  row: ChangeRequestRow;
  /** Names the reconciliation in the log line of a failed pair. */
  label: string;
}

/** What `repairPair` did. */
interface RepairPairResult {
  /** The fact that stays and the fact that the merge deleted; absent when the pair was not merged. */
  merged?: { keptId: string; removedId: string };
  /** The error text of the rate limit that met the pair; absent when none did. */
  rateLimit?: string;
}

/**
 * Runs the duplicate fact repair on 1 pair of a reconciliation. A failure of the pair (a lint error, a failed call) is
 * logged and the pair counts as not merged; a rate limit is returned for the caller to stop on.
 *
 * @param opts - the store, the questions, the config, the logger, the clock, the pair, the request to write under and the log label
 * @returns the merge, or the rate limit; neither when the pair got a verdict or failed
 * @sideEffects as `repairFacts`: Q1 and Q2 calls, one change per merge with an embedder run; logs one `LogEvent.Unhandled` line when the pair fails
 */
async function repairPair(opts: RepairPairOptions): Promise<RepairPairResult> {
  const { pair, row } = opts;
  const ctx = createContext(opts.store, opts.questions, opts.config, {
    log: opts.log,
    now: opts.now,
    requestId: row.id,
  });
  try {
    const r = await repairFacts(ctx, requestOf(row), pair);
    return "merged" in r ? { merged: r.merged } : {};
  } catch (e) {
    if (isRateLimit(e)) return { rateLimit: errorMessage(e) };
    opts.log({
      event: LogEvent.Unhandled,
      level: LogLevel.Warn,
      error: `${opts.label} of ${pair[0]} and ${pair[1]}: ${errorMessage(e)}`,
    });
    return {};
  }
}

/**
 * Follows the merges of a reconciliation from a fact to the fact that stays live.
 *
 * @param mergedInto - the map of `ReconcileResult.mergedInto`
 * @param factId - a fact of the batch
 * @returns the fact itself when no merge deleted it; else the fact that the last merge on its path kept
 * @sideEffects none
 */
export function keptFact(mergedInto: Map<string, string>, factId: string): string {
  let id = factId;
  for (let next = mergedInto.get(id); next !== undefined; next = mergedInto.get(id)) id = next;
  return id;
}

/**
 * Reconciles the facts of a batch on its staging set: each live fact that the staging tables hold a version of (a new fact,
 * or a live fact that the batch edits) gets the duplicate fact repair (`repairFacts`: Q1 on the nearest facts, then the
 * merge with the guard of Q2) against its `DUPLICATE_FACT_NEIGHBORS` nearest facts among the facts that another group of
 * the batch staged (`opts.groupOf`). The store is the overlay store, and a merge is written to the staging tables. A pair
 * inside 1 group and a pair with a fact from before the batch get no check. The pair is ordered as the
 * cleanup orders it (the older fact first; a live fact is older than a new one, and new facts are ordered by the queue
 * time of their requests), and the change of a merge is written under the request that touched the newer fact of the pair
 * (the older, when only the older fact is touched). A pair with a fact that an earlier merge removed is stale and skipped.
 * A failure of one pair (a lint error, a failed call) is logged and the next pair runs; a rate limit halts the run.
 *
 * @param opts - the store, the questions, the config, the logger, the clock and the stop state
 * @returns the counts, whether the run reached the end, and the fact that each merged-away fact went into
 * @sideEffects reads the store; question calls (Q1, Q2 and the rest of the merge); one change per merge, with an embedder
 *   run; logs the change lines of the merges and one `LogEvent.Unhandled` line per failed pair; may set
 *   `opts.control.rateLimit`
 */
export async function reconcileBatch(opts: ReconcileOptions): Promise<ReconcileResult> {
  const { store, control } = opts;
  const staged = stagedFacts(store);
  const byFact = new Map(staged.map((c) => [c.factId, c]));
  const result: ReconcileResult = { pairs: 0, merged: 0, complete: false, mergedInto: new Map() };
  const judged = new Set<string>();
  // A request that is in no group is a group of its own.
  const groupKey = (requestId: string): string => String(opts.groupOf.get(requestId) ?? requestId);
  for (const { factId } of staged) {
    const own = getFactMaterial(store, factId);
    if (own === null || own.isDeleted) continue;
    const ownGroup = groupKey(byFact.get(factId)?.requestId ?? "");
    // The 3 nearest are taken among the facts that the other groups of the batch staged, not among all live facts.
    const neighbors = nearestAmong(
      store,
      factId,
      { k: DUPLICATE_FACT_NEIGHBORS, maxDistance: store.config.neighborDistance },
      (id) => {
        const other = byFact.get(id);
        return other !== undefined && groupKey(other.requestId) !== ownGroup;
      },
    );
    for (const n of neighbors) {
      if (halted(control)) return result;
      const pair = olderFirst(store, factId, n.factId);
      // Two staged facts that are each other's neighbor make 1 pair, judged 1 time.
      const key = pair.join(" ");
      if (judged.has(key)) continue;
      judged.add(key);
      // The pair holds the fact of this loop, which the batch touched, so one of the 2 has a request to write under.
      const newer = must(byFact.get(pair[1]) ?? byFact.get(pair[0]), `no fact of ${pair.join(" ")} is staged`);
      const row = must(getBatchRequest(store, newer.requestId), `request ${newer.requestId} not found`);
      result.pairs++;
      const r = await repairPair({ ...opts, pair, row, label: "batch reconciliation" });
      if (r.merged) {
        result.merged++;
        result.mergedInto.set(r.merged.removedId, r.merged.keptId);
      }
      if (r.rateLimit !== undefined) {
        control.rateLimit = r.rateLimit;
        result.rateLimitedOn = row.id;
        return result;
      }
    }
  }
  result.complete = true;
  return result;
}
