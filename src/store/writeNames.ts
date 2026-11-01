import type { Store } from "./types/index.js";

/** The tables that a write step writes, by the name they have in the live wiki. */
export const WRITTEN_TABLES = [
  "changes",
  "facts",
  "fact_versions",
  "fact_version_refs",
  "retrievals",
  "change_requests",
] as const;

/** The name of a table that a write step writes. */
export type WrittenTable = (typeof WRITTEN_TABLES)[number];

/**
 * Names the tables that the write steps write on a store (technical/updates.md, "High volume mode", "Staging"). The live
 * store writes the tables of the wiki; the overlay store of a batch writes the staging tables `stg_<table>`. The read
 * queries of the write steps keep the plain names: on the overlay connection they resolve to the overlay views.
 *
 * @param store - the store a write goes to
 * @returns the table name for each written table
 * @sideEffects none
 */
export function writeNames(store: Store): Record<WrittenTable, string> {
  const prefix = store.overlay === true ? "stg_" : "";
  return Object.fromEntries(WRITTEN_TABLES.map((t) => [t, `${prefix}${t}`])) as Record<WrittenTable, string>;
}
