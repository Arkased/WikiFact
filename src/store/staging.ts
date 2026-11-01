// technical/updates.md, "High volume mode", "Staging": the staging set of a batch is a set of `stg_*` tables in the live
// database. The requests of the batch write their changes there, and no read of the live wiki sees them. The reconciliation
// reads the live wiki plus the staging tables through the overlay store. The promotion copies the staging tables into the
// wiki in 1 transaction; its result depends on the staged rows, not on the order in which they were written.
import { MetaKey, RequestKind, StagedVectorKind } from "../domain/enums.js";
import { highestChangeSeq } from "./cleanup/state.js";
import { enqueueRequest, finishRequest } from "./queue.js";
import { openStore } from "./open.js";
import { columnList, createStagingTables, overlaySql } from "./stagingTables.js";
import { WRITTEN_TABLES, type WrittenTable } from "./writeNames.js";
import type { IndexedVersion, Store } from "./types/index.js";

/** The live wiki changed while a staging set of a batch existed, so the staging set cannot be promoted. */
export class LiveMovedError extends Error {}

/** A request that the promotion marks done, with the reason that Q7 gave when it rejected the submission. */
export interface PromotedRequest {
  id: string;
  error?: string;
}

/** The check of a prior query that a promotion queues: the search of the request should find the fact. */
export interface PriorQueryCheck {
  /** The search that the submitter ran before the request. */
  searchId: string;
  /** The fact that the search should find: a fact that is live after the promotion. */
  factId: string;
}

/** The options of `promoteStaging`. */
export interface PromoteOptions {
  /** The highest seq of the live wiki when the batch started; the live wiki must still be there. */
  startSeq: number;
  /** The requests of the staging set that the promotion marks done, in the same transaction. */
  done: PromotedRequest[];
  /**
   * The prior query checks of the requests of the batch (step 9). The promotion queues a lookupRepair request for each, in the
   * same transaction, so that no stop, crash or kill can lose them: the lookupRepair does the check when the worker reaches it.
   */
  priorChecks: PriorQueryCheck[];
  /** The clock for the finish time of the requests, in ms. */
  now: number;
}

// The staging tables that hold an autoincrement id, with the live table whose ids they continue.
const SEQUENCES = [
  { staged: "stg_changes", live: "changes", column: "seq" },
  { staged: "stg_fact_versions", live: "fact_versions", column: "id" },
] as const;

/**
 * Deletes every row of the staging tables, in 1 transaction.
 *
 * @param store - the open store with the write connection
 * @sideEffects deletes the rows of the `stg_*` tables and of `stg_vectors`
 */
export function clearStaging(store: Store): void {
  const { db } = store;
  db.transaction(() => {
    for (const t of WRITTEN_TABLES) db.prepare(`DELETE FROM stg_${t}`).run();
    db.prepare("DELETE FROM stg_vectors").run();
  }).immediate();
}

/**
 * Makes new, empty staging tables for a batch from the live tables as they are now, and sets their id sequences to the
 * highest live ids, so that a staged `seq` and a staged version id are above every live one and the promotion keeps them.
 *
 * @param store - the open store with the write connection
 * @throws {Error} when a live table is absent or its definition cannot be read
 * @sideEffects in 1 transaction, drops and creates the `stg_*` tables (`createStagingTables`), so a migration of a live table
 *   reaches them; writes the rows of `sqlite_sequence` of the 2 staging tables that have an id
 */
export function resetStaging(store: Store): void {
  const { db } = store;
  db.transaction(() => {
    createStagingTables(db, true);
    for (const s of SEQUENCES) {
      const row = db.prepare(`SELECT COALESCE(MAX(${s.column}), 0) AS top FROM ${s.live}`).get() as { top: number };
      db.prepare("DELETE FROM sqlite_sequence WHERE name = ?").run(s.staged);
      db.prepare("INSERT INTO sqlite_sequence(name, seq) VALUES (?, ?)").run(s.staged, row.top);
    }
  }).immediate();
}

/**
 * Counts the changes of the staging set.
 *
 * @param store - the open store
 * @returns the number of `stg_changes` rows
 * @sideEffects none (reads)
 */
export function countStagedChanges(store: Store): number {
  const row = store.db.prepare("SELECT COUNT(*) AS n FROM stg_changes").get() as { n: number };
  return row.n;
}

/**
 * Opens the overlay store of a batch: a second connection to the live database whose tables of a change (`facts`,
 * `fact_versions`, `changes` and the rest) are temporary views of the live rows plus the staged rows. Every read
 * of the store API on it sees the live wiki with the staging set applied; its writes go to the staging tables. It uses
 * the index writer of the live store, for the embeddings.
 *
 * @param live - the open live store; its database is a file
 * @returns the overlay store; the caller closes it with `closeStore`
 * @sideEffects opens a connection and creates the temporary views of it, with the columns of the live tables
 */
