import type { FactLists } from "./candidates.js";

/** technical/lookup.md, "Retrieval pipeline", step 6: the rank offset of Reciprocal Rank Fusion, in ranks. */
const RRF_K = 60;

/**
 * The fused score of a fact: the sum of its terms, and the version of its best single term. `ftsTerms` is the
 * most distinct query terms that a full-text row of the fact matches, 0 when the full-text list lacks the fact.
 * `distance` is the smallest cosine distance of the fact in the vector list, absent when the vector list lacks it.
 */
export interface FusedFact {
  rrf: number;
  bestTerm: number;
  versionId?: number;
  ftsTerms: number;
  distance?: number;
}

/** technical/lookup.md, "Retrieval pipeline", step 7: the distinct query terms a full-text row must match to pass the floor on text alone. */
const MIN_FTS_TERMS = 2;

/**
 * technical/lookup.md, "Retrieval pipeline", step 6: the Reciprocal Rank Fusion term of one list entry.
 *
 * @param rank - the zero-based position of the entry in its list
 * @returns `1 / (RRF_K + rank + 1)`
 * @sideEffects none
 */
const rrfTerm = (rank: number): number => 1 / (RRF_K + rank + 1);

// The smaller of 2 optional distances.
const nearer = (a: number | undefined, b: number | undefined): number | undefined =>
  a === undefined ? b : b === undefined ? a : Math.min(a, b);

/**
 * technical/lookup.md, "Retrieval pipeline", step 6. Fuses the 2 fact lists by Reciprocal Rank Fusion.
 * In agent form the version of the best single term names the version that matched best.
 *
 * @param lists - the full-text and vector lists of facts
 * @returns the fused score per fact id, in order of first appearance
 * @sideEffects none
 */
export function fuseFacts(lists: FactLists): Map<string, FusedFact> {
  const out = new Map<string, FusedFact>();
  const add = (list: FactLists["fts"], isFts: boolean): void => {
    list.forEach((hit, rank) => {
      const term = rrfTerm(rank);
      const cur = out.get(hit.factId) ?? { rrf: 0, bestTerm: 0, versionId: undefined, ftsTerms: 0 };
      cur.rrf += term;
      if (term > cur.bestTerm) {
        cur.bestTerm = term;
        cur.versionId = hit.versionId;
      }
      if (isFts) cur.ftsTerms = Math.max(cur.ftsTerms, hit.ftsTerms ?? 0);
      cur.distance = nearer(cur.distance, hit.distance);
      out.set(hit.factId, cur);
    });
  };
  add(lists.fts, true);
  add(lists.vec, false);
  return out;
}

/**
 * technical/lookup.md, "Retrieval pipeline", step 7. Keeps a fact when its cosine distance to the query is at most the floor, or its
 * full-text row matches at least 2 distinct query terms, or the query has exactly 1 term and the row matches it.
 * A row that matches 1 common word of several terms does not pass on that alone.
 *
 * @param facts - the fused facts
 * @param rule - the floor and the query size
 * @param rule.floor - the largest cosine distance that passes (`relevanceFloor`)
 * @param rule.queryTerms - the number of terms of the full-text query
 * @returns the facts that stay, in their order
 * @sideEffects none
 */
export function applyRelevanceFloor(
  facts: Map<string, FusedFact>,
  rule: { floor: number; queryTerms: number },
): Map<string, FusedFact> {
  const keep = (h: { ftsTerms: number; distance?: number }): boolean =>
    (h.distance !== undefined && h.distance <= rule.floor) ||
    h.ftsTerms >= MIN_FTS_TERMS ||
    (rule.queryTerms === 1 && h.ftsTerms === 1);
  return new Map([...facts].filter(([, f]) => keep(f)));
}
