// technical/deployment.md, "Endpoint counters": the tool calls of a wiki's MCP endpoint, 1 row per call, so that the counts survive a restart.
import { McpToolName, enumValues } from "../domain/enums.js";
import type { Store } from "./types/index.js";

/** The rows of `tool_calls` older than this are deleted by the service, once a day, in ms: 7 days. */
export const TOOL_CALL_RETENTION_MS = 7 * 86_400_000;

/** The number of hourly buckets of `toolCallStats`. */
const TOOL_CALL_HOURS = 24;

const HOUR_MS = 3_600_000;

/** The window of the "now" readings of the MCP server (`ToolCallStats.recent`), in ms: the 15 minutes before `now`. */
export const RECENT_WINDOW_MS = 15 * 60_000;

const P50 = 50;
const P95 = 95;
const PERCENT = 100;

/** What `recordToolCall` stores for 1 call. */
export interface ToolCallInput {
  /** The time of the call, in ms since the epoch. */
  at: number;
  tool: McpToolName;
  /** False for an unexpected error; true for an answer, a rejection with a reason included. */
  ok: boolean;
  /** The duration of the call, in ms; stored rounded. */
  durationMs: number;
}

/** The calls and the failed calls of 1 tool. */
export interface ToolCallCount {
  calls: number;
  failed: number;
}

/** One hourly bucket of `toolCallStats`. */
export interface ToolCallBucket {
  /** The start of the bucket, in ms since the epoch; a whole hour. */
  startMs: number;
  byTool: Record<McpToolName, ToolCallCount>;
  /** The median of the `search` durations of the bucket, in ms (nearest rank); `null` when the bucket has no search. */
  searchP50Ms: number | null;
  /** The 95th percentile of the `search` durations of the bucket, in ms (nearest rank); `null` when none. */
  searchP95Ms: number | null;
}

/** The result of `toolCallStats`. */
export interface ToolCallStats {
  /** 24 buckets, oldest first; the last one holds `now`. */
  buckets: ToolCallBucket[];
  /** The calls and the failed calls of the rolling hour before `now`, over every tool. */
  lastHour: ToolCallHour;
  /** The calls of the rolling `RECENT_WINDOW_MS` before `now`, and the time of the newest call. */
  recent: ToolCallRecent;
}

/** The calls of the rolling recent window: their counts, the time of the searches among them and the newest call overall. */
interface ToolCallRecent extends ToolCallHour {
  /** The time of the newest call at or before `now`, in ms since the epoch; `null` when the table holds no call. */
  lastAt: number | null;
}

/** The calls of the rolling last hour: their counts and the time of the searches among them. */
interface ToolCallHour extends ToolCallCount {
  /** The median of the `search` durations of the rolling hour, in ms (nearest rank); `null` with no search. */
  searchP50Ms: number | null;
  /** The 95th percentile of the `search` durations of the rolling hour, in ms (nearest rank); `null` with no search. */
  searchP95Ms: number | null;
}

/**
 * Writes the `tool_calls` row of 1 wiki tool call.
 *
 * @param store - the open store with the write connection
 * @param input - the time, the tool, the outcome and the duration
 * @sideEffects one insert, in no transaction of its own
 */
export function recordToolCall(store: Store, input: ToolCallInput): void {
  store.db
    .prepare("INSERT INTO tool_calls(at, tool, ok, duration_ms) VALUES (?, ?, ?, ?)")
    .run(input.at, input.tool, input.ok ? 1 : 0, Math.round(input.durationMs));
}

/**
 * Deletes the rows of `tool_calls` older than `TOOL_CALL_RETENTION_MS`.
 *
 * @param store - the open store with the write connection
 * @param now - the time, in ms since the epoch
 * @returns the number of rows deleted
 * @sideEffects one delete
 */
export function pruneToolCalls(store: Store, now: number): number {
  return store.db.prepare("DELETE FROM tool_calls WHERE at < ?").run(now - TOOL_CALL_RETENTION_MS).changes;
}

interface CallRow {
  at: number;
  tool: McpToolName;
  ok: number;
  duration_ms: number;
}

