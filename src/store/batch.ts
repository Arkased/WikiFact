// technical/updates.md, "High volume mode": what the store keeps for a batch that runs the pipeline of 1 request at a time
// in parallel and stages its changes in the staging tables (staging.ts). The batch has the meta key of its start seq, the stale
// check of a write and the list of the facts that it created.
import { z } from "zod";
import { BatchReconciliation, MetaKey } from "../domain/enums.js";
import { must } from "../must.js";
import type { ChangeSet, Store } from "./types/index.js";

// The requests of a batch: the queue rows of the live wiki plus the rows that the batch itself staged (the children of a split).
// The overlay views do not show `change_requests`, so a query that needs the queue time of a staged request names both tables.
const REQUESTS_OF_BATCH = `(SELECT id, received_at FROM main.change_requests
  UNION ALL SELECT id, received_at FROM main.stg_change_requests)`;

/** The stale check of one write: the facts that the request rests on, and the seq at which it read them. */
export interface FreshCheck {
  /** The highest live seq at the gather of the request; a live version above it is a change after the gather. */
  afterSeq: number;
  /** The facts that the change set writes, the live facts of the scope and the target facts. */
  factIds: string[];
  /** The requests whose staged versions do not count as a change: the requests of the group of the writer. */
  group?: string[];
}

/** Thrown inside the write transaction when another request changed a fact of the check after the gather. */
export class StaleChangeError extends Error {
  /** The facts that changed after the gather, or that a reference of the draft rests on and that are deleted now. */
  readonly factIds: string[];

  /**
   * Creates the error.
   *
   * @param factIds - the facts of the check that another request staged a version of, and the deleted facts that a draft references
   */
  constructor(factIds: string[]) {
    super(`${factIds.length} fact(s) changed after the gather: ${factIds.join(", ")}`);
    this.factIds = factIds;
  }
}

/**
 * Lists the facts of the check that another writer changed after the gather: a live version above the seq of the gather, or
 * a version in the staging tables that a change of another request wrote.
 *
 * @param store - the overlay store of the batch
 * @param check - the facts and the seq of the gather
 * @param requestId - the request that checks; its own staged versions and those of `check.group` do not count
 * @returns the ids of the facts changed by another writer, in id order; empty when none
 * @sideEffects none (reads)
 */
export function factsChangedSince(store: Store, check: FreshCheck, requestId: string): string[] {
  const rows = store.db
    .prepare(
      `SELECT id FROM (
         SELECT fact_id AS id FROM main.fact_versions
         WHERE fact_id IN (SELECT value FROM json_each(@ids)) AND seq > @after
         UNION
         SELECT v.fact_id AS id FROM main.stg_fact_versions v JOIN main.stg_changes c ON c.seq = v.seq
         WHERE v.fact_id IN (SELECT value FROM json_each(@ids)) AND c.request_id <> @req
           AND c.request_id NOT IN (SELECT value FROM json_each(@group))
       ) ORDER BY id`,
    )
    .all({
      ids: JSON.stringify(check.factIds),
      after: check.afterSeq,
      req: requestId,
      group: JSON.stringify(check.group ?? []),
    }) as { id: string }[];
  return rows.map((r) => r.id);
}

// The facts that a live draft of the change set references and that are deleted now, outside the change set itself.
function deletedReferences(store: Store, cs: ChangeSet): string[] {
  const inChange = new Set(cs.facts.flatMap((d) => (d.factId === undefined ? [] : [d.factId])));
  const refs = new Set(cs.facts.flatMap((d) => (d.isDeleted === true ? [] : d.references)));
  const current = store.db.prepare("SELECT is_deleted AS isDeleted FROM current_fact_versions WHERE fact_id = ?");
  return [...refs].filter((id) => {
    if (inChange.has(id)) return false;
    const row = current.get(id) as { isDeleted: number } | undefined;
    return row?.isDeleted === 1;
  });
}

/**
 * Checks the stale check of a write inside its transaction: another request of the batch changed, after the gather, a
 * fact of the check or a fact that a draft references; or a draft references a deleted fact.
 *
 * @param store - the overlay store, with the write transaction open
 * @param cs - the change set about to be written
 * @param check - the facts and the seq of the gather
 * @param requestId - the request that writes; its own staged rows do not make it stale
 * @returns the error to throw; null when the write is fresh
 * @sideEffects none (reads)
 */
