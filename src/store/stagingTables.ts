// technical/storage.md, "Staging tables": the `stg_*` tables and the overlay views are derived from the definitions of the live
// tables in the database, so a later migration of a live table cannot leave them behind.
import type Database from "better-sqlite3";
import { StagedVectorKind, sqlList } from "../domain/enums.js";
import { WRITTEN_TABLES, type WrittenTable } from "./writeNames.js";

/** The staging table that holds no copy of a live table: the embeddings of the staged versions. */
export const STAGED_VECTORS_SQL = `
CREATE TABLE IF NOT EXISTS stg_vectors (
  kind       TEXT NOT NULL CHECK (kind IN (${sqlList(StagedVectorKind)})),
  ref        INTEGER NOT NULL,
  embedding  BLOB NOT NULL,
  PRIMARY KEY (kind, ref)
);`;

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;

// The `CREATE TABLE` of `stg_<table>`, built from the pragmas of the live table: the columns with their type, NOT NULL and
// DEFAULT, the PRIMARY KEY and the UNIQUE constraints. Nothing else is copied, so a foreign key or a CHECK of the live table (in
// any syntax) cannot reach the staging table, and no statement is edited as text.
function stagingTableSql(db: Database.Database, table: WrittenTable): string {
  const cols = db.pragma(`table_info(${quote(table)})`) as ColumnInfo[];
  if (cols.length === 0) throw new Error(`the live table ${table} does not exist`);
  const pk = cols.filter((c) => c.pk > 0).sort((x, y) => x.pk - y.pk);
  // No pragma reports AUTOINCREMENT, and `sqlite_sequence` has a row only after the first insert. The one source is the stored
  // statement: it is tested for the keyword on a table with a single INTEGER primary key, and no text of it is copied.
  const storedSql = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .pluck()
    .get(table) as string;
  const autoIncrement =
    pk.length === 1 && pk[0]?.type.toUpperCase() === "INTEGER" && storedSql.toUpperCase().includes("AUTOINCREMENT");
  const defs = cols.map((c) => {
    const inlineKey = pk.length === 1 && c.pk > 0;
    return [
      quote(c.name),
      c.type,
      inlineKey ? "PRIMARY KEY" : "",
      inlineKey && autoIncrement ? "AUTOINCREMENT" : "",
      c.notnull === 1 && !inlineKey ? "NOT NULL" : "",
      c.dflt_value === null ? "" : `DEFAULT (${c.dflt_value})`,
    ]
      .filter((part) => part !== "")
      .join(" ");
  });
  if (pk.length > 1) defs.push(`PRIMARY KEY (${pk.map((c) => quote(c.name)).join(", ")})`);
  const indexes = db.pragma(`index_list(${quote(table)})`) as { name: string; unique: number; origin: string }[];
  // Origin `u` is a UNIQUE constraint of the table; `c` is a CREATE INDEX (a partial or expression index stays on the live table).
  for (const ix of indexes.filter((i) => i.unique === 1 && i.origin === "u")) {
    const keyCols = db.pragma(`index_info(${quote(ix.name)})`) as { seqno: number; name: string }[];
    defs.push(
      `UNIQUE (${keyCols
        .sort((x, y) => x.seqno - y.seqno)
        .map((c) => quote(c.name))
        .join(", ")})`,
    );
  }
  return `CREATE TABLE IF NOT EXISTS ${quote(`stg_${table}`)} (${defs.join(", ")});`;
}

/**
 * Creates the staging tables from the definitions of the live tables, and `stg_vectors`.
 *
 * @param db - the open database with the write connection, in a transaction when `replace` is set
 * @param replace - true: drop each staging table first, so that it follows the live table as it is now (the tables are empty
 *   outside a batch); false: create only a table that is absent
 * @throws {Error} when a live table is absent
 * @sideEffects creates tables; with `replace`, drops them first and so deletes their rows and their id sequences
 */
export function createStagingTables(db: Database.Database, replace: boolean): void {
  if (replace) {
    for (const t of WRITTEN_TABLES) db.exec(`DROP TABLE IF EXISTS stg_${t}`);
    db.exec("DROP TABLE IF EXISTS stg_vectors");
  }
  for (const t of WRITTEN_TABLES) db.exec(stagingTableSql(db, t));
  db.exec(STAGED_VECTORS_SQL);
}

/**
 * Lists the columns of a live table, comma separated, in the order of its definition.
 *
 * @param db - the open database
 * @param table - the live table
 * @returns the column names for a `SELECT` or an `INSERT` list
 * @sideEffects none (reads)
 */
export function columnList(db: Database.Database, table: WrittenTable): string {
  return (db.pragma(`table_info(${table})`) as { name: string }[]).map((c) => c.name).join(", ");
}

// The tables that the overlay shows; the queue (`change_requests`) is read from the live table.
const OVERLAID_TABLES = WRITTEN_TABLES.filter((t) => t !== "change_requests");

/**
 * Builds the temporary views of the overlay connection (technical/storage.md, "Staging tables"): each view shadows the table of
 * the same name and reads the live rows plus the staged rows. The columns come from the live table. They are temporary, so no
 * migration of a live table meets them.
 *
 * @param db - the open database of the overlay connection
 * @returns the SQL that creates the views
 * @sideEffects none (reads)
 */
export function overlaySql(db: Database.Database): string {
  return OVERLAID_TABLES.map((t) => {
    const cols = columnList(db, t);
    return `CREATE TEMP VIEW ${t} AS SELECT ${cols} FROM main.${t} UNION ALL SELECT ${cols} FROM main.stg_${t};`;
  }).join("\n");
}
