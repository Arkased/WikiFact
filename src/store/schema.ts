import {
  ChangeOutcome,
  CleanupFinder,
  RejectReason,
  RequestKind,
  RequestStatus,
  RetrievalKind,
  SearchHitKind,
  sqlList,
} from "../domain/enums.js";

/**
 * The schema version of this code, stored in `meta` as text. A new database is created at this version; an older one
 * is migrated (`migrations.ts`); a newer one is refused. `TABLES_SQL` describes this version.
 */
export const SCHEMA_VERSION = 17;

/** The oldest schema version that this code migrates. A database below it was made by code that no wiki runs any more. */
export const OLDEST_SCHEMA_VERSION = 15;

/** Schema 5 (technical/storage.md, "Tables"). A cleanup candidate that the model judged and that needed no change (technical/cleanup.md, "Cleanup"). */
export const CLEANUP_VERDICTS_SQL = `
CREATE TABLE IF NOT EXISTS cleanup_verdicts (
  finder   TEXT NOT NULL CHECK (finder IN (${sqlList(CleanupFinder)})),
  subject  TEXT NOT NULL,
  seq      INTEGER NOT NULL,
  at       INTEGER NOT NULL,
  PRIMARY KEY (finder, subject)
);`;

/**
 * Schema 7 (technical/storage.md, "Tables"). The sessions, the search log and the model call rows (technical/lookup.md,
 * "Search log and sessions", technical/updates.md, "Model call rows"). Shared by `TABLES_SQL` and the migration, so that
 * both build the same tables.
 */
export const SEARCH_LOG_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  id              TEXT PRIMARY KEY,
  started_at      INTEGER NOT NULL,
  last_call_at    INTEGER NOT NULL,
  ended_at        INTEGER,
  client_name     TEXT,
  client_version  TEXT,
  call_count      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS sessions_by_started ON sessions(started_at);

