import { RetrievalKind } from "../domain/enums.js";
import type { Store } from "./types/index.js";

/**
 * technical/lookup.md, "getFact". Records one `retrievals` row on the current version of a live fact.
 * Records nothing for a deleted or unknown fact.
 *
 * @param store - the open store
 * @param factId - the fact id
 * @param opts - the clock in ms, the kind (default read), the weight (default 1) and the ref
 * @param opts.now - the clock, in ms since the epoch; default now
 * @param opts.kind - the retrieval kind; default read
 * @param opts.weight - the weight of the retrieval; default 1
 * @param opts.ref - the `ref` of the search result that the call came by; default none, stored as NULL (an unlinked read)
 * @returns true when a row was written, false for a deleted or unknown fact
 * @sideEffects one insert on the store (none when it returns false); reads the clock when `opts.now` is absent
 */
export function recordRetrieval(
  store: Store,
  factId: string,
  opts: { now?: number; kind?: RetrievalKind; weight?: number; ref?: string } = {},
): boolean {
  const row = store.db.prepare("SELECT id, is_deleted FROM current_fact_versions WHERE fact_id = ?").get(factId) as
    { id: number; is_deleted: number } | undefined;
  if (!row || row.is_deleted === 1) return false;
  store.db
    .prepare("INSERT INTO retrievals(fact_version_id, at, kind, weight, ref) VALUES (?, ?, ?, ?, ?)")
    .run(row.id, opts.now ?? Date.now(), opts.kind ?? RetrievalKind.Read, opts.weight ?? 1, opts.ref ?? null);
  return true;
}
