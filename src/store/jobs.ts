// The state of the jobs for the Jobs page of the console (technical/console.md, "Store API reads for the signals").
import type { ChangeOutcome, CleanupFinder, RequestStatus } from "../domain/enums.js";
import { JobRequestField, OperatorEditKind, RequestKind } from "../domain/enums.js";
import { CLEANUP_FINDERS } from "./cleanup/limits.js";
import {
  countWritesSince,
  highestChangeSeq,
  readCleanupEvery,
  hasOpenRepairs,
  readCleanupFull,
  readCleanupPending,
  readCleanupSeq,
} from "./cleanup/state.js";
import type { Store } from "./types/index.js";

/** A request of a job, as the Jobs page links it. */
export interface JobRequest {
  id: string;
  receivedAt: number;
  status: RequestStatus;
  /** The outcome of the last change of the request; null while it has none. */
  outcome: ChangeOutcome | null;
}

/** The state of one finder of the cleanup. */
export interface CleanupJobRow {
  finder: CleanupFinder;
  /** The `seq` of the finder in `meta.cleanup_seq`; the highest `seq` when the meta value is absent. */
  lastSeq: number;
  /** The time of the change at `lastSeq`, in ms since the epoch; null when no such change exists. */
  lastRunAt: number | null;
  /** The count of accepted changes above `lastSeq` of `submission` and `operatorEdit` requests only: the same count that the trigger reads. */
  writesSince: number;
  /** The interval of the finder in `meta.cleanup_every` (the `CLEANUP_EVERY` seed when absent), in writes. */
  interval: number;
  /** True when the finder is in `meta.cleanup_full`: the cap cut its last run. */
  capped: boolean;
  /** True when the finder is in `meta.cleanup_pending` and a `cleanupRepair` request of the finder is `queued` or `running`. */
  pending: boolean;
  /** The newest `cleanupRepair` request whose document names the finder; null when none. */
  lastRequest: JobRequest | null;
}

/** The result of `jobRows`. */
export interface JobRows {
  /** 1 row per finder, in the order of `CLEANUP_FINDERS`. */
  cleanup: CleanupJobRow[];
  /** The newest `operatorEdit` request with `edit: "reindex"`; null when none. */
  reindex: JobRequest | null;
}

interface RequestRow {
  id: string;
  received_at: number;
  status: RequestStatus;
  outcome: ChangeOutcome | null;
}

// The newest request of a kind whose document holds `field = value`, with the outcome of its last change.
function newestRequest(store: Store, kind: RequestKind, field: JobRequestField, value: string): JobRequest | null {
  const row = store.db
    .prepare(
      `SELECT r.id, r.received_at, r.status,
              (SELECT c.outcome FROM changes c WHERE c.request_id = r.id ORDER BY c.seq DESC LIMIT 1) AS outcome
       FROM change_requests r
       WHERE r.kind = ? AND json_valid(r.change) AND json_extract(r.change, '$.' || ?) = ?
       ORDER BY r.received_at DESC, r.rowid DESC LIMIT 1`,
    )
    .get(kind, field, value) as RequestRow | undefined;
  if (row === undefined) return null;
  return { id: row.id, receivedAt: row.received_at, status: row.status, outcome: row.outcome };
}

/**
 * Reads the state of each job: the finders of the cleanup and the reindex.
 *
 * @param store - the open store
 * @returns 1 row per finder in the order of `CLEANUP_FINDERS`, and the last reindex request
 * @sideEffects none (reads `meta`, `changes`, `change_requests`)
 */
export function jobRows(store: Store): JobRows {
  const highest = highestChangeSeq(store);
  const seqs = readCleanupSeq(store);
  const full = readCleanupFull(store);
  const every = readCleanupEvery(store);
  const pending = readCleanupPending(store);
  const cleanup = CLEANUP_FINDERS.map((finder): CleanupJobRow => {
    const lastSeq = seqs?.[finder] ?? highest;
    const at = store.db.prepare("SELECT created_at FROM changes WHERE seq = ?").get(lastSeq) as
      { created_at: number } | undefined;
    return {
      finder,
      lastSeq,
      lastRunAt: seqs === undefined ? null : (at?.created_at ?? null),
      writesSince: countWritesSince(store, lastSeq),
      interval: every[finder],
      capped: full.includes(finder),
      pending: pending.includes(finder) && hasOpenRepairs(store, finder),
      lastRequest: newestRequest(store, RequestKind.CleanupRepair, JobRequestField.Finder, finder),
    };
  });
  return {
    cleanup,
    reindex: newestRequest(store, RequestKind.OperatorEdit, JobRequestField.Edit, OperatorEditKind.Reindex),
  };
}
