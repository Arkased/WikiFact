// The searches with their listed results and their reads, for the test of the reads per search (technical/console.md,
// "Store API reads for the signals"). It reads and writes nothing else.
import { RetrievalKind, SearchHitKind } from "../domain/enums.js";
import type { Store } from "./types/index.js";

/** A fact that a search listed. */
interface ListedResult {
  /** The place in the list, from 1. */
  rank: number;
  factId: string;
  /** The header of the version of the fact that was the newest at the time of the search. */
  header: string;
}

/** A fact that a read opened, as the version it read. */
interface ReadFact {
  factId: string;
  header: string;
  content: string;
}

/** One search with results and minted ids, with the reads that link to it. */
export interface SearchRead {
  id: string;
  query: string;
  /** The time of the search, in ms since the epoch. */
  at: number;
  /** The listed facts in rank order. */
  results: ListedResult[];
  /** The ids of listed facts with no version at or before the time of the search; they are not in `results`. */
  omitted: string[];
  /** One entry per read row, in time order: a fact read twice appears twice. */
  reads: ReadFact[];
}

// The rows by search id, each list in the order of the rows (the target lib has no `Map.groupBy`).
function groupBySearch<T extends { searchId: string }>(rows: T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) grouped.set(row.searchId, [...(grouped.get(row.searchId) ?? []), row]);
  return grouped;
}

/**
 * Lists every search that has results and minted ids, with its listed facts and the read rows that link to it.
 *
 * @param store - the open store
 * @returns the searches in time order. A listed fact shows the newest version with `created_at` at or before the time of
 *   the search (what the agent saw), and a listed fact with no such version is in `omitted`. A read shows the version
 *   that the read row names. A read links to a search by `retrievals.ref` = `search_results.ref`, kind `read`
 *   (the rule of `readsPerSearch`); a search with no result or no `search_results` row is left out.
 * @sideEffects none (reads `searches`, `search_results`, `retrievals`, `fact_versions`)
 */
export function listSearchReads(store: Store): SearchRead[] {
  const searches = store.db
    .prepare(
      `SELECT id, query, at FROM searches
       WHERE result_count > 0 AND EXISTS (SELECT 1 FROM search_results sr WHERE sr.search_id = searches.id)
       ORDER BY at, id`,
    )
    .all() as { id: string; query: string; at: number }[];
  const results = store.db
    .prepare(
      `SELECT sr.search_id AS searchId, sr.rank AS rank, sr.target_id AS factId, v.header AS header
       FROM search_results sr JOIN searches s ON s.id = sr.search_id
       LEFT JOIN fact_versions v ON v.fact_id = sr.target_id
         AND v.seq = (SELECT MAX(seq) FROM fact_versions WHERE fact_id = sr.target_id AND created_at <= s.at)
       WHERE sr.kind = '${SearchHitKind.Fact}' ORDER BY sr.search_id, sr.rank`,
    )
    .all() as (Omit<ListedResult, "header"> & { searchId: string; header: string | null })[];
  const reads = store.db
    .prepare(
      `SELECT sr.search_id AS searchId, v.fact_id AS factId, v.header AS header, v.content AS content
       FROM retrievals r JOIN search_results sr ON sr.ref = r.ref JOIN fact_versions v ON v.id = r.fact_version_id
       WHERE r.kind = '${RetrievalKind.Read}' ORDER BY r.at`,
    )
    .all() as (ReadFact & { searchId: string })[];
  const resultsOf = groupBySearch(results);
  const readsOf = groupBySearch(reads);
  return searches.map((s) => ({
    ...s,
    results: (resultsOf.get(s.id) ?? []).flatMap(({ rank, factId, header }) =>
      header === null ? [] : [{ rank, factId, header }],
    ),
    omitted: (resultsOf.get(s.id) ?? []).filter((r) => r.header === null).map((r) => r.factId),
    reads: (readsOf.get(s.id) ?? []).map(({ factId, header, content }) => ({ factId, header, content })),
  }));
}
