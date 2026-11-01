// What a path used and what each request ended as, read from the copy after (or during) the path.
import { costUsd, priceFor, type PriceTable } from "../../src/config/index.js";
import { ChangeOutcome, RequestStatus } from "../../src/domain/index.js";
import {
  getChangeForRequest,
  getRequest,
  listCurrentFacts,
  modelCallTotals,
  type Store,
} from "../../src/store/index.js";
import type { FactText, PathUsage, RequestRecord } from "./types.js";

/** The count key of a request that ended with no change. */
const NO_OUTCOME = "none";

/**
 * Sums the model calls of a copy from a time on, and prices them. Priced by `costUsd`, as `tokenCost` of the console.
 *
 * @param store - the open copy
 * @param sinceAt - the start of the path, in ms since the epoch
 * @param prices - the price table
 * @returns the calls, the 4 token counts, the dollars and the calls per question
 * @sideEffects none (reads `model_calls`)
 */
export function measureUsage(store: Store, sinceAt: number, prices: PriceTable): PathUsage {
  const usage: PathUsage = {
    calls: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    usd: 0,
    unpricedCalls: 0,
    callsByQuestion: {},
  };
  for (const row of modelCallTotals(store, sinceAt)) {
    const price = priceFor(prices, row.model);
    usage.calls += row.calls;
    usage.tokens.input += row.tokensIn;
    usage.tokens.output += row.tokensOut;
    usage.tokens.cacheRead += row.tokensCacheRead;
    usage.tokens.cacheWrite += row.tokensCacheWrite;
    usage.usd += costUsd(prices, row.model, {
      input: row.tokensIn,
      cacheWrite: row.tokensCacheWrite,
      cacheRead: row.tokensCacheRead,
      output: row.tokensOut,
    });
    if (!price.known) usage.unpricedCalls += row.calls;
    usage.callsByQuestion[row.question] = (usage.callsByQuestion[row.question] ?? 0) + row.calls;
  }
  return usage;
}

// The record of one request, without its children.
function recordOf(store: Store, id: string, live: Map<string, FactText>): RequestRecord | undefined {
  const row = getRequest(store, id);
  if (!row) return undefined;
  const change = getChangeForRequest(store, id);
  const facts: FactText[] = [];
  for (const factId of change?.factIds ?? []) {
    const f = live.get(factId);
    if (f) facts.push(f);
  }
  return {
    requestId: id,
    status: row.status,
    ...(change ? { outcome: change.outcome } : {}),
    ...(row.error ? { error: row.error } : {}),
    ...(change?.rejectReason ? { rejectReason: change.rejectReason } : {}),
    ...(change?.duplicateOf ? { duplicateOf: change.duplicateOf } : {}),
    attempts: row.attempts,
    factIds: change?.factIds ?? [],
    facts,
    children: [],
  };
}

/**
 * Reads what each sampled request ended as: its status, the outcome of its last change, the live facts it wrote and, for
 * a split, the same for each child.
 *
 * @param store - the open copy
 * @param ids - the sampled requests, in queue order
 * @returns one record per request that exists
 * @sideEffects none (reads)
 */
export function readRequests(store: Store, ids: string[]): RequestRecord[] {
  const live = new Map<string, FactText>();
  for (const f of listCurrentFacts(store)) {
    if (f.is_deleted === 0) live.set(f.fact_id, { header: f.header, content: f.content });
  }
  const out: RequestRecord[] = [];
  for (const id of ids) {
    const rec = recordOf(store, id, live);
    if (!rec) continue;
    const change = getChangeForRequest(store, id);
    for (const childId of change?.childIds ?? []) {
      const child = recordOf(store, childId, live);
      if (child) rec.children.push(child);
    }
    out.push(rec);
  }
  return out;
}

/**
 * Names what a request ended as, for comparison and counting: its outcome, or for a split the sorted outcomes of its children.
 *
 * @param r - the record
 * @returns for example `accepted`, `split[accepted,duplicate]`, or `none` when no change was written
 * @sideEffects none
 */
export function outcomeOf(r: RequestRecord): string {
  if (r.outcome === ChangeOutcome.Split) {
    return `${r.outcome}[${r.children
      .map((c) => c.outcome ?? NO_OUTCOME)
      .sort()
      .join(",")}]`;
  }
  return r.outcome ?? NO_OUTCOME;
}

/**
 * Counts the requests that no step can finish any more once the queue is idle: those still `running` or `queued`.
 *
 * @param records - the request records, children inside
 * @returns the count, children included
 * @sideEffects none
 */
export function countUnfinished(records: RequestRecord[]): number {
  let n = 0;
  for (const r of records) {
    if (r.status === RequestStatus.Running || r.status === RequestStatus.Queued) n++;
    n += countUnfinished(r.children);
  }
  return n;
}

/**
 * Counts the requests per final outcome (see `outcomeOf`).
 *
 * @param records - the request records
 * @returns the count per outcome name
 * @sideEffects none
 */
export function countOutcomes(records: RequestRecord[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const r of records) {
    const key = r.outcome === ChangeOutcome.Split ? ChangeOutcome.Split : (r.outcome ?? NO_OUTCOME);
    counts[key] = (counts[key] ?? 0) + 1;
    if (r.outcome === ChangeOutcome.Split) {
      for (const c of r.children) {
        const ck = `child ${c.outcome ?? NO_OUTCOME}`;
        counts[ck] = (counts[ck] ?? 0) + 1;
      }
    }
  }
  return counts;
}
