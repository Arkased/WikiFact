import { decay } from "../scores.js";
import { inList } from "../sql.js";
import type { Store, Weights } from "../types/index.js";
import type { FusedFact } from "./fuse.js";

/** A hit with its final score: the fused score times the usefulness factor. */
export interface Scored {
  factId: string;
  versionId?: number;
  score: number;
}

interface UseRow {
  id: string;
  weight: number;
  at: number;
}

// Sums `weight * decay(at)` per id.
function sumUse(rows: UseRow[], now: number, halfLife: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) out.set(r.id, (out.get(r.id) ?? 0) + r.weight * decay(r.at, now, halfLife));
  return out;
}

// technical/lookup.md, "Usefulness": the decayed retrievals of the facts in the merged set, over every version of each fact.
function factUse(store: Store, factIds: string[], now: number): Map<string, number> {
  if (factIds.length === 0) return new Map();
  const rows = store.db
    .prepare(
      `SELECT fv.fact_id AS id, r.weight AS weight, r.at AS at
       FROM retrievals r JOIN fact_versions fv ON fv.id = r.fact_version_id
       WHERE fv.fact_id IN (${inList(factIds.length)})`,
    )
    .all(...factIds) as UseRow[];
  return sumUse(rows, now, store.weights.halfLifeUse);
}

/**
 * technical/lookup.md, "Retrieval pipeline", step 8. The factor that usefulness puts on a fused score:
 * `clamp(1 + wUse * (use - meanUse), 1 - useBound, 1 + useBound)`.
 *
 * @param use - the usefulness of the hit
 * @param meanUse - the mean usefulness over the hits in the result list
 * @param weights - `wUse` and `useBound` of the store weights
 * @returns a factor between `1 - useBound` and `1 + useBound`
 * @sideEffects none
 */
export function useMultiplier(use: number, meanUse: number, weights: Pick<Weights, "wUse" | "useBound">): number {
  const raw = 1 + weights.wUse * (use - meanUse);
  return Math.min(1 + weights.useBound, Math.max(1 - weights.useBound, raw));
}

// The mean of the values; 0 for none.
const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

/**
 * technical/lookup.md, "Retrieval pipeline", step 8. Multiplies the fused score of each hit by its usefulness factor. The mean usefulness is over
 * the facts of the list. One query reads the retrievals of the facts.
 *
 * @param store - the open store
 * @param factScore - the fused facts that passed the relevance floor, by fact id
 * @param now - the clock, in ms since the epoch
 * @returns every hit with its final score, in the order of the fused map
 * @sideEffects none (reads)
 */
export function boost(store: Store, factScore: Map<string, FusedFact>, now: number): Scored[] {
  const useByFact = factUse(store, [...factScore.keys()], now);
  const meanFact = mean([...factScore.keys()].map((id) => useByFact.get(id) ?? 0));
  const scored: Scored[] = [];
  for (const [factId, s] of factScore) {
    scored.push({
      factId,
      versionId: s.versionId,
      score: s.rrf * useMultiplier(useByFact.get(factId) ?? 0, meanFact, store.weights),
    });
  }
  return scored;
}