export function openOverlay(live: Store): Store {
  const store = openStore(live.db.name, { ...live.config, weights: live.weights });
  const { db } = store;
  db.exec(overlaySql(db));
  // The same text as the view of the wiki; a name inside a temporary view resolves to the temporary views above.
  db.exec(`CREATE TEMP VIEW current_fact_versions AS
    SELECT v.* FROM fact_versions v WHERE v.seq = (SELECT MAX(seq) FROM fact_versions WHERE fact_id = v.fact_id)`);
  return { ...store, indexWriter: live.indexWriter, overlay: true };
}

const asFloats = (blob: Buffer): Float32Array =>
  new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));

// The vectors for the one index call of the promotion, in the order of the versions; undefined when the staging set lacks
// one (a write without `prepare`), so that the index fills its FTS rows only.
function stagedVectors(live: Store, versions: IndexedVersion[]): { facts: Float32Array[] } | undefined {
  const get = live.db.prepare("SELECT embedding FROM stg_vectors WHERE kind = ? AND ref = ?");
  const facts: Float32Array[] = [];
  for (const v of versions) {
    const row = get.get(StagedVectorKind.Fact, v.versionId) as { embedding: Buffer } | undefined;
    if (row === undefined) return undefined;
    facts.push(asFloats(row.embedding));
  }
  return { facts };
}

// Copies the staged rows into the tables of the wiki, with the ids that the staging tables gave them. The columns are those of
// the live tables, so a column that a migration adds is copied too.
function copyRows(live: Store): void {
  const { db } = live;
  const copy = (table: WrittenTable, order: string): string => {
    const cols = columnList(db, table);
    return `INSERT INTO ${table}(${cols}) SELECT ${cols} FROM stg_${table} WHERE true ORDER BY ${order};`;
  };
  db.exec(`
    ${copy("change_requests", "received_at, rowid")}
    ${copy("changes", "seq")}
    ${copy("facts", "id")}
    ${copy("fact_versions", "id")}
    ${copy("fact_version_refs", "rowid")}
    ${copy("retrievals", "rowid")}`);
}

// The index rows of the whole staging set, in 1 call of the index writer of the live store. A fact version goes in the order
// of its id, so the last version of a fact decides its `current_vec` row.
function indexRows(live: Store, seq: number): void {
  const { db } = live;
  const versions = (
    db
      .prepare(
        `SELECT id AS versionId, fact_id AS factId, seq, header, content, is_deleted AS isDeleted
         FROM stg_fact_versions ORDER BY id`,
      )
      .all() as (Omit<IndexedVersion, "isDeleted"> & { isDeleted: number })[]
  ).map((v): IndexedVersion => ({ ...v, isDeleted: v.isDeleted === 1 }));
  live.indexWriter.write(db, { seq, versions }, stagedVectors(live, versions));
}

/**
 * Promotes the staging set to the live wiki, in 1 transaction: the staged rows are copied into the tables of the wiki with
 * the ids they have (the staging tables continue the live sequences, so the ids are above the live ones), the index rows of
 * the whole set are written in one call (the vectors come from `stg_vectors`, so the embedder does not run), the requests of
 * the batch are marked done, a lookupRepair request is queued for each prior query check, and the staging tables and the
 * start seq key are emptied. The result depends on the staged rows
 * only, not on the order in which they were written. The transaction is immediate, so no other connection writes between
 * the check and the end.
 *
 * @param live - the open live store with the write connection
 * @param opts - the start seq, the requests to mark done, the prior query checks to queue and the clock
 * @returns the number of changes promoted
 * @throws {LiveMovedError} when the live wiki holds a change above the start seq: nothing is written
 * @sideEffects one immediate transaction on the live store writes the staged changes, facts, versions, links,
 *   retrievals, requests and index rows, deletes the staged rows and the start seq key, sets the status of the done
 *   requests and inserts one queued lookupRepair row for each prior query check; rolls back on any failure
 */
export function promoteStaging(live: Store, opts: PromoteOptions): number {
  const { db } = live;
  const run = db.transaction((): number => {
    const seq = highestChangeSeq(live);
    if (seq !== opts.startSeq) {
      throw new LiveMovedError(`the live wiki is at seq ${seq}, the staging set started at ${opts.startSeq}`);
    }
    const count = countStagedChanges(live);
    const top = db.prepare("SELECT COALESCE(MAX(seq), 0) AS top FROM stg_changes").get() as { top: number };
    copyRows(live);
    indexRows(live, top.top);
    for (const r of opts.done) finishRequest(live, r.id, opts.now, r.error);
    for (const c of opts.priorChecks) {
      enqueueRequest(live, { kind: RequestKind.LookupRepair, targets: [c.factId], searchId: c.searchId }, opts.now);
    }
    for (const t of WRITTEN_TABLES) db.prepare(`DELETE FROM stg_${t}`).run();
    db.prepare("DELETE FROM stg_vectors").run();
    db.prepare("DELETE FROM meta WHERE key = ?").run(MetaKey.BatchStartSeq);
    return count;
  });
  return run.immediate();
}
