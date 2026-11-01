import { afterEach, describe, expect, it } from "vitest";
import { HealthLevel, McpToolName } from "../../domain/enums.js";
import { enqueueRequest, recordToolCall, writeWorkerStatus } from "../../store/index.js";
import { T0 } from "../../../__tests__/helpers/store.js";
import { FAILED_CALLS_RED_MIN, FAILED_CALLS_RED_SHARE } from "../health.js";
import { readStatusPill } from "../pages/parts/index.js";
import { openTmpWiki, type TmpWiki } from "./helpers/tmp-wiki.js";

let w: TmpWiki;
afterEach(() => w.close());

// A wiki whose worker is running and polled at T0 + 1000, so the worker row is green.
// `calls` search calls at T0 are stored, `failed` of them failed.
function runningWiki(calls = 0, failed = 0): TmpWiki {
  const wiki = openTmpWiki("alpha", { childRunning: true });
  writeWorkerStatus(wiki.store, { pid: process.pid, startedAt: T0, lastPollAt: T0 + 1000, consecutiveFailures: 0 });
  for (let i = 0; i < calls; i++) {
    recordToolCall(wiki.store, { at: T0, tool: McpToolName.Search, ok: i >= failed, durationMs: 1 });
  }
  return wiki;
}

describe("readStatusPill", () => {
  it("names the level and the worst row, and links to Service health", () => {
    w = openTmpWiki();
    const pill = readStatusPill(w.store, w.wiki, T0);
    // A wiki without a worker has a red worker row.
    expect(pill.level).toBe(HealthLevel.Red);
    expect(pill.text).toBe("failing · worker");
    expect(pill.href).toBe("/console/w/alpha/health");
  });

  it("holds the 3 row details in the title, with no queue line", () => {
    w = openTmpWiki();
    const lines = readStatusPill(w.store, w.wiki, T0).title.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^worker: /);
    expect(lines[1]).toMatch(/^failed change requests: /);
    expect(lines[2]).toMatch(/^failed tool calls: /);
  });

  it("reads ok when the 3 rows are green", () => {
    w = runningWiki(3, 0);
    const pill = readStatusPill(w.store, w.wiki, T0 + 2000);
    expect(pill.level).toBe(HealthLevel.Green);
    expect(pill.text).toBe("ok");
  });

  it("reads ok with a long queue: the queue is load, not a fault", () => {
    w = runningWiki(3, 0);
    for (let i = 0; i < 606; i++) enqueueRequest(w.store, { change: `q${i}`, justification: "j" }, T0 + i);
    expect(readStatusPill(w.store, w.wiki, T0 + 2000)).toMatchObject({ level: HealthLevel.Green, text: "ok" });
  });

  it("changes level with the failed calls at the boundaries of FAILED_CALLS_RED_MIN and FAILED_CALLS_RED_SHARE", () => {
    // 1 failed call: yellow, named by its row.
    w = runningWiki(3, 1);
    expect(readStatusPill(w.store, w.wiki, T0 + 2000)).toMatchObject({
      level: HealthLevel.Yellow,
      text: "warning · failed tool calls",
    });
    w.close();
    // 1 call under FAILED_CALLS_RED_MIN, all failed: still yellow.
    w = runningWiki(FAILED_CALLS_RED_MIN - 1, FAILED_CALLS_RED_MIN - 1);
    expect(readStatusPill(w.store, w.wiki, T0 + 2000).level).toBe(HealthLevel.Yellow);
    w.close();
    // FAILED_CALLS_RED_MIN calls, all failed: red.
    w = runningWiki(FAILED_CALLS_RED_MIN, FAILED_CALLS_RED_MIN);
    expect(readStatusPill(w.store, w.wiki, T0 + 2000)).toMatchObject({
      level: HealthLevel.Red,
      text: "failing · failed tool calls",
    });
    w.close();
    // Many calls, 1 failed call under the share: yellow; at the share: red.
    const calls = FAILED_CALLS_RED_MIN * 4;
    const atShare = Math.ceil(calls * FAILED_CALLS_RED_SHARE);
    w = runningWiki(calls, atShare - 1);
    expect(readStatusPill(w.store, w.wiki, T0 + 2000).level).toBe(HealthLevel.Yellow);
    w.close();
    w = runningWiki(calls, atShare);
    expect(readStatusPill(w.store, w.wiki, T0 + 2000).level).toBe(HealthLevel.Red);
  });
});
