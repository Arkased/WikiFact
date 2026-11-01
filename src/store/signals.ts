// The reads behind the signals of the console (technical/console.md, "Store API reads for the signals"). Each reads and writes
// nothing else; the page handler computes the ratios from the counts.
import { ChangeOutcome, RequestKind, RetrievalKind, SearchHitKind, Span, assertNever } from "../domain/enums.js";
import { costUsd, priceFor, type PriceTable } from "../config/prices.js";
import type { Store } from "./types/index.js";
import { NICE_STEP_BASE, NICE_STEP_MULTIPLES } from "../constants.js";

/** The bounds of a span: the count of searches in it and its time range. */
export interface SpanBounds {
  /** The count of searches in the span; 0 when the wiki has no search. */
  searches: number;
  /** The time of the oldest search of a `Recent` span, in ms since the epoch; null for `All` and for a wiki with no search (no bound). */
  fromAt: number | null;
  /** The time of the newest search of a `Recent` span, in ms since the epoch; null as `fromAt`. */
  toAt: number | null;
}

/**
 * The most stretches of the growth series (design/console.md, "Wiki growth"). A longer span is cut into stretches of a
 * round size, so the charts and the page stay small however long the log grows.
 */
export const GROWTH_STRETCHES = 50;

/** One stretch of the growth charts: a run of searches, with the rates of that run alone. */
export interface GrowthStretch {
  /** The count of searches of the wiki so far at the last search of the stretch (counted from 1 in time order); the x value. */
  searches: number;
  /** The count of searches in the stretch; the first and the last stretch of a span can hold fewer than the others. */
  count: number;
  /** The change requests received from the first search of the stretch to the first search of the next one, that wrote a first fact version. */
  additions: number;
  /** The change requests received in the same time, that wrote a later version or a deletion. */
  corrections: number;
  /** `additions` divided by `count`. */
  additionsPerSearch: number;
  /** `corrections` divided by `count`. */
  correctionsPerSearch: number;
  /** The facts that are live at the time of the last search of the stretch. */
  liveFacts: number;
  /** The facts that are live just before the first search of the stretch. */
  liveBefore: number;
}

/** The result of `readsPerSearch`. */
export interface ReadsPerSearch {
  /** The searches in the bounds. */
  searches: number;
  /** The searches in the bounds that returned no result (`result_count` 0). They are in no count: they have no result to read. */
  noResult: number;
  /** The searches in the bounds with results and no `search_results` row: they ran before the minted ids, so no read can link to them. They are in no count. */
  unminted: number;
  /** The searches with results and a `search_results` row, with 0, 1, 2, and 3 or more reads, in this order. */
  counts: [number, number, number, number];
  /** The reads in the bounds that link to no search. They are in no count. */
  unlinkedReads: number;
}

/** The result of `searchMisses`. */
export interface SearchMisses {
  /** The change requests that came after a search. */
  afterSearch: number;
  /** The part of `afterSearch` whose target fact the search did not list. */
  missed: number;
}

/** The result of `tokenCost`. */
export interface TokenCost {
  /** The change requests that wrote at least 1 fact version. */
  writes: number;
  /** The cost in USD of the model calls of the change requests and the splits of the bounds, by the price table. */
  usd: number;
  /** The part of `usd` on change requests that wrote no fact version, and on splits whose children wrote none. */
  wastedUsd: number;
  /** The sum of the input, output and cache tokens of the same model calls. */
  tokens: number;
  /** The part of `tokens` on change requests that wrote no fact version. */
  wastedTokens: number;
  /** The model calls whose model has no price in the table; they count at $0. */
  unpricedCalls: number;
}

// The outcome of a request is the outcome of its last `changes` row (a merge writes one before the request's own).
const LAST_OUTCOME = "(SELECT c.outcome FROM changes c WHERE c.request_id = r.id ORDER BY c.seq DESC LIMIT 1)";

// A change request: a submission, except a split. The children of a split are rows of their own and count in its place.
const IS_CHANGE_REQUEST = `r.kind = '${RequestKind.Submission}' AND COALESCE(${LAST_OUTCOME}, '') <> '${ChangeOutcome.Split}'`;