CREATE TABLE IF NOT EXISTS searches (
  id            TEXT PRIMARY KEY,
  session_id    TEXT REFERENCES sessions(id),
  query         TEXT NOT NULL,
  at            INTEGER NOT NULL,
  duration_ms   INTEGER NOT NULL,
  result_count  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS searches_by_session ON searches(session_id, at);

CREATE TABLE IF NOT EXISTS search_results (
  search_id  TEXT NOT NULL REFERENCES searches(id),
  kind       TEXT NOT NULL CHECK (kind IN (${sqlList(SearchHitKind)})),
  target_id  TEXT NOT NULL,
  rank       INTEGER NOT NULL,
  ref        TEXT NOT NULL,
  PRIMARY KEY (search_id, kind, target_id)
);
CREATE INDEX IF NOT EXISTS search_results_by_target ON search_results(kind, target_id, search_id);

CREATE TABLE IF NOT EXISTS model_calls (
  id                  TEXT PRIMARY KEY,
  request_id          TEXT NOT NULL REFERENCES change_requests(id),
  question            TEXT NOT NULL,
  model               TEXT NOT NULL,
  effort              TEXT NOT NULL,
  tokens_in           INTEGER NOT NULL,
  tokens_out          INTEGER NOT NULL,
  tokens_cache_read   INTEGER NOT NULL,
  tokens_cache_write  INTEGER NOT NULL,
  duration_ms         INTEGER NOT NULL,
  at                  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS model_calls_by_request ON model_calls(request_id);
`;

/**
 * Schema 9 (technical/storage.md, "Tables"). One row per wiki tool call, for the endpoint counters of Service health
 * (technical/deployment.md, "Endpoint counters").
 */
const TOOL_CALLS_SQL = `
CREATE TABLE IF NOT EXISTS tool_calls (
  at           INTEGER NOT NULL,
  tool         TEXT NOT NULL,
  ok           INTEGER NOT NULL,
  duration_ms  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tool_calls_by_at ON tool_calls(at);
`;

/** The table of the requests and its index (technical/storage.md, "Tables"). Shared by `TABLES_SQL` and the migration. */
export const CHANGE_REQUESTS_SQL = `
CREATE TABLE IF NOT EXISTS change_requests (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL DEFAULT '${RequestKind.Submission}' CHECK (kind IN (${sqlList(RequestKind)})),
  status        TEXT NOT NULL CHECK (status IN (${sqlList(RequestStatus)})),
  change        TEXT,
  targets       TEXT NOT NULL,
  justification TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  received_at   INTEGER NOT NULL,
  started_at    INTEGER,
  finished_at   INTEGER,
  error         TEXT,
  parent_id     TEXT REFERENCES change_requests(id),
  session_id    TEXT REFERENCES sessions(id),
  search_id     TEXT REFERENCES searches(id)
);
CREATE INDEX IF NOT EXISTS change_requests_by_status ON change_requests(status, received_at);
`;

/**
 * The SQL that creates, when absent, the base tables, their indexes and the `current_fact_versions` view
 * (technical/storage.md, "Tables" and "Current state"). The index tables come from `indexTablesSql`. The staging tables
 * of a batch are not here: `createStagingTables` derives them from these tables.
 */
export const TABLES_SQL = `
CREATE TABLE IF NOT EXISTS facts (
  id          TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL
);

${CHANGE_REQUESTS_SQL}

CREATE TABLE IF NOT EXISTS changes (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id    TEXT NOT NULL REFERENCES change_requests(id),
  outcome       TEXT NOT NULL CHECK (outcome IN (${sqlList(ChangeOutcome)})),
  reject_reason TEXT CHECK (reject_reason IN (${sqlList(RejectReason)})),
  summary       TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  duplicate_of  TEXT
);

CREATE TABLE IF NOT EXISTS fact_versions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  fact_id          TEXT NOT NULL REFERENCES facts(id),
  seq              INTEGER NOT NULL REFERENCES changes(seq),
  header           TEXT NOT NULL,
  content          TEXT NOT NULL,
  justification    TEXT NOT NULL,
  change_reasoning TEXT NOT NULL,
  is_deleted       INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  UNIQUE (fact_id, seq)
);
CREATE INDEX IF NOT EXISTS fact_versions_by_fact ON fact_versions(fact_id, seq DESC);

CREATE TABLE IF NOT EXISTS fact_version_refs (
  fact_version_id  INTEGER NOT NULL REFERENCES fact_versions(id),
  ref_fact_id      TEXT NOT NULL REFERENCES facts(id),
  PRIMARY KEY (fact_version_id, ref_fact_id)
);
CREATE INDEX IF NOT EXISTS fact_version_refs_by_target ON fact_version_refs(ref_fact_id);

CREATE TABLE IF NOT EXISTS retrievals (
  fact_version_id  INTEGER NOT NULL REFERENCES fact_versions(id),
  at               INTEGER NOT NULL,
  kind             TEXT NOT NULL DEFAULT '${RetrievalKind.Read}' CHECK (kind IN (${sqlList(RetrievalKind)})),
  weight           REAL NOT NULL DEFAULT 1,
  ref              TEXT REFERENCES search_results(ref)
);
CREATE INDEX IF NOT EXISTS retrievals_by_fact_version ON retrievals(fact_version_id, at);

CREATE TABLE IF NOT EXISTS meta (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL
);
${CLEANUP_VERDICTS_SQL}
${SEARCH_LOG_SQL}
${TOOL_CALLS_SQL}
CREATE VIEW IF NOT EXISTS current_fact_versions AS
  SELECT v.* FROM fact_versions v
  WHERE v.seq = (SELECT MAX(seq) FROM fact_versions WHERE fact_id = v.fact_id);
`;

/**
 * Schema 10 (technical/storage.md, "Tables"): the unique index on the minted `ref` of a result, and the indexes that find
 * the reads of a ref and the requests of a search. It is a separate statement because an older database gets its
 * columns from the migration, so `openStore` runs this after `migrate`.
 */
export const MINTED_REF_INDEX_SQL = `
CREATE UNIQUE INDEX IF NOT EXISTS search_results_by_ref ON search_results(ref);
CREATE INDEX IF NOT EXISTS retrievals_by_ref ON retrievals(ref);
CREATE INDEX IF NOT EXISTS change_requests_by_search ON change_requests(search_id);
`;

/**
 * Schema 6 (technical/storage.md, "Tables"): the index on the children of a request. It is a separate statement because a
 * schema 5 database gets its `parent_id` column from the migration, so `openStore` runs this after `migrate`.
 */
export const REQUEST_PARENT_INDEX_SQL =
  "CREATE INDEX IF NOT EXISTS change_requests_by_parent ON change_requests(parent_id);";

/** Bits in a byte: the 1-bit copy of a vector is stored in whole bytes, so the dimension is a multiple of this. */
const BITS_PER_BYTE = 8;

/**
 * technical/lookup.md, "Retrieval pipeline", speed path. The consumer search table. The KNN runs on a 1-bit copy of the vector (`embedding`),
 * which scans about 20 times faster than float at 100k. `full` holds the float vector as an
 * auxiliary column, so that the candidates of the KNN are rescored exactly in code.
 * The dimension must be a multiple of 8.
 *
 * @param dim - the embedding dimension; a positive multiple of 8
 * @returns the `CREATE VIRTUAL TABLE` statement for `current_vec`
 * @throws {Error} when `dim` is not a positive multiple of 8
 * @sideEffects none
 */
export function currentVecSql(dim: number): string {
  if (!Number.isInteger(dim) || dim <= 0 || dim % BITS_PER_BYTE !== 0)
    throw new Error(`invalid embedding dimension: ${dim}`);
  return `CREATE VIRTUAL TABLE IF NOT EXISTS current_vec USING vec0(
  fact_id    TEXT PRIMARY KEY,
  embedding  BIT[${dim}],
  +full      BLOB
);`;
}

/**
 * technical/storage.md, "Index tables". Builds the FTS and vector tables; the dimension follows the embedding model (O4).
 *
 * @param dim - the embedding dimension; a positive integer, a multiple of 8 for `current_vec`
 * @returns the SQL that creates the index tables when absent: one FTS table and two vector tables
 * @throws {Error} when `dim` is not a positive integer (or, for `current_vec`, not a multiple of 8)
 * @sideEffects none
 */
export function indexTablesSql(dim: number): string {
  if (!Number.isInteger(dim) || dim <= 0) throw new Error(`invalid embedding dimension: ${dim}`);
  return `
CREATE VIRTUAL TABLE IF NOT EXISTS fact_versions_fts USING fts5(
  header, content, content='fact_versions', content_rowid='id', tokenize='porter unicode61'
);
CREATE VIRTUAL TABLE IF NOT EXISTS fact_versions_vec USING vec0(
  fact_version_id INTEGER PRIMARY KEY,
  embedding  FLOAT[${dim}]
);
${currentVecSql(dim)}
`;
}
