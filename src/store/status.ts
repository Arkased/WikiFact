// technical/updates.md, "Queue and worker": the worker status, one JSON value in the `meta` table. The worker writes it; the MCP server reads it.
import { z } from "zod";
import { CallFailureKind, MetaKey, PauseReason, WorkerState } from "../domain/enums.js";
import type { Store } from "./types/index.js";

/** The key of the worker status in the `meta` table: `MetaKey.WorkerStatus`, kept under this name for its importers. */
export const WORKER_STATUS_KEY = MetaKey.WorkerStatus;

/** The outcome of the last model call of the worker. Times are milliseconds since the epoch. */
export type WorkerCall = { ok: true; at: number } | { ok: false; kind: CallFailureKind; message: string; at: number };

/** What the worker reports about itself (technical/updates.md, "Queue and worker"). Times are milliseconds since the epoch. */
export interface WorkerStatus {
  pid: number;
  startedAt: number;
  /** The last time the worker looked at the queue. */
  lastPollAt: number;
  /** Absent until the worker has made a model call. */
  lastCall?: WorkerCall;
  /** Model calls that failed since the last one that succeeded. */
  consecutiveFailures: number;
  /** The last batch whose promotion failed. Not a model call: it leaves `lastCall` and `consecutiveFailures`. A batch that promotes clears it. */
  lastBatchError?: { message: string; at: number };
  /** Absent means `WorkerState.Running`. */
  state?: WorkerState;
  /** While paused: when the pause ends, in ms since the epoch. */
  pausedUntil?: number;
  /** While paused: why. */
  pauseReason?: PauseReason;
  /** While paused by the operator: the `at` of the `queue_pause` key, in ms since the epoch. */
  pausedSince?: number;
}

const workerStatusSchema: z.ZodType<WorkerStatus> = z.object({
  pid: z.number().int(),
  startedAt: z.number(),
  lastPollAt: z.number(),
  lastCall: z
    .union([
      z.object({ ok: z.literal(true), at: z.number() }),
      z.object({
        ok: z.literal(false),
        kind: z.enum(CallFailureKind),
        message: z.string(),
        at: z.number(),
      }),
    ])
    .optional(),
  consecutiveFailures: z.number().int().min(0),
  lastBatchError: z.object({ message: z.string(), at: z.number() }).optional(),
  state: z.enum(WorkerState).optional(),
  pausedUntil: z.number().optional(),
  pauseReason: z.enum(PauseReason).optional(),
  pausedSince: z.number().optional(),
});

/**
 * Stores the worker status, replacing the previous one.
 *
 * @param store - the open store with the write connection
 * @param status - the status to store
 * @sideEffects one upsert on the `meta` table
 */
export function writeWorkerStatus(store: Store, status: WorkerStatus): void {
  store.db
    .prepare("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(WORKER_STATUS_KEY, JSON.stringify(status));
}

/**
 * Reads the worker status.
 *
 * @param store - an open store, read-only or not
 * @returns the status, or undefined when no worker has written one or the stored value does not parse
 * @sideEffects none
 */
export function readWorkerStatus(store: Store): WorkerStatus | undefined {
  const row = store.db.prepare("SELECT value FROM meta WHERE key = ?").get(WORKER_STATUS_KEY) as
    { value: string } | undefined;
  if (row === undefined) return undefined;
  try {
    const parsed = workerStatusSchema.safeParse(JSON.parse(row.value));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
