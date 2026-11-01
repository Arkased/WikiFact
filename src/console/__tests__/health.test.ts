import { writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CallFailureKind, HealthLevel, HealthRow, McpToolName } from "../../domain/enums.js";
import { enqueueRequest, failAttempt, recordToolCall, seedChange, writeWorkerStatus } from "../../store/index.js";
import { T0, accepted, draft } from "../../../__tests__/helpers/store.js";
import {
  FAILED_CALLS_RED_MIN,
  FAILED_CALLS_RED_SHARE,
  HEALTH_WINDOW_MS,
  QUEUE_DEFAULT_REQUEST_MS,
  WORKER_POLL_MS,
  WORKER_RED_FAILURES,
  estimatedWaitMs,
  failedCallsLevel,
  failedLevel,
  failedRequestsIn,
  liveHealth,
  waitText,
  workerLevel,
  workerRunning,
  worstLevel,
} from "../health.js";
import { durationText } from "../html.js";
import { openTmpWiki, type TmpWiki } from "./helpers/tmp-wiki.js";

/** An odd number: a Windows pid is a multiple of 4 and the Linux maximum is 4194304, so no process has it. */
const DEAD_PID = 4194303;

const HOUR_MS = 3_600_000;

describe("the rule functions at their boundaries", () => {
  it("worker: a poll inside the window and an ok call are green", () => {
    const ok = { ok: true as const, at: 1 };
    expect(workerLevel({ polled: true, lastCall: ok, consecutiveFailures: 0, childEnded: false })).toBe(
      HealthLevel.Green,
    );
    expect(workerLevel({ polled: true, consecutiveFailures: 0, childEnded: false })).toBe(HealthLevel.Green);
    expect(workerLevel({ polled: false, lastCall: ok, consecutiveFailures: 0, childEnded: false })).toBe(
      HealthLevel.Red,
    );
    expect(workerLevel({ polled: true, lastCall: ok, consecutiveFailures: 0, childEnded: true })).toBe(HealthLevel.Red);
  });

  it("worker: a failed call is yellow under the failure bound, red on a credential or at the bound", () => {
    const failed = (kind: CallFailureKind) => ({ ok: false as const, kind, message: "m", at: 1 });
    const base = { polled: true, childEnded: false };
    expect(workerLevel({ ...base, lastCall: failed(CallFailureKind.Other), consecutiveFailures: 1 })).toBe(
      HealthLevel.Yellow,
    );
    const under = WORKER_RED_FAILURES - 1;
    expect(workerLevel({ ...base, lastCall: failed(CallFailureKind.RateLimit), consecutiveFailures: under })).toBe(
      HealthLevel.Yellow,
    );
    expect(
      workerLevel({ ...base, lastCall: failed(CallFailureKind.Other), consecutiveFailures: WORKER_RED_FAILURES }),
    ).toBe(HealthLevel.Red);
    expect(workerLevel({ ...base, lastCall: failed(CallFailureKind.Credential), consecutiveFailures: 1 })).toBe(
      HealthLevel.Red,
    );
  });

  it("worker: a paused worker is yellow, whatever its failure count, but red without a poll", () => {
    const paused = { polled: true, childEnded: false, paused: true, consecutiveFailures: WORKER_RED_FAILURES };
    expect(workerLevel(paused)).toBe(HealthLevel.Yellow);
    expect(workerLevel({ ...paused, polled: false })).toBe(HealthLevel.Red);
  });

  it("worker running: the child state when there is a child, else a poll inside the window", () => {
    const status = { pid: 1, startedAt: T0, lastPollAt: T0, consecutiveFailures: 0 };
    const wiki = { name: "w", config: {} as never, dbPath: "", url: "", subject: "" };
    expect(workerRunning(wiki, status, T0 + WORKER_POLL_MS)).toBe(true);
    expect(workerRunning(wiki, status, T0 + WORKER_POLL_MS + 1)).toBe(false);
    expect(workerRunning(wiki, undefined, T0)).toBe(false);
    expect(workerRunning({ ...wiki, childRunning: true }, undefined, T0)).toBe(true);
    expect(workerRunning({ ...wiki, childRunning: false }, status, T0)).toBe(false);
  });

  it("queue wait: the queued count times the mean duration, with a default", () => {
    expect(estimatedWaitMs({ queued: 3 })).toBe(3 * QUEUE_DEFAULT_REQUEST_MS);
    expect(estimatedWaitMs({ queued: 3, meanDurationMs: 1000 })).toBe(3000);
    expect(estimatedWaitMs({ queued: 0 })).toBe(0);
  });

  it("failed: 0 green, some yellow, a credential failure red", () => {
    expect(failedLevel(0, 0)).toBe(HealthLevel.Green);
    expect(failedLevel(1, 0)).toBe(HealthLevel.Yellow);
    expect(failedLevel(2, 1)).toBe(HealthLevel.Red);
  });

  it("failed calls: none green, some yellow, red from FAILED_CALLS_RED_MIN calls at FAILED_CALLS_RED_SHARE", () => {
    expect(failedCallsLevel({ calls: 0, failed: 0 })).toBe(HealthLevel.Green);
    expect(failedCallsLevel({ calls: 100, failed: 0 })).toBe(HealthLevel.Green);
    expect(failedCallsLevel({ calls: 1, failed: 1 })).toBe(HealthLevel.Yellow);
    // The call count at the bound: 1 under is yellow at a failed share of 1, the bound itself is red.
    expect(failedCallsLevel({ calls: FAILED_CALLS_RED_MIN - 1, failed: FAILED_CALLS_RED_MIN - 1 })).toBe(
      HealthLevel.Yellow,
    );
    expect(failedCallsLevel({ calls: FAILED_CALLS_RED_MIN, failed: FAILED_CALLS_RED_MIN })).toBe(HealthLevel.Red);
    // The share at the bound: 1 failed call under it is yellow, at it is red.
    const calls = FAILED_CALLS_RED_MIN * 2;
    const atShare = Math.ceil(calls * FAILED_CALLS_RED_SHARE);
    expect(failedCallsLevel({ calls, failed: atShare - 1 })).toBe(HealthLevel.Yellow);
    expect(failedCallsLevel({ calls, failed: atShare })).toBe(HealthLevel.Red);
  });

  it("the verdict is the worst row", () => {
    expect(worstLevel([])).toBe(HealthLevel.Green);
    expect(worstLevel([HealthLevel.Green, HealthLevel.Yellow, HealthLevel.Green])).toBe(HealthLevel.Yellow);
    expect(worstLevel([HealthLevel.Yellow, HealthLevel.Red])).toBe(HealthLevel.Red);
  });

  it("writes durations in the one form of every page", () => {
    expect(durationText(850)).toBe("<1 s");
    expect(durationText(-5)).toBe("<1 s");
    expect(durationText(1000)).toBe("1 s");
    expect(durationText(12_900)).toBe("12 s");
    expect(durationText(210_000)).toBe("3 min");
    expect(durationText(2 * 3_600_000 + 360_000)).toBe("2 h");
    expect(durationText(4 * 86_400_000)).toBe("96 h");
  });

  it("writes the wait of the queue", () => {
    expect(waitText(0)).toBe("no wait");
    expect(waitText(999)).toBe("no wait");
    expect(waitText(9000)).toBe("9 s wait");
    expect(waitText(90_000)).toBe("1 min wait");
  });
});

