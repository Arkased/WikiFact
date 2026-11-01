import { confidence } from "./scores.js";
import type { FactHistoryResult, FactMaterial, FactResult, FactVersion, Store } from "./types/index.js";

interface VersionRow {
  id: number;
  seq: number;
  header: string;
  content: string;
  justification: string;
  change_reasoning: string;
  is_deleted: number;
  created_at: number;
}

function loadVersion(store: Store, row: VersionRow): FactVersion {
  const refs = store.db
    .prepare("SELECT ref_fact_id FROM fact_version_refs WHERE fact_version_id = ? ORDER BY ref_fact_id")
    .all(row.id) as { ref_fact_id: string }[];
  return {
    seq: row.seq,
    header: row.header,
    content: row.content,
    justification: row.justification,
    references: refs.map((r) => r.ref_fact_id),
    changeReasoning: row.change_reasoning,
    isDeleted: row.is_deleted === 1,
    created: row.created_at,
  };
}

function versionRowsNewestFirst(store: Store, factId: string): VersionRow[] {
  return store.db
    .prepare(
      `SELECT id, seq, header, content, justification, change_reasoning, is_deleted, created_at
       FROM fact_versions WHERE fact_id = ? ORDER BY seq DESC`,
    )
    .all(factId) as VersionRow[];
}

/**
 * technical/lookup.md, "getFact". Reads a fact in the consumer form: the current version only. Records nothing;
 * the MCP server calls `recordRetrieval`.
 *
 * @param store - the open store
 * @param id - the fact id
 * @param opts - the clock; `agent` false or absent
 * @param opts.now - the clock, in ms since the epoch; default now
 * @param opts.agent - true for the agent form
 * @returns the fact with its current version and confidence (0..1), or null for an unknown id; a deleted fact is
 *   returned with `isDeleted: true`
 * @sideEffects none (reads the store, and the clock when `opts.now` is absent)
 */
export function getFact(store: Store, id: string, opts?: { now?: number; agent?: false }): FactResult | null;
/**
 * technical/updates.md, "Store API reads for the update agent". Reads a fact in the agent form: every version, newest first.
 *
 * @param store - the open store
 * @param id - the fact id
 * @param opts - the clock; `agent: true`
 * @param opts.now - the clock, in ms since the epoch; default now
 * @param opts.agent - true for the agent form
 * @returns the fact with every version, newest first, or null for an unknown id
 * @sideEffects none (reads the store, and the clock when `opts.now` is absent)
 */
export function getFact(store: Store, id: string, opts: { now?: number; agent: true }): FactHistoryResult | null;
/**
 * The implementation of both forms; the overloads above are the public signatures.
 *
 * @param store - the open store
 * @param id - the fact id
 * @param opts - the clock and the form
 * @param opts.now - the clock, in ms since the epoch; default now
 * @param opts.agent - true for the agent form (every version); false or absent for the consumer form
 * @returns the result of the form `opts.agent` selects, or null for an unknown id
 * @sideEffects none (reads the store, and the clock when `opts.now` is absent)
 */
export function getFact(
  store: Store,
  id: string,
  opts: { now?: number; agent?: boolean } = {},
): FactResult | FactHistoryResult | null {
  const now = opts.now ?? Date.now();
  const [newest, ...older] = versionRowsNewestFirst(store, id);
  if (newest === undefined) return null;
  const conf = confidence(store, id, now);
  const isDeleted = newest.is_deleted === 1;
  if (opts.agent) {
    const factVersions = [newest, ...older].map((r) => loadVersion(store, r));
    return { id, isDeleted, confidence: conf, factVersions };
  }
  return { id, isDeleted, confidence: conf, current: loadVersion(store, newest) };
}

/**
 * technical/updates.md, "Step 1. Claim check and gather". Reads every version of a fact, newest first, with the agent text removed.
 *
 * @param store - the open store
 * @param id - the fact id
 * @returns the material, or null for an unknown id
 * @sideEffects none (reads)
 */
export function getFactMaterial(store: Store, id: string): FactMaterial | null {
  const versions = versionRowsNewestFirst(store, id).map((r) => loadVersion(store, r));
  const [newest] = versions;
  if (newest === undefined) return null;
  return {
    factId: id,
    isDeleted: newest.isDeleted,
    versions: versions.map((v) => ({
      seq: v.seq,
      header: v.header,
      content: v.content,
      justification: v.justification,
      references: v.references,
      isDeleted: v.isDeleted,
      created: v.created,
    })),
  };
}

/**
 * technical/updates.md, "Store API reads for the update agent". Finds the live facts whose current fact version references a fact.
 *
 * @param store - the open store
 * @param factId - the referenced fact id
 * @returns the ids of the dependents, sorted
 * @sideEffects none (reads)
 */
export function getDependents(store: Store, factId: string): string[] {
  const rows = store.db
    .prepare(
      `SELECT DISTINCT v.fact_id AS id
       FROM current_fact_versions v JOIN fact_version_refs r ON r.fact_version_id = v.id
       WHERE r.ref_fact_id = ? AND v.is_deleted = 0
       ORDER BY v.fact_id`,
    )
    .all(factId) as { id: string }[];
  return rows.map((r) => r.id);
}

/**
 * Tells whether an id names a fact, live or deleted.
 *
 * @param store - the open store
 * @param id - the id to look up
 * @returns true for a known fact id; false for any other id
 * @sideEffects none (one read)
 */
export function isFactId(store: Store, id: string): boolean {
  return store.db.prepare("SELECT 1 FROM current_fact_versions WHERE fact_id = ?").get(id) !== undefined;
}

/**
 * Tells whether a fact exists and its newest version is not a deletion.
 *
 * @param store - the open store
 * @param id - the fact id
 * @returns true for a live fact; false for a deleted or unknown id
 * @sideEffects none (one read)
 */
export function isLiveFact(store: Store, id: string): boolean {
  const r = store.db.prepare("SELECT is_deleted FROM current_fact_versions WHERE fact_id = ?").get(id) as
    { is_deleted: number } | undefined;
  return r?.is_deleted === 0;
}
