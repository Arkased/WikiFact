// A wiki database of schema 15, the schema before the tables of the removed feature were dropped. The
// migration to schema 16 is the only code that reads such a database, so only its tests build one.
import { closeStore } from "../../src/store/index.js";
import { EMBEDDING_DIM } from "../../src/embed/index.js";
import { makeFileStore } from "./store.js";

/** What `makeSchema15Db` put into the database, for the assertions. */
export interface Schema15 {
  /** The path of the database file. */
  path: string;
  /** The id of the request of the removed repair kind. */
  oldRequestId: string;
}

/**
 * Makes a database file of schema 15: the current tables, then the 6 tables of the removed feature and their 3 staging tables, `stg_vectors` with its old CHECK, then the 3 tables
 * that held a member of it in a CHECK rebuilt without that CHECK, and 1 row of each kind in them. The file is closed.
 *
 * @returns the path and the id of the old request
 * @sideEffects makes a temp folder under the run folder and a database file in it
 */
export function makeSchema15Db(): Schema15 {
  const store = makeFileStore();
  const { db } = store;
  const path = db.name;
  db.pragma("foreign_keys = OFF");
  db.exec(`
DROP TABLE stg_vectors;
CREATE TABLE stg_vectors (kind TEXT NOT NULL CHECK (kind IN ('fact', 'tag')), ref INTEGER NOT NULL, embedding BLOB NOT NULL,
  PRIMARY KEY (kind, ref));
CREATE TABLE stg_tags ("rowid" INTEGER PRIMARY KEY, "id" TEXT NOT NULL, "name" TEXT NOT NULL, "description" TEXT NOT NULL,
  "created_at" INTEGER NOT NULL, "is_deleted" INTEGER NOT NULL DEFAULT (0), UNIQUE ("id"));
CREATE TABLE stg_tag_versions ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "tag_id" TEXT NOT NULL, "seq" INTEGER NOT NULL,
  "name" TEXT NOT NULL, "description" TEXT NOT NULL, "is_deleted" INTEGER NOT NULL DEFAULT (0), "created_at" INTEGER NOT NULL,
  UNIQUE ("tag_id", "seq"));
CREATE TABLE stg_fact_version_tags ("fact_version_id" INTEGER NOT NULL, "tag_id" TEXT NOT NULL,
  PRIMARY KEY ("fact_version_id", "tag_id"));
DROP TABLE search_results;
CREATE TABLE search_results (
  search_id TEXT NOT NULL REFERENCES searches(id), kind TEXT NOT NULL, target_id TEXT NOT NULL, rank INTEGER NOT NULL,
  ref TEXT NOT NULL, PRIMARY KEY (search_id, kind, target_id)
);
DROP TABLE cleanup_verdicts;
CREATE TABLE cleanup_verdicts (
  finder TEXT NOT NULL, subject TEXT NOT NULL, seq INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (finder, subject)
);
DROP TABLE change_requests;
CREATE TABLE change_requests (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'submission', status TEXT NOT NULL, change TEXT, targets TEXT NOT NULL,
  justification TEXT, attempts INTEGER NOT NULL DEFAULT 0, received_at INTEGER NOT NULL, started_at INTEGER,
  finished_at INTEGER, error TEXT, parent_id TEXT REFERENCES change_requests(id), session_id TEXT REFERENCES sessions(id),
  search_id TEXT REFERENCES searches(id)
);
CREATE TABLE tags (rowid INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, description TEXT NOT NULL,
  created_at INTEGER NOT NULL, is_deleted INTEGER NOT NULL DEFAULT 0);
CREATE TABLE tag_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, tag_id TEXT NOT NULL REFERENCES tags(id),
  seq INTEGER NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL, is_deleted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL);
CREATE TABLE fact_version_tags (fact_version_id INTEGER NOT NULL, tag_id TEXT NOT NULL REFERENCES tags(id),
  PRIMARY KEY (fact_version_id, tag_id));
CREATE TABLE tag_retrievals (tag_id TEXT NOT NULL REFERENCES tags(id), at INTEGER NOT NULL,
  weight REAL NOT NULL DEFAULT 1, ref TEXT);
CREATE VIRTUAL TABLE tags_fts USING fts5(name, description, content='tags', content_rowid='rowid');
CREATE VIRTUAL TABLE tags_vec USING vec0(tag_rowid INTEGER PRIMARY KEY, embedding FLOAT[${EMBEDDING_DIM}]);
INSERT INTO tags(rowid, id, name, description, created_at) VALUES (1, 't1', 'Mobs', 'Creatures.', 0);
INSERT INTO tag_retrievals(tag_id, at) VALUES ('t1', 0);
INSERT INTO searches(id, query, at, duration_ms, result_count) VALUES ('s1', 'q', 0, 1, 2);
INSERT INTO search_results(search_id, kind, target_id, rank, ref) VALUES
  ('s1', 'fact', 'f1', 1, 'r1'), ('s1', 'tag', 't1', 2, 'r2');
INSERT INTO cleanup_verdicts(finder, subject, seq, at) VALUES ('duplicateFact', 'a|b', 1, 0), ('duplicateTag', 'x|y', 1, 0);
INSERT INTO change_requests(id, kind, status, change, targets, received_at) VALUES
  ('old1', 'tagRepair', 'queued', '{"finder":"duplicateTag","tagId":"t1"}', '[]', 1);
INSERT INTO meta(key, value) VALUES ('high_volume', '{"on":true,"by":"operator"}');
UPDATE meta SET value = '15' WHERE key = 'schema_version';
`);
  closeStore(store);
  return { path, oldRequestId: "old1" };
}
