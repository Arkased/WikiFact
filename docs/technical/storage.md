# Storage

Technical layer. The requirements are in [../requirements/README.md](../requirements/README.md). The design is in [../design/README.md](../design/README.md).

The database is SQLite in WAL mode. Each MCP request gets its own read connection. The worker process owns the write connection for the wiki. Each MCP server process has one more write connection, used for 2 things only: the queue row that `requestChange` inserts, and the retrieval rows that `getFact` inserts. Every connection sets `busy_timeout` to 5000 ms, so a queue insert during a worker transaction waits instead of failing.

## Tables

```sql
CREATE TABLE facts (
  id          TEXT PRIMARY KEY,          -- ULID
  created_at  INTEGER NOT NULL           -- unix ms
);

CREATE TABLE changes (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,  -- global sequence number
  request_id    TEXT NOT NULL REFERENCES change_requests(id),
  outcome       TEXT NOT NULL CHECK (outcome IN ('accepted','duplicate','rejected','split')),
  reject_reason TEXT CHECK (reject_reason IN ('unsupported','contradicted','compound')),
  summary       TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  duplicate_of  TEXT                     -- the id of the fact that a `duplicate` change confirmed; NULL on every other outcome
);

CREATE TABLE fact_versions (
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
CREATE INDEX fact_versions_by_fact ON fact_versions(fact_id, seq DESC);

-- The facts a fact version depends on.
CREATE TABLE fact_version_refs (
  fact_version_id  INTEGER NOT NULL REFERENCES fact_versions(id),
  ref_fact_id      TEXT NOT NULL REFERENCES facts(id),
  PRIMARY KEY (fact_version_id, ref_fact_id)
);
CREATE INDEX fact_version_refs_by_target ON fact_version_refs(ref_fact_id);

-- One MCP session of one client (Search log and sessions (lookup.md)). The wiki is implicit: 1 database holds 1 wiki.
CREATE TABLE sessions (
  id              TEXT PRIMARY KEY,      -- the MCP session id (the `Mcp-Session-Id` header; a ULID on stdio)
  started_at      INTEGER NOT NULL,
  last_call_at    INTEGER NOT NULL,      -- starts equal to started_at
  ended_at        INTEGER,               -- NULL while the session is open
  client_name     TEXT,                  -- `clientInfo.name` of the initialize request; NULL when the client sends none
  client_version  TEXT,                  -- `clientInfo.version`; NULL when the client sends none
  call_count      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX sessions_by_started ON sessions(started_at);

-- One consumer `search` call. The console search writes none.
CREATE TABLE searches (
  id            TEXT PRIMARY KEY,        -- ULID, so the id order is the time order
  session_id    TEXT REFERENCES sessions(id),  -- NULL for a call with no session
  query         TEXT NOT NULL,
  at            INTEGER NOT NULL,
  duration_ms   INTEGER NOT NULL,
  result_count  INTEGER NOT NULL
);
CREATE INDEX searches_by_session ON searches(session_id, at);

-- The facts that a search listed, best first.
CREATE TABLE search_results (
  search_id  TEXT NOT NULL REFERENCES searches(id),
  kind       TEXT NOT NULL CHECK (kind IN ('fact')),
  target_id  TEXT NOT NULL,              -- the fact id
  rank       INTEGER NOT NULL,           -- 1 for the first result
  ref        TEXT NOT NULL,              -- the id that the search minted for this result (a ULID), unique over the wiki
  PRIMARY KEY (search_id, kind, target_id)
);
CREATE INDEX search_results_by_target ON search_results(kind, target_id, search_id);
CREATE UNIQUE INDEX search_results_by_ref ON search_results(ref);

-- One model call of the worker (Model call rows (updates.md)).
CREATE TABLE model_calls (
  id                  TEXT PRIMARY KEY,  -- ULID
  request_id          TEXT NOT NULL REFERENCES change_requests(id),
  question            TEXT NOT NULL,     -- the question name, for example 'Q4'
  model               TEXT NOT NULL,
  effort              TEXT NOT NULL,
  tokens_in           INTEGER NOT NULL,
  tokens_out          INTEGER NOT NULL,
  tokens_cache_read   INTEGER NOT NULL,
  tokens_cache_write  INTEGER NOT NULL,
  duration_ms         INTEGER NOT NULL,
  at                  INTEGER NOT NULL
);
CREATE INDEX model_calls_by_request ON model_calls(request_id);

-- One wiki tool call of an MCP endpoint (Endpoint counters (deployment.md)). The 4 management tools write none.
CREATE TABLE tool_calls (
  at           INTEGER NOT NULL,  -- ms since the epoch
  tool         TEXT NOT NULL,     -- a wiki tool name: search, getFact, requestChange, getRequest
  ok           INTEGER NOT NULL,  -- 1, or 0 for a thrown error or a tool result with isError
  duration_ms  INTEGER NOT NULL   -- rounded
);
CREATE INDEX tool_calls_by_at ON tool_calls(at);

CREATE TABLE retrievals (
  fact_version_id  INTEGER NOT NULL REFERENCES fact_versions(id),
  at               INTEGER NOT NULL,
  kind             TEXT NOT NULL DEFAULT 'read' CHECK (kind IN ('read','confirm')),
  weight           REAL NOT NULL DEFAULT 1,  -- more than 1 only on a folded row
  ref              TEXT REFERENCES search_results(ref)  -- the ref the read came by; NULL on a read by id and on a confirm
);
CREATE INDEX retrievals_by_fact_version ON retrievals(fact_version_id, at);
CREATE INDEX retrievals_by_ref ON retrievals(ref);

CREATE TABLE change_requests (
  id            TEXT PRIMARY KEY,        -- ULID
  kind          TEXT NOT NULL DEFAULT 'submission'
                CHECK (kind IN ('submission','lookupRepair','operatorEdit','cleanupRepair')),
  status        TEXT NOT NULL CHECK (status IN ('queued','running','done','failed')),
  change        TEXT,                    -- NULL on a lookupRepair row
  targets       TEXT NOT NULL,           -- JSON array of ids
  justification TEXT,                    -- NULL on a lookupRepair row
  attempts      INTEGER NOT NULL DEFAULT 0,
  received_at   INTEGER NOT NULL,
  started_at    INTEGER,                 -- set by the worker when it takes the row
  finished_at   INTEGER,
  error         TEXT,
  parent_id     TEXT REFERENCES change_requests(id),  -- the submission that a split made this row from; NULL otherwise
  session_id    TEXT REFERENCES sessions(id),  -- the session of the requestChange call; NULL for a call with no session and an operator edit
  search_id     TEXT REFERENCES searches(id)   -- the search this change follows; NULL when the call named none
);
CREATE INDEX change_requests_by_search ON change_requests(search_id);
CREATE INDEX change_requests_by_status ON change_requests(status, received_at);
CREATE INDEX change_requests_by_parent ON change_requests(parent_id);

-- A cleanup candidate that the model judged and that needed no change (Cleanup (cleanup.md)). The finder skips a
-- candidate while no fact in `subject` has a version above `seq`.
CREATE TABLE cleanup_verdicts (
  finder   TEXT NOT NULL CHECK (finder IN ('duplicateFact')),
  subject  TEXT NOT NULL,                -- the sorted fact ids of the candidate, joined by spaces
  seq      INTEGER NOT NULL,             -- the wiki sequence number when the model judged it
  at       INTEGER NOT NULL,
  PRIMARY KEY (finder, subject)
);

-- Embedding model name, schema version.
CREATE TABLE meta (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL
);
```

