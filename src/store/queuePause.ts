// technical/updates.md, "Queue and worker": the operator pause of the queue, one JSON value in the `meta` table. Only the console writes it;
// the worker and the MCP server read it.
import { z } from "zod";
import { MetaKey } from "../domain/enums.js";
import type { Store } from "./types/index.js";

/** The operator pause of the queue. */
export interface QueuePause {
  /** When the operator paused the queue, in ms since the epoch. */
  at: number;
  /** The reason of the operator, 1 to 500 characters. */
  note: string;
}

const queuePauseSchema: z.ZodType<QueuePause> = z.object({ at: z.number(), note: z.string() });

/**
 * Reads the operator pause of the queue.
 *
 * @param store - an open store, read-only or not
 * @returns the pause, or undefined when the queue runs (no key) or the stored value does not parse
 * @sideEffects none
 */
export function readQueuePause(store: Store): QueuePause | undefined {
  const row = store.db.prepare("SELECT value FROM meta WHERE key = ?").get(MetaKey.QueuePause) as
    { value: string } | undefined;
  if (row === undefined) return undefined;
  try {
    const parsed = queuePauseSchema.safeParse(JSON.parse(row.value));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Pauses the queue: stores the `queue_pause` key, replacing an earlier one.
 *
 * @param store - the open store with the write connection
 * @param note - the reason of the operator; the console checks its length
 * @param at - when the operator paused the queue, in ms since the epoch
 * @sideEffects one upsert on the `meta` table
 */
export function setQueuePause(store: Store, note: string, at: number): void {
  const value = JSON.stringify({ at, note } satisfies QueuePause);
  store.db
    .prepare("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(MetaKey.QueuePause, value);
}

/**
 * Resumes the queue: removes the `queue_pause` key.
 *
 * @param store - the open store with the write connection
 * @sideEffects one delete on the `meta` table; none when the key is absent
 */
export function clearQueuePause(store: Store): void {
  store.db.prepare("DELETE FROM meta WHERE key = ?").run(MetaKey.QueuePause);
}
