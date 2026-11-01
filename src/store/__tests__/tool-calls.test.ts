import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpToolName } from "../../domain/enums.js";
import {
  RECENT_WINDOW_MS,
  TOOL_CALL_RETENTION_MS,
  closeStore,
  pruneToolCalls,
  recordToolCall,
  toolCallStats,
  type Store,
} from "../index.js";
import { T0, makeStore } from "../../../__tests__/helpers/store.js";

const HOUR = 3_600_000;
/** 30 minutes into a whole hour of the clock. */
const NOW = Math.floor(T0 / HOUR) * HOUR + HOUR / 2;

let store: Store;
beforeEach(() => {
  store = makeStore();
});
afterEach(() => closeStore(store));

const call = (at: number, tool: McpToolName, ok = true, durationMs = 1): void =>
  recordToolCall(store, { at, tool, ok, durationMs });

describe("recordToolCall", () => {
  it("inserts 1 row with the duration rounded", () => {
    call(NOW, McpToolName.Search, false, 12.6);
    expect(store.db.prepare("SELECT at, tool, ok, duration_ms FROM tool_calls").all()).toEqual([
      { at: NOW, tool: "search", ok: 0, duration_ms: 13 },
    ]);
  });
});

describe("toolCallStats", () => {
  it("gives 24 empty whole-hour buckets that end at the hour of now, and an empty last hour", () => {
    const s = toolCallStats(store, NOW);
    expect(s.buckets).toHaveLength(24);
    expect(s.buckets.at(-1)?.startMs).toBe(NOW - HOUR / 2);
    expect(s.buckets[0]?.startMs).toBe(NOW - HOUR / 2 - 23 * HOUR);
    expect(s.buckets.every((b) => b.searchP50Ms === null && b.searchP95Ms === null)).toBe(true);
    expect(s.buckets[0]?.byTool[McpToolName.Search]).toEqual({ calls: 0, failed: 0 });
    expect(s.lastHour).toEqual({ calls: 0, failed: 0, searchP50Ms: null, searchP95Ms: null });
  });

  it("counts the calls and the failed calls per tool and per bucket", () => {
    call(NOW, McpToolName.Search);
    call(NOW - 1, McpToolName.Search, false);
    call(NOW, McpToolName.GetFact);
    call(NOW - HOUR, McpToolName.GetFact, false);
    const { buckets } = toolCallStats(store, NOW);
    expect(buckets.at(-1)?.byTool[McpToolName.Search]).toEqual({ calls: 2, failed: 1 });
    expect(buckets.at(-1)?.byTool[McpToolName.GetFact]).toEqual({ calls: 1, failed: 0 });
    expect(buckets.at(-2)?.byTool[McpToolName.GetFact]).toEqual({ calls: 1, failed: 1 });
  });

  it("takes the p50 and the p95 of the search durations by nearest rank, null with no search", () => {
    for (let d = 1; d <= 100; d++) call(NOW, McpToolName.Search, true, d);
    call(NOW, McpToolName.GetFact, true, 9999);
    call(NOW - HOUR, McpToolName.GetFact);
    const { buckets } = toolCallStats(store, NOW);
    expect(buckets.at(-1)).toMatchObject({ searchP50Ms: 50, searchP95Ms: 95 });
    expect(buckets.at(-2)).toMatchObject({ searchP50Ms: null, searchP95Ms: null });
  });

  it("drops the calls before the 24 buckets and after now", () => {
    call(NOW - 24 * HOUR, McpToolName.Search);
    call(NOW + 1, McpToolName.Search);
    const total = toolCallStats(store, NOW).buckets.reduce((n, b) => n + b.byTool[McpToolName.Search].calls, 0);
    expect(total).toBe(0);
  });

  it("counts the rolling last hour over every tool, across the hour boundary", () => {
    call(NOW, McpToolName.Search);
    call(NOW - HOUR + 1, McpToolName.GetRequest, false);
    call(NOW - HOUR, McpToolName.Search);
    expect(toolCallStats(store, NOW).lastHour).toMatchObject({ calls: 2, failed: 1 });
  });

  it("takes the p50 and the p95 of the searches of the rolling hour, a search 30 minutes ago at an hour boundary included", () => {
    // NOW is 30 minutes past the hour: this search is in the previous bucket, and in the rolling hour.
    call(NOW - HOUR / 2 - 1, McpToolName.Search, true, 7);
    expect(toolCallStats(store, NOW).buckets.at(-1)?.searchP95Ms).toBeNull();
    expect(toolCallStats(store, NOW).lastHour).toMatchObject({ searchP50Ms: 7, searchP95Ms: 7 });
    for (let d = 1; d <= 100; d++) call(NOW, McpToolName.Search, true, d);
    call(NOW, McpToolName.GetFact, true, 9999);
    call(NOW - HOUR, McpToolName.Search, true, 5000);
    const hour = toolCallStats(store, NOW).lastHour;
    expect(hour.searchP50Ms).toBe(50);
    expect(hour.searchP95Ms).toBe(95);
  });

  it("reads the recent window apart from the hour: 1 under and 1 over its edge, with the newest call", () => {
    call(NOW - RECENT_WINDOW_MS, McpToolName.Search, true, 900);
    call(NOW - RECENT_WINDOW_MS + 1, McpToolName.Search, true, 20);
    call(NOW - 1000, McpToolName.GetRequest, false);
    call(NOW + 1, McpToolName.Search);
    const { recent, lastHour } = toolCallStats(store, NOW);
    expect(recent).toEqual({ calls: 2, failed: 1, searchP50Ms: 20, searchP95Ms: 20, lastAt: NOW - 1000 });
    expect(lastHour.calls).toBe(3);
  });

  it("gives the newest call even when it is older than the 24 buckets, and null with no call", () => {
    expect(toolCallStats(store, NOW).recent).toEqual({
      calls: 0,
      failed: 0,
      searchP50Ms: null,
      searchP95Ms: null,
      lastAt: null,
    });
    call(NOW - 3 * 24 * HOUR, McpToolName.Search);
    const { recent } = toolCallStats(store, NOW);
    expect(recent.lastAt).toBe(NOW - 3 * 24 * HOUR);
    expect(recent.calls).toBe(0);
  });
});

describe("pruneToolCalls", () => {
  it("deletes the rows older than the retention and keeps the rest", () => {
    call(NOW - TOOL_CALL_RETENTION_MS - 1, McpToolName.Search);
    call(NOW - TOOL_CALL_RETENTION_MS, McpToolName.Search);
    expect(pruneToolCalls(store, NOW)).toBe(1);
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM tool_calls").get()).toEqual({ n: 1 });
  });
});