// A submission, split or not. A batch records the model calls of its staged children under the split parent, so the
// cost of a split is its own rows; a split wrote when 1 of its children did.
const IS_SUBMISSION = `r.kind = '${RequestKind.Submission}'`;
const WROTE_FACT_VERSION = `EXISTS (SELECT 1 FROM change_requests k JOIN changes c ON c.request_id = k.id JOIN fact_versions fv ON fv.seq = c.seq
         WHERE k.id = r.id OR k.parent_id = r.id)`;

// The condition `column` within the bounds; no condition for a span without a bound.
function within(column: string, bounds: SpanBounds): { sql: string; args: number[] } {
  if (bounds.fromAt === null || bounds.toAt === null) return { sql: "1", args: [] };
  return { sql: `${column} >= ? AND ${column} <= ?`, args: [bounds.fromAt, bounds.toAt] };
}

/**
 * Finds the bounds of a span of the signals.
 *
 * @param store - the open store
 * @param span - `Recent` for the newest `recentSearches` searches, `All` for every search
 * @param recentSearches - the size of the recent span, in searches (the caller passes `SPAN_RECENT_SEARCHES`)
 * @returns the count of searches and the time range; the range is null for `All`
 * @sideEffects none (reads `searches`)
 */
export function spanBounds(store: Store, span: Span, recentSearches: number): SpanBounds {
  const count = (store.db.prepare("SELECT COUNT(*) AS n FROM searches").get() as { n: number }).n;
  switch (span) {
    case Span.All:
      return { searches: count, fromAt: null, toAt: null };
    case Span.Recent: {
      const row = store.db
        .prepare(
          `SELECT COUNT(*) AS n, MIN(at) AS fromAt, MAX(at) AS toAt
           FROM (SELECT at FROM searches ORDER BY id DESC LIMIT ?)`,
        )
        .get(recentSearches) as { n: number; fromAt: number | null; toAt: number | null };
      return { searches: row.n, fromAt: row.fromAt, toAt: row.toAt };
    }
  }
  return assertNever(span);
}

/**
 * Cuts the searches of a span into stretches and gives the live facts and the change per search of each.
 *
 * @param store - the open store
 * @param bounds - the span, from `spanBounds`; it selects the searches by their time (`fromAt` to `toAt`, no bound for `All`)
 * @returns the stretches, oldest first; an empty array when the bounds hold no search. The searches of the bounds, in time
 *   order, are cut into stretches of `size` searches, `size` the smallest of 1, 2, 5, 10, 20, 50, ... that gives at most
 *   `GROWTH_STRETCHES` stretches. A stretch ends at a multiple of `size` in the searches of the wiki so far, so the first
 *   stretch of a span and the last may be shorter. `additions` and `corrections` count the change requests received from
 *   the first search of the stretch to the first search of the next (no end for the last stretch), and the 2 `PerSearch` values
 *   divide them by the searches of the stretch alone. A change request is an addition when its `changes` rows wrote at least 1
 *   fact version that is the first of its fact, and a correction when they wrote a later version of a fact or a deletion; one
 *   that does both counts once in each, one that wrote nothing (rejected, duplicate, split) in neither. A request received
 *   before the first search of the bounds counts nowhere; a split request is not counted, its children are. `liveFacts` counts
 *   the facts whose newest version with `created_at` at or before the `at` of the last search of the stretch is not a deletion.
 *   `liveBefore` is the same count at the times before the first search of the stretch (`at` less than that search's), so the
 *   `liveFacts` of the last stretch minus the `liveBefore` of the first is the change of the live facts over the span.
 * @sideEffects none (reads `searches`, `change_requests`, `changes`, `fact_versions`)
 */