export function staleness(store: Store, cs: ChangeSet, check: FreshCheck, requestId: string): StaleChangeError | null {
  const refs = cs.facts.flatMap((d) => (d.isDeleted === true ? [] : d.references));
  const changed = factsChangedSince(store, { ...check, factIds: [...new Set([...check.factIds, ...refs])] }, requestId);
  const dead = deletedReferences(store, cs);
  const factIds = [...new Set([...changed, ...dead])].sort();
  return factIds.length === 0 ? null : new StaleChangeError(factIds);
}

/**
 * Reads the seq at which the running batch started.
 *
 * @param store - the open store
 * @returns the seq; undefined when no staging set of a batch exists
 * @sideEffects none (reads)
 */
export function readBatchStartSeq(store: Store): number | undefined {
  const row = store.db.prepare("SELECT value FROM meta WHERE key = ?").get(MetaKey.BatchStartSeq) as
    { value: string } | undefined;
  if (row === undefined) return undefined;
  const seq = Number(row.value);
  return Number.isInteger(seq) ? seq : undefined;
}

/**
 * Records the seq at which a batch started: the key says that a staging set of a batch exists.
 *
 * @param store - the open store with the write connection
 * @param seq - the highest seq of the live wiki when the batch started
 * @sideEffects one upsert on the `meta` table
 */
export function writeBatchStartSeq(store: Store, seq: number): void {
  store.db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)").run(MetaKey.BatchStartSeq, String(seq));
}

/**
 * Deletes the key of the batch start seq, when the batch has ended or its staging set was dropped.
 *
 * @param store - the open store with the write connection
 * @sideEffects one delete on the `meta` table; none when the key is absent
 */
export function clearBatchStartSeq(store: Store): void {
  store.db.prepare("DELETE FROM meta WHERE key = ?").run(MetaKey.BatchStartSeq);
}

/**
 * Reads the request of the operator to start a batch at once (technical/console.md, "Service health", "Run a batch now").
 *
 * @param store - an open store, read-only or not
 * @returns `{ at }` (the ms of the click); undefined when the key is absent
 * @throws {Error} when the stored value is not JSON of the shape `{ at: number }`
 * @sideEffects none (reads)
 */
export function readBatchNow(store: Store): { at: number } | undefined {
  const row = store.db.prepare("SELECT value FROM meta WHERE key = ?").get(MetaKey.BatchNow) as
    { value: string } | undefined;
  if (row === undefined) return undefined;
  return batchNowSchema.parse(JSON.parse(row.value));
}

/**
 * Asks the worker to start a batch with the queued submissions at its next poll.
 *
 * @param store - the open store with the write connection
 * @param at - the time of the click in ms
 * @sideEffects one upsert on the `meta` table
 */