const emptyByTool = (): Record<McpToolName, ToolCallCount> =>
  Object.fromEntries(enumValues(McpToolName).map((t) => [t, { calls: 0, failed: 0 }])) as Record<
    McpToolName,
    ToolCallCount
  >;

// The nearest rank: the smallest sample with at least `p` percent of the samples at or below it.
function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.max(0, Math.ceil((p / PERCENT) * sorted.length) - 1)] ?? null;
}

/**
 * Reads the calls of the last 24 hours, per hour and per tool, and the calls of the rolling last hour. The same shape as
 * `CallStats.snapshot` and `CallStats.failedLastHour`, from the table.
 *
 * @param store - the open store
 * @param now - the end of the last bucket, in ms since the epoch
 * @returns 24 buckets of a whole hour that end at the hour of `now` (a bucket with no call is zeros and `null`
 *   percentiles), `lastHour`: the `calls` and `failed` of the calls in `(now - 1 hour, now]`, and the p50 and p95 of the
 *   searches among them (nearest rank; `null` with no search), and `recent`: the same over `(now - RECENT_WINDOW_MS, now]`
 *   with `lastAt`, the time of the newest call at or before `now` (`null` with no call)
 * @sideEffects none (reads, 2 queries)
 */
export function toolCallStats(store: Store, now: number): ToolCallStats {
  const lastStart = Math.floor(now / HOUR_MS) * HOUR_MS;
  const firstStart = lastStart - (TOOL_CALL_HOURS - 1) * HOUR_MS;
  const buckets: ToolCallBucket[] = Array.from({ length: TOOL_CALL_HOURS }, (_, i) => ({
    startMs: firstStart + i * HOUR_MS,
    byTool: emptyByTool(),
    searchP50Ms: null,
    searchP95Ms: null,
  }));
  const searchMs: number[][] = buckets.map(() => []);
  const lastHour: ToolCallHour = { calls: 0, failed: 0, searchP50Ms: null, searchP95Ms: null };
  const hourSearchMs: number[] = [];
  const recent: ToolCallRecent = { calls: 0, failed: 0, searchP50Ms: null, searchP95Ms: null, lastAt: null };
  const recentSearchMs: number[] = [];
  const rows = store.db
    .prepare("SELECT at, tool, ok, duration_ms FROM tool_calls WHERE at >= ? AND at <= ?")
    .all(Math.min(firstStart, now - HOUR_MS + 1), now) as CallRow[];
  for (const r of rows) {
    if (r.at > now - HOUR_MS) {
      lastHour.calls += 1;
      if (r.ok === 0) lastHour.failed += 1;
      if (r.tool === McpToolName.Search) hourSearchMs.push(r.duration_ms);
    }
    if (r.at > now - RECENT_WINDOW_MS) {
      recent.calls += 1;
      if (r.ok === 0) recent.failed += 1;
      if (r.tool === McpToolName.Search) recentSearchMs.push(r.duration_ms);
    }
    const i = Math.floor((r.at - firstStart) / HOUR_MS);
    const bucket = buckets[i];
    const count = bucket?.byTool[r.tool];
    if (bucket === undefined || count === undefined) continue;
    count.calls += 1;
    if (r.ok === 0) count.failed += 1;
    if (r.tool === McpToolName.Search) searchMs[i]?.push(r.duration_ms);
  }
  buckets.forEach((bucket, i) => {
    const sorted = (searchMs[i] ?? []).sort((a, b) => a - b);
    bucket.searchP50Ms = percentile(sorted, P50);
    bucket.searchP95Ms = percentile(sorted, P95);
  });
  hourSearchMs.sort((a, b) => a - b);
  lastHour.searchP50Ms = percentile(hourSearchMs, P50);
  lastHour.searchP95Ms = percentile(hourSearchMs, P95);
  recentSearchMs.sort((a, b) => a - b);
  recent.searchP50Ms = percentile(recentSearchMs, P50);
  recent.searchP95Ms = percentile(recentSearchMs, P95);
  // The newest call can be older than the 24 hours of the buckets (the table keeps 7 days), so it has its own read.
  const newest = store.db.prepare("SELECT MAX(at) AS at FROM tool_calls WHERE at <= ?").get(now) as {
    at: number | null;
  };
  recent.lastAt = newest.at;
  return { buckets, lastHour, recent };
}