export function growthSeries(store: Store, bounds: SpanBounds): GrowthStretch[] {
  const range = within("at", bounds);
  const times = (
    store.db.prepare(`SELECT at FROM searches WHERE ${range.sql} ORDER BY at, id`).all(...range.args) as {
      at: number;
    }[]
  ).map((r) => r.at);
  const first = times[0];
  if (first === undefined) return [];
  // The searches of the wiki before the span: the x axis counts the searches of the wiki.
  const before =
    bounds.fromAt === null
      ? 0
      : (store.db.prepare("SELECT COUNT(*) AS n FROM searches WHERE at < ?").get(bounds.fromAt) as { n: number }).n;
  // A version is the first of its fact when no version of the fact has a lower seq.
  const wrote = (condition: string): string =>
    `EXISTS (SELECT 1 FROM changes c JOIN fact_versions fv ON fv.seq = c.seq WHERE c.request_id = r.id AND ${condition})`;
  const earlier = "EXISTS (SELECT 1 FROM fact_versions p WHERE p.fact_id = fv.fact_id AND p.seq < fv.seq)";
  const received = (
    store.db
      .prepare(
        `SELECT r.received_at AS at,
                ${wrote(`NOT ${earlier}`)} AS added,
                ${wrote(`(fv.is_deleted = 1 OR ${earlier})`)} AS corrected
         FROM change_requests r WHERE ${IS_CHANGE_REQUEST} ORDER BY r.received_at`,
      )
      .all() as { at: number; added: number; corrected: number }[]
  ).filter((r) => r.at >= first);
  const versions = store.db
    .prepare(
      "SELECT fact_id AS factId, is_deleted AS deleted, created_at AS at FROM fact_versions ORDER BY created_at, seq",
    )
    .all() as { factId: string; deleted: number; at: number }[];
  const size = stretchSize(before, times.length);
  const stretches: GrowthStretch[] = [];
  const isLive = new Map<string, boolean>();
  let live = 0;
  let versionIndex = 0;
  let receivedIndex = 0;
  // The versions come in time order, so the newest version of a fact up to a time is the last one applied.
  const applyUpTo = (limit: number, inclusive: boolean): void => {
    for (
      let v = versions[versionIndex];
      v !== undefined && (inclusive ? v.at <= limit : v.at < limit);
      v = versions[versionIndex]
    ) {
      const now = v.deleted === 0;
      live += Number(now) - Number(isLive.get(v.factId) === true);
      isLive.set(v.factId, now);
      versionIndex++;
    }
  };
  // A stretch ends at a multiple of `size` in the searches of the wiki, so the x labels at round counts fall on stretch ends;
  // the first stretch of a span may be shorter, as the last one may.
  for (let start = 0; start < times.length;) {
    const end = Math.min((Math.floor((before + start) / size) + 1) * size - before, times.length);
    const lastAt = times[end - 1] ?? first;
    const nextAt = times[end];
    applyUpTo(times[start] ?? first, false);
    const liveBefore = live;
    applyUpTo(lastAt, true);
    let additions = 0;
    let corrections = 0;
    for (
      let r = received[receivedIndex];
      r !== undefined && (nextAt === undefined || r.at < nextAt);
      r = received[receivedIndex]
    ) {
      additions += r.added;
      corrections += r.corrected;
      receivedIndex++;
    }
    const count = end - start;
    stretches.push({
      searches: before + end,
      count,
      additions,
      corrections,
      additionsPerSearch: additions / count,
      correctionsPerSearch: corrections / count,
      liveFacts: live,
      liveBefore,
    });
    start = end;
  }
  return stretches;
}

/** The last bucket of the reads per search: a search with this many reads or more counts here. */
const MAX_READ_BUCKET = 3;

// The size of a stretch: the smallest of 1, 2, 5, 10, 20, 50, ... under which `count` searches, after `before` searches of
// the wiki, leave at most `GROWTH_STRETCHES` stretches that end at multiples of the size.
function stretchSize(before: number, count: number): number {
  for (let power = 1; ; power *= NICE_STEP_BASE)
    for (const mult of NICE_STEP_MULTIPLES) {
      const size = mult * power;
      if (Math.ceil((before + count) / size) - Math.floor(before / size) <= GROWTH_STRETCHES) return size;
    }
}