export function writeBatchNow(store: Store, at: number): void {
  store.db
    .prepare("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(MetaKey.BatchNow, JSON.stringify({ at }));
}

/**
 * Deletes the request for a batch at once, when the worker has taken it.
 *
 * @param store - the open store with the write connection
 * @sideEffects one delete on the `meta` table; none when the key is absent
 */
export function clearBatchNow(store: Store): void {
  store.db.prepare("DELETE FROM meta WHERE key = ?").run(MetaKey.BatchNow);
}

const batchNowSchema = z.object({ at: z.number() });

/** What the Operation page shows of the newest batch. */
export interface BatchProgress {
  /** The requests that the batch took. */
  taken: number;
  /** The requests that ended. */
  done: number;
  /** The changes in the staging set: the writes of the requests and the merges of the reconciliation. */
  staged: number;
  /** The requests whose first write was refused as stale. */
  stale: number;
  reconciliation: BatchReconciliation;
}

const progressSchema: z.ZodType<BatchProgress> = z.object({
  taken: z.number().int(),
  done: z.number().int(),
  staged: z.number().int(),
  stale: z.number().int(),
  reconciliation: z.enum(BatchReconciliation),
});

/**
 * Reads the progress of the newest batch.
 *
 * @param store - an open store, read-only or not
 * @returns the progress; undefined when no batch has run or the stored value does not parse
 * @sideEffects none (reads)
 */
export function readBatchProgress(store: Store): BatchProgress | undefined {
  const row = store.db.prepare("SELECT value FROM meta WHERE key = ?").get(MetaKey.BatchProgress) as
    { value: string } | undefined;
  if (row === undefined) return undefined;
  try {
    const parsed = progressSchema.safeParse(JSON.parse(row.value));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Writes the progress of the running batch, replacing the earlier one.
 *
 * @param store - the open store with the write connection
 * @param progress - the counts and the state of the reconciliation
 * @sideEffects one upsert on the `meta` table
 */
export function writeBatchProgress(store: Store, progress: BatchProgress): void {
  store.db
    .prepare("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(MetaKey.BatchProgress, JSON.stringify(progress));
}

/** A fact that the staging tables hold a version of, with the request that wrote its first staged version. */
export interface StagedFact {
  factId: string;
  /** The request whose change wrote the first staged version. */
  requestId: string;
  /** True when the batch created the fact (a row in `stg_facts`); false when the batch edits or deletes a live fact. */
  isNew: boolean;
}

/**
 * Lists the facts that the staging tables hold a version of: the facts that the batch created and the live facts that it
 * edits or deletes. They are in the order of their requests in the queue, then by id. The order does not depend on the
 * order in which the requests wrote.
 *
 * @param store - the open store
 * @returns the staged facts, live or deleted now
 * @sideEffects none (reads)
 */
export function stagedFacts(store: Store): StagedFact[] {
  const rows = store.db
    .prepare(
      `SELECT v.fact_id AS factId, c.request_id AS requestId,
              EXISTS (SELECT 1 FROM stg_facts WHERE id = v.fact_id) AS isNew
       FROM stg_fact_versions v
       JOIN stg_changes c ON c.seq = v.seq
       JOIN ${REQUESTS_OF_BATCH} r ON r.id = c.request_id
       WHERE v.seq = (SELECT MIN(seq) FROM stg_fact_versions WHERE fact_id = v.fact_id)
       ORDER BY r.received_at, r.id, v.fact_id`,
    )
    .all() as { factId: string; requestId: string; isNew: number }[];
  return rows.map((r) => ({ ...r, isNew: r.isNew === 1 }));
}

// The age of a fact in a batch: a live fact is older than a staged one, the live ones by the seq of their first version, the
// staged ones by the queue time of the request that created them.
function ageOf(store: Store, id: string): [number, number] {
  const live = store.db.prepare("SELECT MIN(seq) AS seq FROM main.fact_versions WHERE fact_id = ?").get(id) as {
    seq: number | null;
  };
  if (live.seq !== null) return [0, live.seq];
  const staged = store.db
    .prepare(
      `SELECT r.received_at AS at FROM main.stg_fact_versions v
       JOIN main.stg_changes c ON c.seq = v.seq JOIN ${REQUESTS_OF_BATCH} r ON r.id = c.request_id
       WHERE v.fact_id = ? ORDER BY v.seq LIMIT 1`,
    )
    .get(id) as { at: number } | undefined;
  // A fact without a live version is one the batch created, so it has a staged version.
  return [1, must(staged, `fact ${id} has no live and no staged version`).at];
}

/**
 * Orders 2 facts as the duplicate fact check does: the one whose first version has the lower seq comes first, then the lower id.
 * On the overlay store of a batch a live fact comes before a staged fact, and 2 staged facts are ordered by the queue time
 * of their requests, so that the order does not depend on the order of the staged writes.
 *
 * @param store - the open store
 * @param a - a fact id
 * @param b - another fact id
 * @returns the 2 ids, the older first
 * @sideEffects none (reads)
 */
export function olderFirst(store: Store, a: string, b: string): [string, string] {
  let sa: [number, number];
  let sb: [number, number];
  if (store.overlay === true) {
    sa = ageOf(store, a);
    sb = ageOf(store, b);
  } else {
    const first = store.db.prepare("SELECT MIN(seq) AS seq FROM fact_versions WHERE fact_id = ?");
    sa = [0, (first.get(a) as { seq: number | null }).seq ?? 0];
    sb = [0, (first.get(b) as { seq: number | null }).seq ?? 0];
  }
  const before = sa[0] !== sb[0] ? sa[0] < sb[0] : sa[1] !== sb[1] ? sa[1] < sb[1] : a < b;
  return before ? [a, b] : [b, a];
}
