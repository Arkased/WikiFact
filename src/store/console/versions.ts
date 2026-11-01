// The fact version rows as the console reads of technical/console.md, "Store API additions" load them, and the observed rule
// of technical/lookup.md, "Confidence" that the fact page and the Flags of Structure share.
import { isObservedVersion, type ObservedColumns } from "../scores.js";
import { inList } from "../sql.js";
import type { FactVersion, Store } from "../types/index.js";

/** One `fact_versions` row. */
export interface VersionRow {
  id: number;
  fact_id: string;
  seq: number;
  header: string;
  content: string;
  justification: string;
  change_reasoning: string;
  is_deleted: number;
  created_at: number;
}

/** The columns of `VersionRow`, for a `SELECT` over `fact_versions` or its view. */
export const VERSION_COLUMNS =
  "id, fact_id, seq, header, content, justification, change_reasoning, is_deleted, created_at";

/**
 * Loads the references of version rows and shapes them as `FactVersion`.
 *
 * @param store - the open store
 * @param rows - the version rows
 * @returns one version per row, in the order of `rows`; references sorted by id
 * @sideEffects none (reads)
 */
export function toFactVersions(store: Store, rows: VersionRow[]): FactVersion[] {
  const refs = new Map<number, string[]>();
  if (rows.length > 0) {
    const ids = rows.map((r) => r.id);
    const refRows = store.db
      .prepare(
        `SELECT fact_version_id AS vid, ref_fact_id AS ref FROM fact_version_refs
         WHERE fact_version_id IN (${inList(ids.length)}) ORDER BY ref_fact_id`,
      )
      .all(...ids) as { vid: number; ref: string }[];
    for (const r of refRows) refs.set(r.vid, [...(refs.get(r.vid) ?? []), r.ref]);
  }
  return rows.map((r) => ({
    seq: r.seq,
    header: r.header,
    content: r.content,
    justification: r.justification,
    references: refs.get(r.id) ?? [],
    changeReasoning: r.change_reasoning,
    isDeleted: r.is_deleted === 1,
    created: r.created_at,
  }));
}

/**
 * Reads every version of a fact.
 *
 * @param store - the open store
 * @param factId - the fact id
 * @returns the rows, oldest first; empty for an unknown id
 * @sideEffects none (reads)
 */
export function versionRowsOf(store: Store, factId: string): VersionRow[] {
  return store.db
    .prepare(`SELECT ${VERSION_COLUMNS} FROM fact_versions WHERE fact_id = ? ORDER BY seq ASC`)
    .all(factId) as VersionRow[];
}

/**
 * technical/lookup.md, "Confidence": marks the observed versions of one fact, with the `isObservedVersion` rule of `scores.ts`.
 *
 * @param rows - the versions of one fact, oldest first
 * @returns one flag per row, in the same order
 * @sideEffects none
 */
export function observedFlags(rows: ObservedColumns[]): boolean[] {
  return rows.map((v, i) => isObservedVersion(v, i > 0 ? rows[i - 1] : undefined));
}
