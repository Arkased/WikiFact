import { monotonicFactory } from "ulid";
import { RequestKind, RequestStatus } from "../domain/enums.js";
import { parseTargets } from "./targets.js";
import {
  MAX_ATTEMPTS,
  parseOperatorEdit,
  parseCleanupRepair,
  cleanupRepairTargets,
  type ChangeRequestRow,
  type OperatorEdit,
  type Store,
  type CleanupRepair,
} from "./types/index.js";
import { writeNames } from "./writeNames.js";

const ulid = monotonicFactory();

/**
 * Makes a new id for a fact or a request.
 *
 * @returns a ULID that sorts after the ones made before it in this process
 * @sideEffects reads the clock
 */
export function newId(): string {
  return ulid();
}

interface Row {
  id: string;
  kind: RequestKind;
  status: ChangeRequestRow["status"];
  change: string | null;
  targets: string;
  justification: string | null;
  search_id: string | null;
  attempts: number;
  received_at: number;
  finished_at: number | null;
  error: string | null;
  parent_id: string | null;
}

// The document of an operatorEdit row, or undefined when the text is not a valid edit (the worker rejects such a row).
function operatorEditOf(r: Row): OperatorEdit | undefined {
  if (r.kind !== RequestKind.OperatorEdit || r.change === null) return undefined;
  try {
    return parseOperatorEdit(r.change);
  } catch {
    return undefined;
  }
}

function toRow(r: Row): ChangeRequestRow {
  const operatorEdit = operatorEditOf(r);
  return {
    ...(operatorEdit === undefined ? {} : { operatorEdit }),
    id: r.id,
    kind: r.kind,
    status: r.status,
    change: r.change,
    targets: parseTargets(r.targets),
    justification: r.justification,
    searchId: r.search_id,
    attempts: r.attempts,
    receivedAt: r.received_at,
    finishedAt: r.finished_at,
    error: r.error,
    parentId: r.parent_id,
  };
}

/** The fields of a request to enqueue. */
export interface EnqueueInput {
  /** Default: a submission. */
  kind?: RequestKind;
  change?: string;
  targets?: string[];
  justification?: string;
  /** The id of the search that the change follows (technical/submit.md, "requestChange"); absent when the call named none. */
  searchId?: string;
  /** The submission that a split made this request from (technical/submit.md, "Split of a compound submission"); absent otherwise. */
  parentId?: string;
  /** The id of the session of the call that sent the request (technical/submit.md, "requestChange"); absent when the call has none. */
  sessionId?: string;
}

/**
 * technical/updates.md, "Queue and worker". Inserts a `queued` row. A submission needs a change and a justification.
 * A lookupRepair needs one target.
 *
 * @param store - the open store
 * @param input - the request fields; `kind` defaults to a submission, `targets` to an empty list
 * @param now - the receive time, in ms since the epoch; default the clock
 * @returns the id of the new row (a ULID)
 * @throws {Error} when a submission has an empty `change` or `justification`, or a lookupRepair does not have
 *   exactly one target
 * @sideEffects one insert on the store; reads the clock when `now` is absent
 */