/**
 * Counts the reads of each search of the bounds, as a distribution.
 *
 * @param store - the open store
 * @param bounds - the span, from `spanBounds`; it selects the searches by their time, and the reads by `fromAt` alone
 *   (a read comes after its search, so the reads of the newest search lie after `toAt`)
 * @returns the searches of the bounds, `noResult` (those with `result_count` 0; they are left out of the counts), `unminted` (those with results and no
 *   `search_results` row; also left out of the counts), how many of
 *   the others have 0, 1, 2 and 3 or more reads, and the reads since `fromAt` with no search. A read links to the search that minted its `ref` (technical/lookup.md, "The link of a read to its search"); a read with a NULL
 *   `ref` is unlinked. Only reads of kind `read` count.
 * @sideEffects none (reads `searches`, `search_results`, `retrievals`)
 */
export function readsPerSearch(store: Store, bounds: SpanBounds): ReadsPerSearch {
  const searchRange = within("at", bounds);
  const rows = store.db
    .prepare(
      `SELECT id, result_count, EXISTS (SELECT 1 FROM search_results sr WHERE sr.search_id = searches.id) AS minted
       FROM searches WHERE ${searchRange.sql}`,
    )
    .all(...searchRange.args) as { id: string; result_count: number; minted: number }[];
  const withResults = rows.filter((r) => r.result_count > 0);
  const linkable = withResults.filter((r) => r.minted === 1);
  const reads = new Map<string, number>(linkable.map((r) => [r.id, 0]));
  let unlinked = 0;
  // A read comes after its search, so the reads of the newest search lie after `toAt`: only the lower bound applies.
  const readRange =
    bounds.fromAt === null ? { sql: "1", args: [] as number[] } : { sql: "r.at >= ?", args: [bounds.fromAt] };
  const readRows = store.db
    .prepare(
      `SELECT sr.search_id AS search_id FROM retrievals r LEFT JOIN search_results sr ON sr.ref = r.ref
       WHERE r.kind = '${RetrievalKind.Read}' AND ${readRange.sql}`,
    )
    .all(...readRange.args) as { search_id: string | null }[];
  for (const row of readRows) {
    if (row.search_id === null) unlinked++;
    else if (reads.has(row.search_id)) reads.set(row.search_id, (reads.get(row.search_id) ?? 0) + 1);
  }
  const counts: [number, number, number, number] = [0, 0, 0, 0];
  for (const n of reads.values()) counts[Math.min(n, MAX_READ_BUCKET)]++;
  return {
    searches: rows.length,
    noResult: rows.length - withResults.length,
    unminted: withResults.length - linkable.length,
    counts,
    unlinkedReads: unlinked,
  };
}

/**
 * Counts the change requests that came after a search, and those whose target fact the search did not list.
 *
 * @param store - the open store
 * @param bounds - the span, from `spanBounds`; only `fromAt` applies, to `received_at` of the request (a request comes
 *   after its search, so the requests of the newest search lie after `toAt`)
 * @returns `afterSearch`: the change requests that name a search (`change_requests.search_id`; a request with a NULL
 *   `search_id` is not counted); `missed`:
 *   the part of them with a target fact that this search did not list. The target is `duplicate_of` of a duplicate
 *   outcome, or the fact of each later version or deletion the request wrote. A request that wrote only first
 *   versions has no target and is not a miss. A correction or a duplicate of a listed fact is the loop at work and
 *   does not count. A split request is not a change request; its children are.
 * @sideEffects none (reads `change_requests`, `changes`, `fact_versions`, `searches`, `search_results`)
 */
