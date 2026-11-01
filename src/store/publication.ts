// technical/publication.md, "The demo copy": the steps that run on the copy of a live store before it is published.
import { MetaKey } from "../domain/enums.js";
import type { Store } from "./types/index.js";

/** The `meta` keys that stay in the copy: the keys that `openStore` checks. The other rows are state of the live service. */
const KEPT_META_KEYS: readonly string[] = [MetaKey.SchemaVersion, MetaKey.EmbeddingModel, MetaKey.EmbeddingDim];

/** The tables that record use, not knowledge, in an order that keeps every foreign key valid. */
const USE_TABLES = ["retrievals", "search_results", "searches", "tool_calls", "model_calls", "sessions"];

/** One text value of a table, with the place that names it. */
export interface TextCell {
  table: string;
  column: string;
  /** The SQLite `rowid` of the row. */
  rowid: number;
  value: string;
}

// The columns of type TEXT of the base tables. The index tables are left out: the shadow tables of a virtual table hold
// numbers, or a copy of text that `rebuildFullText` refreshes.
function textColumns(store: Store): { table: string; column: string }[] {
  const { db } = store;
  const tables = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'")
    .all() as { name: string; sql: string | null }[];
  const virtual = tables.filter((t) => /^CREATE VIRTUAL TABLE/i.test(t.sql ?? "")).map((t) => t.name);
  const columns: { table: string; column: string }[] = [];
  for (const { name } of tables) {
    if (virtual.some((v) => name === v || name.startsWith(`${v}_`))) continue;
    const info = db.prepare(`PRAGMA table_info(${name})`).all() as { name: string; type: string }[];
    for (const c of info.filter((i) => i.type.toUpperCase() === "TEXT")) columns.push({ table: name, column: c.name });
  }
  return columns;
}

/**
 * Removes what the live service keeps beyond the knowledge from the copy of a store, and rewrites the text of the rest,
 * in 1 transaction. A change request keeps its row but loses the link to its session and its search. The `meta` table
 * keeps the schema version and the embedding model and dimension; the worker status, the pause note and the other
 * rows go. The staging tables (`stg_*`) are emptied.
 *
 * @param store - an open store on the copy, never on the live file
 * @param rewrite - maps a text to the text that replaces it; applied to every TEXT column that `listTextCells` reads
 * @returns the number of values that `rewrite` changed
 * @throws {Error} when SQLite refuses a statement, for example when a rewritten key breaks a foreign key; the
 *   transaction rolls back
 * @sideEffects deletes the rows of the use tables, of the staging tables and of `meta` except the kept keys; updates the
 *   TEXT columns of all other tables; the full-text index is stale until `rebuildFullText` runs
 */
export function anonymizeStore(store: Store, rewrite: (text: string) => string): number {
  const { db } = store;
  return db.transaction(() => {
    db.exec("UPDATE change_requests SET session_id = NULL, search_id = NULL");
    for (const table of USE_TABLES) db.exec(`DELETE FROM ${table}`);
    db.prepare(`DELETE FROM meta WHERE key NOT IN (${KEPT_META_KEYS.map(() => "?").join(", ")})`).run(
      ...KEPT_META_KEYS,
    );
    const staging = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'stg\\_%' ESCAPE '\\'",
    );
    for (const { name } of staging.all() as { name: string }[]) db.exec(`DELETE FROM ${name}`);
    let changed = 0;
    for (const { table, column } of textColumns(store)) {
      // `rid` and not `rowid`: SQLite names the result column of a table with an integer key after the key.
      const rows = db
        .prepare(`SELECT rowid AS rid, ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL`)
        .all() as { rid: number; value: string }[];
      const update = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE rowid = ?`);
      for (const row of rows) {
        const next = rewrite(row.value);
        if (next === row.value) continue;
        update.run(next, row.rid);
        changed += 1;
      }
    }
    return changed;
  })();
}

/**
 * Rebuilds the full-text index of the fact versions from `fact_versions`, because the index holds its own copy of
 * the text.
 *
 * @param store - an open store
 * @sideEffects rewrites `fact_versions_fts`
 */
export function rebuildFullText(store: Store): void {
  store.db.exec("INSERT INTO fact_versions_fts(fact_versions_fts) VALUES ('delete-all')");
  store.db.exec("INSERT INTO fact_versions_fts(fact_versions_fts) VALUES ('rebuild')");
}

/**
 * Lists every text value of every table of the store, for the scan of the private terms. The index tables are left
 * out: the shadow tables of a virtual table hold numbers, or a copy of text that `rebuildFullText` refreshes.
 *
 * @param store - an open store
 * @returns the non-null values of the columns of type TEXT, in table order
 * @sideEffects none (reads)
 */
export function listTextCells(store: Store): TextCell[] {
  const cells: TextCell[] = [];
  for (const { table, column } of textColumns(store)) {
    const rows = store.db
      .prepare(`SELECT rowid AS rid, ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL`)
      .all() as { rid: number; value: string }[];
    for (const row of rows) cells.push({ table, column, rowid: row.rid, value: row.value });
  }
  return cells;
}

/**
 * Compacts the file so that it holds no deleted text, and leaves the journal mode that keeps 1 file.
 *
 * @param store - an open store on the copy
 * @sideEffects switches the journal mode to DELETE, which ends the WAL files; runs `VACUUM`, which rewrites the file
 */
export function compactStore(store: Store): void {
  store.db.pragma("journal_mode = DELETE");
  store.db.exec("VACUUM");
}
