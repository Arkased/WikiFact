// The random sample of technical/console.md, "Search": live facts for a spot-check. Records no retrieval (design/console.md, "Reads not counted").
import { confidences } from "../scores.js";
import type { SampleFact, Store } from "../types/index.js";

/**
 * technical/console.md, "Store API additions", `sampleFacts`: `n` random live facts with header, content and confidence.
 *
 * @param store - the open store
 * @param n - how many facts to draw; fewer come back when the wiki has fewer live facts
 * @param now - the clock, in ms since the epoch, for the confidence
 * @returns the facts in random order, a fresh set on every call; empty on a wiki without live facts
 * @sideEffects none (reads; the order comes from SQLite's `random()`)
 */
export function sampleFacts(store: Store, n: number, now: number): SampleFact[] {
  const rows = store.db
    .prepare(
      `SELECT fact_id, header, content FROM current_fact_versions
       WHERE is_deleted = 0 ORDER BY random() LIMIT ?`,
    )
    .all(n) as { fact_id: string; header: string; content: string }[];
  if (rows.length === 0) return [];
  const conf = confidences(
    store,
    rows.map((r) => r.fact_id),
    now,
  );
  return rows.map((r) => ({
    id: r.fact_id,
    header: r.header,
    content: r.content,
    confidence: conf.get(r.fact_id) ?? 0,
  }));
}
