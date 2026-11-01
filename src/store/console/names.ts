// The light name read of technical/console.md, "Store API additions": the headers of a set of facts, for pages
// that say an id in words. It scores nothing and records no retrieval (design/console.md, "Reads not counted").
import type { Store } from "../types/index.js";

/** The names found for a set of ids. */
export interface IdNames {
  /** Fact id to the header of its current version, deleted facts included. */
  facts: Map<string, string>;
}

/**
 * technical/console.md, "Store API additions", `namesOf`: reads the header of each id that is a fact.
 *
 * @param store - the open store
 * @param ids - ids, in any mix; duplicates are fine
 * @returns the headers; an unknown id and an id that is no fact are absent
 * @sideEffects none (reads)
 */
export function namesOf(store: Store, ids: string[]): IdNames {
  const json = JSON.stringify([...new Set(ids)]);
  const facts = store.db
    .prepare(
      `SELECT fact_id AS id, header FROM current_fact_versions WHERE fact_id IN (SELECT value FROM json_each(?))`,
    )
    .all(json) as { id: string; header: string }[];
  return {
    facts: new Map(facts.map((f) => [f.id, f.header])),
  };
}