export function enqueueRequest(store: Store, input: EnqueueInput, now: number = Date.now()): string {
  const kind = input.kind ?? RequestKind.Submission;
  const targets = input.targets ?? [];
  let change: string | null = null;
  let justification: string | null = null;
  if (kind === RequestKind.Submission) {
    if (!input.change || input.change.trim() === "") throw new Error("change must not be empty");
    if (!input.justification || input.justification.trim() === "") throw new Error("justification must not be empty");
    change = input.change;
    justification = input.justification;
  } else if (targets.length !== 1) {
    throw new Error("a lookupRepair request has exactly one target");
  }
  const id = newId();
  // The overlay store of a batch queues the request in the staging table; the promotion copies it to the queue.
  store.db
    .prepare(
      `INSERT INTO ${writeNames(store).change_requests}(id, kind, status, change, targets, justification, search_id, received_at, parent_id, session_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      kind,
      RequestStatus.Queued,
      change,
      JSON.stringify(targets),
      justification,
      input.searchId ?? null,
      now,
      input.parentId ?? null,
      input.sessionId ?? null,
    );
  return id;
}

/**
 * technical/submit.md, "Split of a compound submission". Lists the ids of the requests that a split made from a request.
 *
 * @param store - the open store
 * @param parentId - the id of the split request
 * @returns the child ids in the order they were queued (the order of the claims); empty for a request that was not split
 * @sideEffects none (reads)
 */
export function listChildIds(store: Store, parentId: string): string[] {
  const rows = store.db
    .prepare("SELECT id FROM change_requests WHERE parent_id = ? ORDER BY rowid ASC")
    .all(parentId) as { id: string }[];
  return rows.map((r) => r.id);
}

/**
 * technical/console.md, "The `operatorEdit` request". Inserts a `queued` row of kind `operatorEdit`: `change` holds the edit as JSON, `justification` is
 * NULL and `targets` is an empty list.
 *
 * @param store - the open store
 * @param edit - the edit; it is validated again here
 * @param now - the receive time, in ms since the epoch; default the clock
 * @returns the id of the new row (a ULID)
 * @throws {Error} when `edit` is not a valid operator edit (an empty or too long note, a missing field)
 * @sideEffects one insert on the store; reads the clock when `now` is absent
 */
export function enqueueOperatorEdit(store: Store, edit: OperatorEdit, now: number = Date.now()): string {
  const valid = parseOperatorEdit(JSON.stringify(edit));
  const id = newId();
  store.db
    .prepare(
      `INSERT INTO change_requests(id, kind, status, change, targets, justification, search_id, received_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)`,
    )
    .run(id, RequestKind.OperatorEdit, RequestStatus.Queued, JSON.stringify(valid), JSON.stringify([]), now);
  return id;
}

/**
 * design/cleanup.md, "The cleanupRepair request". Inserts a `queued` row of kind `cleanupRepair`: `change` holds the candidate as JSON, `justification` is
 * NULL and `targets` are the ids of the candidate.
 *
 * @param store - the open store
 * @param repair - the candidate; it is validated again here
 * @param now - the receive time, in ms since the epoch; default the clock
 * @returns the id of the new row (a ULID)
 * @throws {Error} when `repair` is not a valid candidate
 * @sideEffects one insert on the store; reads the clock when `now` is absent
 */
export function enqueueCleanupRepair(store: Store, repair: CleanupRepair, now: number = Date.now()): string {
  const valid = parseCleanupRepair(JSON.stringify(repair));
  const id = newId();
  store.db
    .prepare(
      `INSERT INTO change_requests(id, kind, status, change, targets, justification, search_id, received_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)`,
    )
    .run(
      id,
      RequestKind.CleanupRepair,
      RequestStatus.Queued,
      JSON.stringify(valid),
      JSON.stringify(cleanupRepairTargets(valid)),
      now,
    );
  return id;
}

/**
 * design/cleanup.md, "The cleanupRepair request". Inserts one `cleanupRepair` row for each candidate, in one transaction: all rows are written or none.
 *
 * @param store - the open store with the write connection
 * @param repairs - the candidates, in queue order; each is validated as `enqueueCleanupRepair` does
 * @param now - the receive time of every row, in ms since the epoch
 * @returns the ids of the new rows, in the order of `repairs`; empty for no candidate
 * @throws {Error} when a candidate is not valid; nothing is written then
 * @sideEffects one insert per candidate, in one transaction
 */
export function enqueueCleanupRepairs(store: Store, repairs: CleanupRepair[], now: number): string[] {
  return store.db.transaction(() => repairs.map((r) => enqueueCleanupRepair(store, r, now)))();
}

/**
 * Reads one request row.
 *
 * @param store - the open store
 * @param id - the request id
 * @returns the row, or null for an unknown id
 * @sideEffects none (reads)
 */
export function getRequest(store: Store, id: string): ChangeRequestRow | null {
  const r = store.db.prepare("SELECT * FROM change_requests WHERE id = ?").get(id) as Row | undefined;
  return r ? toRow(r) : null;
}

// design/cleanup.md, "Free for submissions": the rank of a kind in the queue. A lower rank runs first; inside a
// rank the order is by arrival (received_at, then rowid).
const RANK_SQL = `CASE kind WHEN '${RequestKind.OperatorEdit}' THEN 0 WHEN '${RequestKind.CleanupRepair}' THEN 2 ELSE 1 END`;

/**
 * technical/updates.md, "Queue and worker". Takes the first `queued` row in queue order and sets it to `running`. The
 * order is the operator's edits, then the submissions and lookup repairs, then the cleanup repairs; inside each group the
 * oldest first.
 *
 * @param store - the open store
 * @param now - the start time, in ms since the epoch, recorded as `started_at`; default the clock
 * @param skip - ids of queued rows to pass over, the rows that wait out their retry delay; default none
 * @returns the row as taken, or null when no queued row is outside `skip`
 * @sideEffects one immediate transaction on the store (status, `started_at`); reads the clock when `now` is absent
 */
export function takeNextRequest(
  store: Store,
  now: number = Date.now(),
  skip: ReadonlySet<string> = new Set(),
): ChangeRequestRow | null {
  return store.db.transaction((): ChangeRequestRow | null => takeFirstQueued(store, now, skip)).immediate();
}

// Sets the first queued row in queue order, outside `skip`, to `running`; the caller holds the transaction.
function takeFirstQueued(store: Store, now: number, skip: ReadonlySet<string>): ChangeRequestRow | null {
  const ids = [...skip];
  const not = ids.length > 0 ? ` AND id NOT IN (${ids.map(() => "?").join(",")})` : "";
  const r = store.db
    .prepare(
      `SELECT * FROM change_requests WHERE status = ?${not} ORDER BY ${RANK_SQL}, received_at ASC, rowid ASC LIMIT 1`,
    )
    .get(RequestStatus.Queued, ...ids) as Row | undefined;
  if (!r) return null;
  store.db
    .prepare("UPDATE change_requests SET status = ?, started_at = ? WHERE id = ?")
    .run(RequestStatus.Running, now, r.id);
  return toRow({ ...r, status: RequestStatus.Running });
}

/**
 * technical/updates.md, "High volume mode". Takes one named `queued` row and sets it to `running`, as `takeNextRequest` does for
 * the first row: a batch takes its requests one by one, each when a place is free.
 *
 * @param store - the open store
 * @param id - the id of the request
 * @param now - the start time, in ms since the epoch, recorded as `started_at`; default the clock
 * @returns the row as taken; null when the row is absent or not `queued`
 * @sideEffects one immediate transaction on the store (status, `started_at`); reads the clock when `now` is absent
 */
export function takeRequest(store: Store, id: string, now: number = Date.now()): ChangeRequestRow | null {
  const take = store.db.transaction((): ChangeRequestRow | null => {
    const r = store.db
      .prepare("SELECT * FROM change_requests WHERE id = ? AND status = ?")
      .get(id, RequestStatus.Queued) as Row | undefined;
    if (!r) return null;
    store.db
      .prepare("UPDATE change_requests SET status = ?, started_at = ? WHERE id = ?")
      .run(RequestStatus.Running, now, r.id);
    return toRow({ ...r, status: RequestStatus.Running });
  });
  return take.immediate();
}

/**
 * technical/updates.md, "High volume mode", "A, the fixed batch". Takes one `queued` row that the batch staged (the child of a
 * split, which only the staging tables hold) and sets it to `running` there; the promotion copies it to the queue.
 *
 * @param store - the open live store; its staging tables exist
 * @param id - the id of the staged request
 * @param now - the start time, in ms since the epoch, recorded as `started_at`
 * @returns the row as taken; null when the staging tables hold no such row or it is not `queued`
 * @sideEffects one immediate transaction on the staging table `stg_change_requests` (status, `started_at`)
 */
export function takeStagedRequest(store: Store, id: string, now: number): ChangeRequestRow | null {
  const take = store.db.transaction((): ChangeRequestRow | null => {
    const r = store.db
      .prepare("SELECT * FROM stg_change_requests WHERE id = ? AND status = ?")
      .get(id, RequestStatus.Queued) as Row | undefined;
    if (!r) return null;
    store.db
      .prepare("UPDATE stg_change_requests SET status = ?, started_at = ? WHERE id = ?")
      .run(RequestStatus.Running, now, r.id);
    return toRow({ ...r, status: RequestStatus.Running });
  });
  return take.immediate();
}

/**
 * technical/updates.md, "High volume mode", "A, the fixed batch". Reads one request row of the queue or, when the queue has none,
 * of the staging tables of the batch.
 *
 * @param store - the open store (the live store or the overlay store of a batch)
 * @param id - the request id
 * @returns the row, or null for an unknown id
 * @sideEffects none (reads)
 */
export function getBatchRequest(store: Store, id: string): ChangeRequestRow | null {
  const r = (store.db.prepare("SELECT * FROM change_requests WHERE id = ?").get(id) ??
    store.db.prepare("SELECT * FROM stg_change_requests WHERE id = ?").get(id)) as Row | undefined;
  return r ? toRow(r) : null;
}

/**
 * technical/updates.md, "High volume mode", "A, the fixed batch". Puts a staged request that failed an attempt back to `queued`
 * in the staging tables, with the error text and no attempt counted: the promotion queues it for a later run.
 *
 * @param store - the open live store
 * @param id - the id of the staged request
 * @param error - the error text to keep on the row
 * @throws {Error} when the staging tables hold no such request
 * @sideEffects one update on `stg_change_requests` (status, `error`)
 */
export function releaseStagedRequest(store: Store, id: string, error: string): void {
  const res = store.db
    .prepare("UPDATE stg_change_requests SET status = ?, error = ? WHERE id = ?")
    .run(RequestStatus.Queued, error, id);
  if (res.changes === 0) throw new Error(`unknown staged request ${id}`);
}

/**
 * technical/updates.md, "High volume mode", "Rules of the runner". Counts all queued submissions, whatever stands in front of them.
 *
 * @param store - the open store
 * @returns the number of `queued` rows of kind `submission`
 * @sideEffects none (reads)
 */
export function countQueuedSubmissions(store: Store): number {
  const row = store.db
    .prepare("SELECT COUNT(*) AS n FROM change_requests WHERE status = ? AND kind = ?")
    .get(RequestStatus.Queued, RequestKind.Submission) as { n: number };
  return row.n;
}

/**
 * technical/updates.md, "High volume mode". Reads the first queued rows in queue order without taking them.
 *
 * @param store - the open store
 * @param limit - the most rows to read
 * @returns the queued rows, in the order `takeNextRequest` takes them; empty for an empty queue
 * @sideEffects none (reads)
 */
export function peekQueue(store: Store, limit: number): ChangeRequestRow[] {
  const rows = store.db
    .prepare(`SELECT * FROM change_requests WHERE status = ? ORDER BY ${RANK_SQL}, received_at ASC, rowid ASC LIMIT ?`)
    .all(RequestStatus.Queued, limit) as Row[];
  return rows.map(toRow);
}

/**
 * technical/cleanup.md, "When it runs". Reads the ids of the queued `cleanupRepair` requests in queue order.
 *
 * @param store - the open store
 * @returns the ids, oldest first; empty when no repair is queued
 * @sideEffects none (reads)
 */
export function queuedRepairIds(store: Store): string[] {
  const rows = store.db
    .prepare("SELECT id FROM change_requests WHERE status = ? AND kind = ? ORDER BY received_at ASC, rowid ASC")
    .all(RequestStatus.Queued, RequestKind.CleanupRepair) as { id: string }[];
  return rows.map((r) => r.id);
}

/**
 * technical/updates.md, "Queue and worker". The place of a queued request in the line: the number of queued requests
 * that the worker takes before it, itself included. A queued cleanup repair does not count for a submission.
 *
 * @param store - the open store
 * @param id - the request id
 * @returns the place, from 1; 0 when the request is not queued
 * @sideEffects none (reads)
 */
export function queuePosition(store: Store, id: string): number {
  const me = store.db
    .prepare(`SELECT ${RANK_SQL} AS rank, received_at, rowid AS rid FROM change_requests WHERE id = ? AND status = ?`)
    .get(id, RequestStatus.Queued) as { rank: number; received_at: number; rid: number } | undefined;
  if (!me) return 0;
  const row = store.db
    .prepare(
      `SELECT COUNT(*) AS n FROM change_requests WHERE status = ? AND
       (${RANK_SQL} < ? OR (${RANK_SQL} = ? AND (received_at < ? OR (received_at = ? AND rowid <= ?))))`,
    )
    .get(RequestStatus.Queued, me.rank, me.rank, me.received_at, me.received_at, me.rid) as { n: number };
  return row.n;
}

/**
 * technical/updates.md, "Queue and worker". Sets the row to `done`.
 *
 * @param store - the open store
 * @param id - the request id
 * @param now - the finish time, in ms since the epoch; default the clock
 * @param error - the reason of a rejection at step 1 (Q7), kept for `getRequest`; default none, which clears the error
 * @throws {Error} when no request has this id
 * @sideEffects one update on the store (status, `finished_at`, `error`); reads the clock when `now` is absent
 */
export function finishRequest(store: Store, id: string, now: number = Date.now(), error?: string): void {
  const res = store.db
    .prepare("UPDATE change_requests SET status = ?, finished_at = ?, error = ? WHERE id = ?")
    .run(RequestStatus.Done, now, error ?? null, id);
  if (res.changes === 0) throw new Error(`unknown request ${id}`);
}

/**
 * technical/updates.md, "Queue and worker". Increments `attempts`. Sets the row back to `queued`,
 * or to `failed` with the error text after MAX_ATTEMPTS attempts.
 *
 * @param store - the open store
 * @param id - the request id
 * @param error - the error text to keep on the row
 * @param now - the failure time, in ms since the epoch; recorded as `finished_at` when the row fails
 * @returns `queued` when attempts remain, `failed` when this was the last of MAX_ATTEMPTS
 * @throws {Error} when no request has this id
 * @sideEffects one immediate transaction on the store; reads the clock when `now` is absent
 */
export function failAttempt(
  store: Store,
  id: string,
  error: string,
  now: number = Date.now(),
): RequestStatus.Queued | RequestStatus.Failed {
  const run = store.db.transaction((): RequestStatus.Queued | RequestStatus.Failed => {
    const r = store.db.prepare("SELECT attempts FROM change_requests WHERE id = ?").get(id) as
      { attempts: number } | undefined;
    if (!r) throw new Error(`unknown request ${id}`);
    const attempts = r.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      store.db
        .prepare("UPDATE change_requests SET attempts = ?, status = ?, error = ?, finished_at = ? WHERE id = ?")
        .run(attempts, RequestStatus.Failed, error, now, id);
      return RequestStatus.Failed;
    }
    store.db
      .prepare("UPDATE change_requests SET attempts = ?, status = ?, error = ? WHERE id = ?")
      .run(attempts, RequestStatus.Queued, error, id);
    return RequestStatus.Queued;
  });
  return run.immediate();
}

/**
 * technical/updates.md, "Queue and worker". Ends a request as `failed` at this attempt, with no retry: the failure
 * is deterministic, so the next attempt would give the same result.
 *
 * @param store - the open store
 * @param id - the request id
 * @param error - the error text to keep on the row
 * @param now - the failure time, in ms since the epoch; recorded as `finished_at`
 * @throws {Error} when no request has this id
 * @sideEffects one update on the store (status, `attempts` plus 1, `error`, `finished_at`); reads the clock when `now` is absent
 */
export function failRequest(store: Store, id: string, error: string, now: number = Date.now()): void {
  const res = store.db
    .prepare("UPDATE change_requests SET attempts = attempts + 1, status = ?, error = ?, finished_at = ? WHERE id = ?")
    .run(RequestStatus.Failed, error, now, id);
  if (res.changes === 0) throw new Error(`unknown request ${id}`);
}

/**
 * technical/updates.md, "Queue and worker", "Model call failures". Puts a `running` request back to `queued` with its
 * attempt count unchanged: a rate limit of the model is a wait, not a failed attempt.
 *
 * @param store - the open store
 * @param id - the request id
 * @param error - the error text to keep on the row, so the request page shows why it waits
 * @throws {Error} when no request has this id
 * @sideEffects one update on the store (status, `error`)
 */
export function releaseRequest(store: Store, id: string, error: string): void {
  const res = store.db
    .prepare("UPDATE change_requests SET status = ?, error = ? WHERE id = ?")
    .run(RequestStatus.Queued, error, id);
  if (res.changes === 0) throw new Error(`unknown request ${id}`);
}

/**
 * technical/updates.md, "Queue and worker", on restart. Puts the rows in `running` back to `queued`. The rows of a batch
 * that a restart cut short return here too (technical/updates.md, "High volume mode"); the key of the batch start seq
 * stays, and the next step of the worker reconciles the facts above it.
 *
 * @param store - the open store
 * @returns the number of rows reset
 * @sideEffects one update on the store
 */
export function resetRunning(store: Store): number {
  return store.db
    .prepare("UPDATE change_requests SET status = ? WHERE status = ?")
    .run(RequestStatus.Queued, RequestStatus.Running).changes;
}

/**
 * Lists the ids of the requests in `running`, which the registry waits for before it restarts a worker (technical/console.md, "Operator actions").
 *
 * @param store - the open store
 * @returns the ids, oldest first; empty when the worker is between requests
 * @sideEffects none (reads)
 */
export function listRunning(store: Store): string[] {
  const rows = store.db
    .prepare("SELECT id FROM change_requests WHERE status = ? ORDER BY received_at ASC, rowid ASC")
    .all(RequestStatus.Running) as { id: string }[];
  return rows.map((r) => r.id);
}

/**
 * Lists the requests in `failed`, oldest first.
 *
 * @param store - the open store
 * @returns the failed rows
 * @sideEffects none (reads)
 */
export function listFailed(store: Store): ChangeRequestRow[] {
  const rows = store.db
    .prepare("SELECT * FROM change_requests WHERE status = ? ORDER BY received_at ASC, rowid ASC")
    .all(RequestStatus.Failed) as Row[];
  return rows.map(toRow);
}

/**
 * technical/updates.md, "System failures", F12. Puts a failed request back in the queue with its attempts reset.
 *
 * @param store - the open store
 * @param id - the request id
 * @returns false when the row is not failed
 * @sideEffects one update on the store
 */
export function requeue(store: Store, id: string): boolean {
  return (
    store.db
      .prepare(
        "UPDATE change_requests SET status = ?, attempts = 0, error = NULL, finished_at = NULL WHERE id = ? AND status = ?",
      )
      .run(RequestStatus.Queued, id, RequestStatus.Failed).changes > 0
  );
}