A request with a `parent_id` is a child and is never split again ([Split of a compound submission](submit.md#split-of-a-compound-submission), [Pipeline](updates.md#pipeline) step 1); `getRequest` lists the children of a parent by `parent_id`. The design of the search log and the sessions is in [Search log and sessions](../design/lookup.md#search-log-and-sessions), [Known cost](../design/updates.md#known-cost) and [MCP sessions](../design/deployment.md#mcp-sessions). A read with a NULL `ref` is an unlinked read ([Search log and sessions](lookup.md#search-log-and-sessions)). `search_results.target_id` has no foreign key. The link of a read to its search is the `ref` of the read, which names 1 `search_results` row ([Minted ids](../design/lookup.md#search-log-and-sessions)). A `lookupRepair` request without a `search_id` ends with the skip reason "no searchId", and a `submission` without one skips the prior-query check ([Step 9. Prior query check](updates.md#step-9-prior-query-check)). The service deletes the `tool_calls` rows older than 7 days once a day (`TOOL_CALL_RETENTION_MS` in `src/store/toolCalls.ts`).

Schema versions and migrations: `meta.schema_version` holds the number; `SCHEMA_VERSION` in `src/store/schema.ts` is 17. A new database is created at that version. `openStore` applies the numbered migrations above the stored version in order, each in one transaction, and sets the number after each. A migration rebuilds a table with every row copied when SQLite cannot alter a constraint in place; it never loses a row of the current kinds. A store whose version is above the code's is refused with a message. A store below `OLDEST_SCHEMA_VERSION` (15) is refused with a `StoreMismatchError`: "migrates from schema 15. Migrate the database with an earlier release first." The migration `migrateToSchema16` in `src/store/migrations.ts`, moves a database of schema 15 to 16 on open: it drops the 6 tables of a removed feature, with their indexes and their search index tables, and rebuilds `search_results` (the rows of kind `fact` are copied), `cleanup_verdicts` (the rows of the finder `duplicateFact` are copied) and `change_requests` (every row is copied, and the request kind of the old cleanup repair becomes `cleanupRepair`), each from the current definition. `migrateToSchema17` deletes the meta key `high_volume` of the removed threshold mode. Each migration checks the foreign keys before it commits and rolls back on a violation.

## Staging tables

The staging set of a batch ([High volume mode](updates.md#high-volume-mode)) is a set of tables in the live database. They are derived from the definitions of the live tables, not written by hand: `createStagingTables` (`src/store/stagingTables.ts`) builds each staging table from `PRAGMA table_info`, `index_list` and `index_info` of the live table (no text of `sqlite_master.sql` is edited; the stored statement is only tested for the keyword AUTOINCREMENT, which no pragma reports). `openStore` creates the tables that are absent; `resetStaging` drops and recreates them all, so a staging table never drifts from the live table after a migration. They add no schema version. They are empty outside a batch. The start of a running batch is the meta key `batch_start_seq`, not a table. It exists while the staging rows of the batch exist ([High volume mode](updates.md#high-volume-mode)). A crash leaves the rows and the key; the next batch step deletes both.

| Staging table | Same columns as | Note |
| --- | --- | --- |
| `stg_changes` | `changes` | `seq` is AUTOINCREMENT |
| `stg_facts` | `facts` | |
| `stg_fact_versions` | `fact_versions` | `id` is AUTOINCREMENT |
| `stg_fact_version_refs` | `fact_version_refs` | |
| `stg_retrievals` | `retrievals` | the confirm of a duplicate |
| `stg_change_requests` | `change_requests` | the requests that only the batch holds (the children of a split) |
| `stg_vectors` | none: `(kind, ref, embedding)` | the embedding of a staged fact version (`kind` `fact`, `ref` the version id); the promotion hands them to the index writer |

A staging table has the columns, NOT NULL, DEFAULT, PRIMARY KEY, AUTOINCREMENT and UNIQUE constraints of the live table (a staged row has a new id, seq or version number, so a UNIQUE key such as `(fact_id, seq)` holds among staged rows). It has no foreign key and no CHECK (they are never copied, so no syntax of a foreign key can reach it), and no index other than the UNIQUE constraints, because a row can name a live row (a staged version of a live fact). `stg_vectors` is the one table with its own definition; it has a CHECK on `kind` (`StagedVectorKind`). The index tables have no staging table: a staged row is not searchable, and the promotion writes the index rows.

**Ids.** `resetStaging` sets the `sqlite_sequence` of `stg_changes` and `stg_fact_versions` to the highest live value, so a staged `seq` and version id are above each live one and the promotion copies them as they are. The promotion refuses (`LiveMovedError`) when the live wiki wrote a change after the start of the batch, which keeps the staged ids from meeting a live id.

**The overlay.** The overlay store (`openOverlay` in `src/store/staging.ts`) is a second connection to the database file. Its temporary views (`overlaySql` in `src/store/stagingTables.ts`, built from the columns of the live tables) have the names of the tables `changes`, `facts`, `fact_versions`, `fact_version_refs` and `retrievals`, and return the live rows plus the staged rows. The views are temporary, so no migration of a live table meets them and no other connection sees them. A name with the prefix `main.` still reads the live table. The write layer takes the target from `writeNames(store)`: the overlay store writes to `stg_*`, any other store to the live table.

## Index tables

```sql
CREATE VIRTUAL TABLE fact_versions_fts USING fts5(
  header, content, content='fact_versions', content_rowid='id', tokenize='porter unicode61'
);
-- Every fact version. The agent search with history reads this one.
CREATE VIRTUAL TABLE fact_versions_vec USING vec0(
  fact_version_id INTEGER PRIMARY KEY,
  embedding  FLOAT[384]
);
-- The current version of each live fact. The consumer search reads this one.
-- A KNN ranks inside the virtual table, so a filter after the KNN returns fewer than K rows.
-- This table holds only the rows the consumer search wants, so no filter is needed.
-- The KNN runs on a 1-bit copy of the vector, which scans about 20 times faster than float at 100k.
-- The float vector is kept in the auxiliary column `full`, and the search rescores the candidates with it.
CREATE VIRTUAL TABLE current_vec USING vec0(
  fact_id    TEXT PRIMARY KEY,
  embedding  BIT[384],
  +full      BLOB
);
```

The vector dimension follows the embedding model ([O4](README.md#open-settings)): 384 for the default. The embedded text of a fact version is `header + ". " + content`. sqlite-vec takes an embedding as a `Float32Array` buffer, not as a JSON array. The `embedding` of `current_vec` is `vec_quantize_binary` of the float vector, so the dimension must be a multiple of 8. `fact_versions_vec` stays float.

A deletion version copies `header` and `content` from the version before it, so both columns stay `NOT NULL` and the FTS and vector rows of the deletion match the deleted text.

## Current state

The current fact version of a fact is the row with the largest `seq` for that `fact_id`:

```sql
CREATE VIEW current_fact_versions AS
  SELECT v.* FROM fact_versions v
  WHERE v.seq = (SELECT MAX(seq) FROM fact_versions WHERE fact_id = v.fact_id);
```

A fact is live when its current fact version has `is_deleted = 0`. Consumer reads use the view and filter deleted facts. The update agent reads all fact versions.

## Tests

Design: The store has no design file of its own. It is a unit test, and it runs in `npm run check`, not in `npm run eval:all`.

| Test | Requirement | Method | Pass condition |
|---|---|---|---|
| Store | all | Unit tests on the Store API with in-memory SQLite: version chain, delete, dependents, rollback, sequence numbers. | All pass. |