describe("liveHealth on a wiki", () => {
  let w: TmpWiki;
  beforeEach(() => {
    w = openTmpWiki();
  });
  afterEach(() => w.close());

  const rowOf = (report: ReturnType<typeof liveHealth>, row: HealthRow) => report.rows.find((r) => r.row === row);

  it("has the 3 rows in order and is red on an empty wiki that no worker has run on", () => {
    const report = liveHealth(w.store, w.wiki, T0);
    expect(report.rows.map((r) => r.row)).toEqual([HealthRow.Worker, HealthRow.FailedRequests, HealthRow.FailedCalls]);
    expect(report.rows.map((r) => r.level)).toEqual([HealthLevel.Red, HealthLevel.Green, HealthLevel.Green]);
    expect(report.verdict).toBe(HealthLevel.Red);
    expect(rowOf(report, HealthRow.Worker)?.detail).toBe("no poll yet");
    expect(rowOf(report, HealthRow.FailedRequests)?.detail).toBe("0 in 24 hours");
    expect(rowOf(report, HealthRow.FailedCalls)?.detail).toBe("0 of 0 in the last hour");
  });

  it("is green with a live worker that polled, its lock file and nothing failed", async () => {
    await seedChange(w.store, accepted([draft()]), { now: T0 });
    writeWorkerStatus(w.store, { pid: process.pid, startedAt: T0, lastPollAt: T0 + 1000, consecutiveFailures: 0 });
    writeFileSync(`${w.wiki.dbPath}.lock`, String(process.pid));
    const report = liveHealth(w.store, { ...w.wiki, childRunning: true }, T0 + 2000);
    expect(report.verdict).toBe(HealthLevel.Green);
    const worker = rowOf(report, HealthRow.Worker);
    // The detail holds no pid, no lock and no child text.
    expect(worker?.detail).toBe("polled 1 s ago");
  });

  it("goes red on a stale poll, or an ended child", () => {
    writeWorkerStatus(w.store, { pid: DEAD_PID, startedAt: T0, lastPollAt: T0, consecutiveFailures: 0 });
    const fresh = liveHealth(w.store, w.wiki, T0 + WORKER_POLL_MS);
    expect(rowOf(fresh, HealthRow.Worker)?.level).toBe(HealthLevel.Green);
    const stale = liveHealth(w.store, w.wiki, T0 + WORKER_POLL_MS + 1);
    expect(rowOf(stale, HealthRow.Worker)?.level).toBe(HealthLevel.Red);
    const ended = liveHealth(w.store, { ...w.wiki, childRunning: false }, T0 + 1);
    expect(rowOf(ended, HealthRow.Worker)).toMatchObject({ level: HealthLevel.Red });
    expect(rowOf(ended, HealthRow.Worker)?.detail).toContain("stopped");
  });

  it("counts the failed requests of the window and reads a credential failure as red", () => {
    const old = enqueueRequest(w.store, { change: "a", justification: "j" }, T0 - 2 * HEALTH_WINDOW_MS);
    for (let i = 0; i < 3; i++) failAttempt(w.store, old, "boom", T0 - 2 * HEALTH_WINDOW_MS + i);
    const recent = enqueueRequest(w.store, { change: "b", justification: "j" }, T0);
    for (let i = 0; i < 3; i++) failAttempt(w.store, recent, "boom", T0 + i);
    expect(failedRequestsIn(w.store, T0 + 10).map((r) => r.id)).toEqual([recent]);
    const yellow = liveHealth(w.store, w.wiki, T0 + 10);
    expect(rowOf(yellow, HealthRow.FailedRequests)).toMatchObject({ level: HealthLevel.Yellow });
    expect(rowOf(yellow, HealthRow.FailedRequests)?.detail).toBe("1 in 24 hours");
    const cred = enqueueRequest(w.store, { change: "c", justification: "j" }, T0);
    for (let i = 0; i < 3; i++) failAttempt(w.store, cred, "HTTP 401 unauthorized", T0 + i);
    const red = liveHealth(w.store, w.wiki, T0 + 10);
    expect(rowOf(red, HealthRow.FailedRequests)).toMatchObject({ level: HealthLevel.Red });
    expect(rowOf(red, HealthRow.FailedRequests)?.detail).toContain("1 on a credential failure");
  });

  it("keeps a long queue out of the verdict: the queue is load, not a fault", () => {
    writeWorkerStatus(w.store, { pid: process.pid, startedAt: T0, lastPollAt: T0 + 1000, consecutiveFailures: 0 });
    writeFileSync(`${w.wiki.dbPath}.lock`, String(process.pid));
    for (let i = 0; i < 606; i++) enqueueRequest(w.store, { change: `q${i}`, justification: "j" }, T0 + i);
    const report = liveHealth(w.store, w.wiki, T0 + 2000);
    expect(report.rows.map((r) => r.row)).not.toContain("queue");
    expect(report.verdict).toBe(HealthLevel.Green);
  });

  it("reads the failed calls of the last hour from the stored tool calls", () => {
    for (let i = 0; i < FAILED_CALLS_RED_MIN; i++) {
      recordToolCall(w.store, { at: T0, tool: McpToolName.Search, ok: false, durationMs: 1 });
    }
    const row = rowOf(liveHealth(w.store, w.wiki, T0 + 1), HealthRow.FailedCalls);
    expect(row?.level).toBe(HealthLevel.Red);
    expect(row?.detail).toBe(`${FAILED_CALLS_RED_MIN} of ${FAILED_CALLS_RED_MIN} in the last hour`);
    // The calls leave the last hour: the row is green again.
    const later = rowOf(liveHealth(w.store, w.wiki, T0 + HOUR_MS + 1), HealthRow.FailedCalls);
    expect(later?.level).toBe(HealthLevel.Green);
  });
});