export function searchMisses(store: Store, bounds: SpanBounds): SearchMisses {
  const range =
    bounds.fromAt === null ? { sql: "1", args: [] as number[] } : { sql: "r.received_at >= ?", args: [bounds.fromAt] };
  // The search that the request names; a NULL `search_id` names none.
  const namedSearch = "r.search_id";
  const row = store.db
    .prepare(
      `SELECT COUNT(*) AS afterSearch, COALESCE(SUM(duplicate_miss OR correction_miss), 0) AS missed FROM (
         SELECT ${LAST_OUTCOME} = '${ChangeOutcome.Duplicate}'
                  AND (SELECT c.duplicate_of FROM changes c WHERE c.request_id = r.id ORDER BY c.seq DESC LIMIT 1) IS NOT NULL
                  AND NOT EXISTS (
                    SELECT 1 FROM search_results sr
                    WHERE sr.search_id = ${namedSearch} AND sr.kind = '${SearchHitKind.Fact}'
                      AND sr.target_id = (SELECT c.duplicate_of FROM changes c WHERE c.request_id = r.id ORDER BY c.seq DESC LIMIT 1)
                  ) AS duplicate_miss,
                EXISTS (
                  SELECT 1 FROM changes c
                  JOIN fact_versions fv ON fv.seq = c.seq
                  WHERE c.request_id = r.id
                    AND (fv.is_deleted = 1
                         OR EXISTS (SELECT 1 FROM fact_versions p WHERE p.fact_id = fv.fact_id AND p.seq < fv.seq))
                    AND NOT EXISTS (
                      SELECT 1 FROM search_results sr
                      WHERE sr.search_id = ${namedSearch} AND sr.kind = '${SearchHitKind.Fact}' AND sr.target_id = fv.fact_id
                    )
                ) AS correction_miss
         FROM change_requests r
         WHERE ${IS_CHANGE_REQUEST} AND ${range.sql} AND ${namedSearch} IS NOT NULL
       )`,
    )
    .get(...range.args) as { afterSearch: number; missed: number };
  return { afterSearch: row.afterSearch, missed: row.missed };
}

/**
 * Sums the cost in USD of the model calls of the change requests of the bounds, and counts the requests that wrote.
 *
 * @param store - the open store
 * @param bounds - the span, from `spanBounds`; it applies to `received_at` of the request
 * @param prices - the price table; a model it does not list costs 0
 * @returns `writes`: the change requests that wrote at least 1 fact version (a split is not one); `usd`: the sum over the
 *   `model_calls` rows of the change requests and the splits of `costUsd` of the price table; `wastedUsd`: the part of `usd` on requests that
 *   wrote no fact version and on splits whose children wrote none; `tokens` and `wastedTokens`: the same split in input, output and cache tokens;
 *   `unpricedCalls`: the rows whose model has no price
 * @sideEffects none (reads `model_calls`, `change_requests`, `changes`, `fact_versions`)
 */
export function tokenCost(store: Store, bounds: SpanBounds, prices: PriceTable): TokenCost {
  const range = within("r.received_at", bounds);
  const requests = store.db
    .prepare(
      `SELECT COALESCE(SUM(wrote), 0) AS writes
       FROM (
         SELECT ${WROTE_FACT_VERSION} AS wrote
         FROM change_requests r
         WHERE ${IS_CHANGE_REQUEST} AND ${range.sql}
       )`,
    )
    .get(...range.args) as { writes: number };
  const rows = store.db
    .prepare(
      `SELECT m.model AS model,
              ${WROTE_FACT_VERSION} AS wrote,
              SUM(m.tokens_in) AS input,
              SUM(m.tokens_cache_write) AS cacheWrite,
              SUM(m.tokens_cache_read) AS cacheRead,
              SUM(m.tokens_out) AS output,
              COUNT(*) AS calls
       FROM change_requests r JOIN model_calls m ON m.request_id = r.id
       WHERE ${IS_SUBMISSION} AND ${range.sql}
       GROUP BY m.model, wrote`,
    )
    .all(...range.args) as {
    model: string;
    wrote: number;
    input: number;
    cacheWrite: number;
    cacheRead: number;
    output: number;
    calls: number;
  }[];
  const cost: TokenCost = {
    writes: requests.writes,
    usd: 0,
    wastedUsd: 0,
    tokens: 0,
    wastedTokens: 0,
    unpricedCalls: 0,
  };
  for (const row of rows) {
    const price = priceFor(prices, row.model);
    const usd = costUsd(prices, row.model, row);
    const tokens = row.input + row.cacheWrite + row.cacheRead + row.output;
    cost.usd += usd;
    cost.tokens += tokens;
    if (row.wrote === 0) {
      cost.wastedUsd += usd;
      cost.wastedTokens += tokens;
    }
    if (!price.known) cost.unpricedCalls += row.calls;
  }
  return cost;
}
