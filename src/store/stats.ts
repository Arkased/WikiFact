import {
  ChangeOutcome,
  RequestStatus,
  type RejectReason,
  type RequestKind,
  type RetrievalKind,
} from "../domain/enums.js";
import { listChildIds } from "./queue.js";
import { inList } from "./sql.js";
import type { Store } from "./types/index.js";

/** The filter of `countRetrievals`. */
export interface CountRetrievalsOptions {
  /** Count only rows with `at` at or after this time, in ms since the epoch. Default: all rows. */
  since?: number;
  /** Count only rows of this kind. Default: every kind. */
  kind?: RetrievalKind;
  /** Count only rows on a version of one of these facts (any version, not only the current one). Default: every fact. */
  factIds?: string[];
}

/**
 * Counts `retrievals` rows, for the eval reports.
 *
 * @param store - the open store
 * @param opts - the time, kind and fact filters; a filter that is absent does not restrict
 * @returns the number of rows that match every filter given; 0 for an empty `factIds`
 * @sideEffects none (reads)
 */
export function countRetrievals(store: Store, opts: CountRetrievalsOptions = {}): number {
  if (opts.factIds?.length === 0) return 0;
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (opts.since !== undefined) {
    where.push("r.at >= ?");
    args.push(opts.since);
  }
  if (opts.kind !== undefined) {
    where.push("r.kind = ?");
    args.push(opts.kind);
  }
  if (opts.factIds !== undefined) {
    where.push(`v.fact_id IN (${inList(opts.factIds.length)})`);
    args.push(...opts.factIds);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const row = store.db
    .prepare(`SELECT COUNT(*) AS n FROM retrievals r JOIN fact_versions v ON v.id = r.fact_version_id ${clause}`)
    .get(...args) as { n: number };
  return row.n;
}

/** The current version of one fact, as the eval checks read it. */
export interface CurrentFactRow {
  fact_id: string;
  header: string;
  content: string;
  /** 1 when the current version is a deletion, else 0. */
  is_deleted: number;
  seq: number;
}

/**
 * Lists the current version of every fact, the deleted ones included.
 *
 * @param store - the open store
 * @returns one row per fact
 * @sideEffects none (reads)
 */
export function listCurrentFacts(store: Store): CurrentFactRow[] {
  return store.db
    .prepare("SELECT fact_id, header, content, is_deleted, seq FROM current_fact_versions")
    .all() as CurrentFactRow[];
}

/**
 * Gives the `seq` of the first version of each fact, so that a reader tells a fact written after a position from an older
 * fact that got a new version after it.
 *
 * @param store - the open store
 * @returns the first `seq` per fact id
 * @sideEffects none (reads)
 */
export function firstSeqOfFacts(store: Store): Map<string, number> {
  const rows = store.db.prepare("SELECT fact_id, MIN(seq) AS first_seq FROM fact_versions GROUP BY fact_id").all() as {
    fact_id: string;
    first_seq: number;
  }[];
  return new Map(rows.map((r) => [r.fact_id, r.first_seq]));
}

/**
 * Counts the facts, the deleted ones included.
 *
 * @param store - the open store
 * @returns the number of rows in `facts`
 * @sideEffects none (reads)
 */
export function countFacts(store: Store): number {
  return (store.db.prepare("SELECT COUNT(*) AS n FROM facts").get() as { n: number }).n;
}

/**
 * Counts the live facts: those whose current version is not a deletion.
 *
 * @param store - the open store
 * @returns the number of facts that a search can return
 * @sideEffects none (reads)
 */
export function countLiveFacts(store: Store): number {
  const row = store.db.prepare("SELECT COUNT(*) AS n FROM current_fact_versions WHERE is_deleted = 0").get() as {
    n: number;
  };
  return row.n;
}

/**
 * Counts the requests that wait for the worker.
 *
 * @param store - the open store
 * @returns the number of `change_requests` rows with status `queued`; a `running` row is not counted
 * @sideEffects none (reads)
 */
export function countQueued(store: Store): number {
  const row = store.db
    .prepare("SELECT COUNT(*) AS n FROM change_requests WHERE status = ?")
    .get(RequestStatus.Queued) as { n: number };
  return row.n;
}

/**
 * Counts the versions of a fact, the deleted ones included.
 *
 * @param store - the open store
 * @param factId - the fact id
 * @returns the number of `fact_versions` rows of the fact; 0 for an unknown id
 * @sideEffects none (reads)
 */
export function countVersions(store: Store, factId: string): number {
  const row = store.db.prepare("SELECT COUNT(*) AS n FROM fact_versions WHERE fact_id = ?").get(factId) as {
    n: number;
  };
  return row.n;
}

/**
 * Lists the ids of the requests of one kind, oldest first. Read each with `getRequest`.
 *
 * @param store - the open store
 * @param kind - the request kind
 * @returns the ids ordered by receive time, then by id
 * @sideEffects none (reads)
 */
export function listRequestIds(store: Store, kind: RequestKind): string[] {
  const rows = store.db.prepare("SELECT id FROM change_requests WHERE kind = ? ORDER BY received_at, id").all(kind) as {
    id: string;
  }[];
  return rows.map((r) => r.id);
}

/** What the store recorded for a request: the last `changes` row that names it, and the facts it wrote. */
export interface RequestChange {
  outcome: ChangeOutcome;
  /** The `changes.created_at` of the row, in ms since the epoch. */
  createdAt: number;
  /** For a duplicate outcome, the id of the fact that the request duplicates. */
  duplicateOf?: string;
  /** For a rejected outcome, the reason of the rejection. */
  rejectReason?: RejectReason;
  /** The ids of the facts that the change wrote (new facts or new versions); empty for a duplicate or a rejection. */
  factIds: string[];
  /** For a split outcome, the ids of the child requests in claim order; empty for every other outcome. */
  childIds: string[];
}

/**
 * Reads the change that a request produced. A request that merged facts first has one earlier `changes` row per
 * merge; the last row is the request's own change.
 *
 * @param store - the open store
 * @param requestId - the id of a `change_requests` row
 * @returns the outcome, time, duplicated fact and written facts of the last `changes` row of the request, or null
 *   when it has none (it is still queued or running, failed, or an unknown id); `duplicateOf` is
 *   `changes.duplicate_of`, set for a duplicate outcome only; `childIds` lists the children of a split
 * @sideEffects none (reads)
 */
export function getChangeForRequest(store: Store, requestId: string): RequestChange | null {
  const row = store.db
    .prepare(
      "SELECT seq, outcome, created_at, duplicate_of, reject_reason FROM changes WHERE request_id = ? ORDER BY seq DESC LIMIT 1",
    )
    .get(requestId) as
    | {
        seq: number;
        outcome: ChangeOutcome;
        created_at: number;
        duplicate_of: string | null;
        reject_reason: RejectReason | null;
      }
    | undefined;
  if (!row) return null;
  const factRows = store.db.prepare("SELECT fact_id FROM fact_versions WHERE seq = ? ORDER BY id ASC").all(row.seq) as {
    fact_id: string;
  }[];
  const change: RequestChange = {
    outcome: row.outcome,
    createdAt: row.created_at,
    factIds: factRows.map((r) => r.fact_id),
    childIds: row.outcome === ChangeOutcome.Split ? listChildIds(store, requestId) : [],
  };
  if (row.duplicate_of !== null) change.duplicateOf = row.duplicate_of;
  if (row.reject_reason !== null) change.rejectReason = row.reject_reason;
  return change;
}

/** The number of done requests that `queueStats` averages over. */
const QUEUE_DURATION_SAMPLE = 10;

/** The state of the queue as a submitter sees it. */
export interface QueueStats {
  /** The number of `queued` requests; a running one is not counted. */
  queued: number;
  /**
   * The mean of `finished_at - started_at` over the last `QUEUE_DURATION_SAMPLE` done requests, in ms. Absent when
   * no done request has both times (rows finished before schema 2 have no `started_at`).
   */
  meanDurationMs?: number;
  /** The `received_at` of the oldest `queued` request, in ms since the epoch. Absent when nothing is queued. */
  oldestQueuedAt?: number;
}

/**
 * Reads the queue length, the mean processing time of the last done requests and the age of the queue's head.
 *
 * @param store - the open store
 * @returns the queued count; the mean duration when done rows have both times; the receive time of the oldest
 *   queued request when one is queued
 * @sideEffects none (reads)
 */
export function queueStats(store: Store): QueueStats {
  const queued = countQueued(store);
  const row = store.db
    .prepare(
      `SELECT AVG(finished_at - started_at) AS mean FROM (
         SELECT started_at, finished_at FROM change_requests
          WHERE status = ? AND started_at IS NOT NULL AND finished_at IS NOT NULL
          ORDER BY finished_at DESC LIMIT ?)`,
    )
    .get(RequestStatus.Done, QUEUE_DURATION_SAMPLE) as { mean: number | null };
  const oldest = store.db
    .prepare("SELECT MIN(received_at) AS at FROM change_requests WHERE status = ?")
    .get(RequestStatus.Queued) as { at: number | null };
  return {
    queued,
    ...(row.mean === null ? {} : { meanDurationMs: row.mean }),
    ...(oldest.at === null ? {} : { oldestQueuedAt: oldest.at }),
  };
}

/**
 * Lists the ids of the requests of one kind that have a `changes` row with the given outcome.
 *
 * @param store - the open store
 * @param kind - the request kind
 * @param outcome - the outcome of the change
 * @returns the request ids, oldest first, each once
 * @sideEffects none (reads)
 */
export function listRequestIdsWithOutcome(store: Store, kind: RequestKind, outcome: ChangeOutcome): string[] {
  const rows = store.db
    .prepare(
      `SELECT DISTINCT r.id AS id, r.received_at AS received_at FROM changes c JOIN change_requests r ON r.id = c.request_id
        WHERE c.outcome = ? AND r.kind = ? ORDER BY r.received_at, r.id`,
    )
    .all(outcome, kind) as { id: string }[];
  return rows.map((r) => r.id);
}
