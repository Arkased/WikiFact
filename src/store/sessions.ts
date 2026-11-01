// The session rows of technical/lookup.md, "Search log and sessions". The transport of the MCP server calls them.
import type { Store } from "./types/index.js";

/** The fields of a new session row. */
export interface OpenSessionInput {
  /** The MCP session id: the `Mcp-Session-Id` header, or a ULID on stdio. */
  id: string;
  /** The time of the `initialize` request, in ms since the epoch. */
  startedAt: number;
  /** `clientInfo.name` of the initialize request; absent when the client sends none. */
  clientName?: string;
  /** `clientInfo.version` of the initialize request; absent when the client sends none. */
  clientVersion?: string;
}

/**
 * Inserts the row of a new session, open, with 0 calls.
 *
 * @param store - the open store with the write connection
 * @param input - the session id, its start time and the client's name and version
 * @throws {Error} when a session with this id exists
 * @sideEffects one insert on the store
 */
export function openSession(store: Store, input: OpenSessionInput): void {
  store.db
    .prepare("INSERT INTO sessions(id, started_at, last_call_at, client_name, client_version) VALUES (?, ?, ?, ?, ?)")
    .run(input.id, input.startedAt, input.startedAt, input.clientName ?? null, input.clientVersion ?? null);
}

/**
 * Counts one tool call on a session.
 *
 * @param store - the open store with the write connection
 * @param id - the session id
 * @param at - the time of the call, in ms since the epoch
 * @sideEffects one update on the store: adds 1 to `call_count` and sets `last_call_at`; nothing for an unknown id
 */
export function touchSession(store: Store, id: string, at: number): void {
  store.db.prepare("UPDATE sessions SET call_count = call_count + 1, last_call_at = ? WHERE id = ?").run(at, id);
}

/**
 * Closes a session.
 *
 * @param store - the open store with the write connection
 * @param id - the session id
 * @param endedAt - the time of the end, in ms since the epoch
 * @sideEffects one update on the store; a session that has ended keeps its first end time
 */
export function endSession(store: Store, id: string, endedAt: number): void {
  store.db.prepare("UPDATE sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL").run(endedAt, id);
}

/**
 * Closes every open session at its last call, for the sessions that a stopped service left open.
 *
 * @param store - the open store with the write connection
 * @param now - the time of the service start, in ms since the epoch; no session ends after it
 * @returns the count of sessions closed
 * @sideEffects one update on the store: `ended_at = last_call_at` (at most `now`) on each session with no end time
 */
export function endOpenSessions(store: Store, now: number): number {
  return store.db.prepare("UPDATE sessions SET ended_at = MIN(last_call_at, ?) WHERE ended_at IS NULL").run(now)
    .changes;
}
