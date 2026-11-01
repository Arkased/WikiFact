import type Database from "better-sqlite3";
import { CleanupFinder, MetaKey, RequestKind, SearchHitKind, StagedVectorKind } from "../domain/enums.js";
import { CHANGE_REQUESTS_SQL, CLEANUP_VERDICTS_SQL, MINTED_REF_INDEX_SQL, SEARCH_LOG_SQL } from "./schema.js";
import { STAGED_VECTORS_SQL } from "./stagingTables.js";

/**
 * One step from the schema before it to `version`. It keeps every row that the removed feature does not own; a rebuild copies
 * the rows with their rowids, except a table whose key is not the rowid (`search_results`, `cleanup_verdicts`).
 */
interface Migration {
  /** The schema version that the database has after `apply`. */
  version: number;
  /**
   * Changes the schema of an open database from the version before to this one.
   *
   * @param db - the open database, inside the transaction of the migration, with foreign keys off
   * @sideEffects writes to the schema of `db`
   */
  apply: (db: Database.Database) => void;
}

// Schema 16 (technical/storage.md, "Tables"). The tables of the removed feature go: 6 tables, 3 staging tables, their indexes and their search
// index tables. Three tables had a member of it in a CHECK or in a row, so each is rebuilt with every other row copied
// (the 12-step procedure): `search_results` keeps its fact rows, `cleanup_verdicts` keeps the verdicts of the duplicate
// fact check, and `change_requests` renames the kind of a cleanup repair. A table is rebuilt from the current definition
// after its rows are held in a temporary table, so the definition is written in one place only. The unique index on
// `search_results.ref` is created inside the migration, because the foreign key check after it needs it.
function migrateToSchema16(db: Database.Database): void {
  db.exec(`
DROP TABLE IF EXISTS tag_retrievals;
DROP TABLE IF EXISTS fact_version_tags;
DROP TABLE IF EXISTS tag_versions;
DROP TABLE IF EXISTS tags_fts;
DROP TABLE IF EXISTS tags_vec;
DROP TABLE IF EXISTS tags;
DROP TABLE IF EXISTS stg_tags;
DROP TABLE IF EXISTS stg_tag_versions;
DROP TABLE IF EXISTS stg_fact_version_tags;

CREATE TEMP TABLE held_stg_vectors AS SELECT * FROM stg_vectors WHERE kind = '${StagedVectorKind.Fact}';
DROP TABLE stg_vectors;
${STAGED_VECTORS_SQL}
INSERT INTO stg_vectors(kind, ref, embedding) SELECT kind, ref, embedding FROM held_stg_vectors;
DROP TABLE held_stg_vectors;

CREATE TEMP TABLE held_search_results AS SELECT * FROM search_results WHERE kind = '${SearchHitKind.Fact}';
DROP TABLE search_results;
${SEARCH_LOG_SQL}
INSERT INTO search_results(search_id, kind, target_id, rank, ref)
  SELECT search_id, kind, target_id, rank, ref FROM held_search_results;
DROP TABLE held_search_results;

CREATE TEMP TABLE held_cleanup_verdicts AS SELECT * FROM cleanup_verdicts WHERE finder = '${CleanupFinder.DuplicateFact}';
DROP TABLE cleanup_verdicts;
${CLEANUP_VERDICTS_SQL}
INSERT INTO cleanup_verdicts(finder, subject, seq, at) SELECT finder, subject, seq, at FROM held_cleanup_verdicts;
DROP TABLE held_cleanup_verdicts;

CREATE TEMP TABLE held_change_requests AS SELECT rowid AS rid, * FROM change_requests;
DROP TABLE change_requests;
${CHANGE_REQUESTS_SQL}
INSERT INTO change_requests(rowid, id, kind, status, change, targets, justification, attempts, received_at, started_at,
                            finished_at, error, parent_id, session_id, search_id)
  SELECT rid, id, CASE kind WHEN 'tagRepair' THEN '${RequestKind.CleanupRepair}' ELSE kind END, status, change, targets,
         justification, attempts, received_at, started_at, finished_at, error, parent_id, session_id, search_id
  FROM held_change_requests;
DROP TABLE held_change_requests;
${MINTED_REF_INDEX_SQL}
`);
}

// Schema 17. The meta key `high_volume` belongs to the removed threshold mode of the worker.
function migrateToSchema17(db: Database.Database): void {
  db.exec(`DELETE FROM meta WHERE key = 'high_volume';`);
}

/** The migrations above the oldest schema, in order. The last version equals `SCHEMA_VERSION`. */
const MIGRATIONS: Migration[] = [
  { version: 16, apply: migrateToSchema16 },
  { version: 17, apply: migrateToSchema17 },
];

/**
 * Applies the migrations above the stored schema version, in order.
 *
 * @param db - the open, writable database
 * @param stored - the schema version in `meta`
 * @throws {Error} when a migration leaves a foreign key violation; that migration is rolled back
 * @sideEffects one immediate transaction per migration: the schema change and the new `meta.schema_version`; foreign
 *   keys are off during a migration (a table rebuild needs it) and on again after it
 */
export function migrate(db: Database.Database, stored: number): void {
  for (const m of MIGRATIONS) {
    if (m.version <= stored) continue;
    // The pragma is a no-op inside a transaction, so it is set around it.
    db.pragma("foreign_keys = OFF");
    try {
      db.transaction(() => {
        m.apply(db);
        const violations = db.pragma("foreign_key_check") as unknown[];
        if (violations.length > 0) throw new Error(`migration to schema ${m.version} breaks a foreign key`);
        db.prepare("UPDATE meta SET value = ? WHERE key = ?").run(String(m.version), MetaKey.SchemaVersion);
      }).immediate();
    } finally {
      db.pragma("foreign_keys = ON");
    }
  }
}
