import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseConfig } from "../../src/config/index.js";
import {
  BatchRunStatus,
  CallFailureKind,
  ChangeOutcome,
  LogEvent,
  PauseReason,
  ProcessOutcome,
  Q4Relation,
  RequestStatus,
  RunOnceStatus,
  WorkerState,
} from "../../src/domain/enums.js";
import type { LogLine } from "../../src/log/index.js";
import {
  clearQueuePause,
  closeStore,
  enqueueRequest,
  getRequest,
  MAX_ATTEMPTS,
  openStore,
  readWorkerStatus,
  setQueuePause,
  StoreMismatchError,
  type Store,
  type WorkerStatus,
} from "../../src/store/index.js";
import { StubQuestions } from "../../fakes/stub-questions.js";
import { commands } from "../../src/updates/commands.js";
import { acquireLock, createQuestions, LockError, runOnce, runWorker } from "../../src/updates/index.js";
import {
  nextBatchWorkerStatus,
  nextRateLimitPauseMs,
  nextWorkerStatus,
  resumedWorkerStatus,
  RATE_LIMIT_PAUSE_MAX_MS,
  RATE_LIMIT_PAUSE_MS,
  RATE_LIMIT_RESET_MARGIN_MS,
} from "../../src/updates/worker-status.js";
import { PROCESS_START_TIMEOUT_MS } from "../helpers/timeouts.js";
import { cfg, count, world } from "../helpers/updates.js";

function must<T>(x: T | undefined | null): T {
  if (x === undefined || x === null) throw new Error("expected a value");
  return x;
}

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "wikifact-"));
  return d;
}
afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

const parsed = parseConfig({ embeddingModel: "test-model" });
// No wait: a queued submission starts its batch at the next poll, as a request ran at once before.
const config = { ...parsed, highVolume: { ...parsed.highVolume, waitMs: 0 } };
// A batch of 1: the calls of a test with a scripted order of answers come one request at a time.
const oneAtATime = { ...config, highVolume: { ...config.highVolume, batchSize: 1 } };
const open = (db: string): Store => openStore(db, { embeddingModel: "test-model" });
const silent = () => undefined;

describe("the lock file", () => {
  it("blocks a second worker and is removed on release", () => {
    const db = join(tmpDir(), "game.sqlite");
    const release = acquireLock(db);
    expect(existsSync(`${db}.lock`)).toBe(true);
    expect(() => acquireLock(db)).toThrow(LockError);
    release();
    expect(existsSync(`${db}.lock`)).toBe(false);
    acquireLock(db)();
  });

  it("takes over a lock whose process is gone", { timeout: PROCESS_START_TIMEOUT_MS }, () => {
    const db = join(tmpDir(), "game.sqlite");
    const child = spawnSync(process.execPath, ["-e", "0"]);
    writeFileSync(`${db}.lock`, String(child.pid));
    const release = acquireLock(db);
    expect(existsSync(`${db}.lock`)).toBe(true);
    release();
  });

  it("runWorker refuses to start while another worker holds the lock, and removes its own lock on exit", async () => {
    const db = join(tmpDir(), "game.sqlite");
    const abort = new AbortController();
    const first = runWorker({
      dbPath: db,
      config,
      questions: new StubQuestions(),
      pollMs: 10,
      signal: abort.signal,
      log: silent,
    });
    await vi.waitFor(() => expect(existsSync(`${db}.lock`)).toBe(true));
    await expect(
      runWorker({ dbPath: db, config, questions: new StubQuestions(), pollMs: 10, log: silent }),
    ).rejects.toThrow(LockError);
    abort.abort();
    await first;
    expect(existsSync(`${db}.lock`)).toBe(false);
  });

  it("createQuestions (step 5) builds the real questions without a network call or a key", () => {
    const qs = createQuestions(config, {
      send: () => Promise.reject(new Error("no network")),
    });
    expect(qs.takeUsage?.()).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });
});

describe('worker status (technical/updates.md, "Queue and worker")', () => {
  it("writes the status at start, and records a credential-looking failure with its kind", async () => {
    const db = join(tmpDir(), "game.sqlite");
    const s = open(db);
    enqueueRequest(s, { change: "Creepers do 10 damage.", justification: "I saw it." });
    closeStore(s);
    const abort = new AbortController();
    const questions = new StubQuestions({
      q4: () => {
        throw new Error('401 {"type":"error","error":{"type":"authentication_error"}}');
      },
    });
    const p = runWorker({
      dbPath: db,
      config,
      questions,
      pollMs: 10,
      retryDelayMs: 10,
      signal: abort.signal,
      log: silent,
    });
    const check = open(db);
    await vi.waitFor(() => expect(readWorkerStatus(check)?.lastCall?.ok).toBe(false));
    abort.abort();
    await p;
    const status = must(readWorkerStatus(check));
    expect(status.pid).toBe(process.pid);
    expect(status.lastPollAt).toBeGreaterThanOrEqual(status.startedAt);
    expect(status.consecutiveFailures).toBeGreaterThanOrEqual(1);
    expect(status.lastCall).toMatchObject({ ok: false, kind: CallFailureKind.Credential });
    closeStore(check);
  });

  it("classifies the failure texts and resets the count on a success", () => {
    const base = { pid: 1, startedAt: 0, lastPollAt: 0, consecutiveFailures: 0 };
    const failed = (error: string) =>
      nextWorkerStatus(base, { status: RunOnceStatus.Queued, requestId: "r", error }, 5);
    expect(failed("429 too many").lastCall).toMatchObject({ kind: CallFailureKind.RateLimit });
    expect(failed("claude reported an error: Not logged in").lastCall).toMatchObject({
      kind: CallFailureKind.Credential,
    });
    expect(failed("boom").lastCall).toMatchObject({ kind: CallFailureKind.Other, message: "boom", at: 5 });
    const after = nextWorkerStatus(
      failed("boom"),
      {
        status: RunOnceStatus.Done,
        requestId: "r",
        result: { outcome: ProcessOutcome.Accepted, mergeSeqs: [], passes: 0, rejudged: 0 },
      },
      9,
    );
    expect(after).toMatchObject({ consecutiveFailures: 0, lastPollAt: 9, lastCall: { ok: true, at: 9 } });
  });

  it("records a failed promotion as its own event: no model call failed, so the call and the count stay", () => {
    const base: WorkerStatus = {
      pid: 1,
      startedAt: 0,
      lastPollAt: 0,
      consecutiveFailures: 1,
      lastCall: { ok: true, at: 2 },
    };
    const dropped = nextBatchWorkerStatus(
      base,
      { status: BatchRunStatus.Dropped, error: "the promotion failed: x", ids: [] },
      5,
    );
    expect(dropped).toMatchObject({
      consecutiveFailures: 1,
      lastCall: { ok: true, at: 2 },
      lastPollAt: 5,
      lastBatchError: { message: "the promotion failed: x", at: 5 },
    });
    // The pause fields rebuild the status: the event survives a resume.
    expect(resumedWorkerStatus(dropped).lastBatchError).toMatchObject({ at: 5 });
    // A batch that ends clears it.
    const done = nextBatchWorkerStatus(
      dropped,
      { status: BatchRunStatus.Done, size: 1, outcomes: {}, failed: 0, stale: 0, merged: 0, promoted: 1 },
      9,
    );
    expect(done.lastBatchError).toBeUndefined();
  });
});

describe('attempts (technical/updates.md, "System failures", F12)', () => {
  // The count and the final status are the requirement test `Failed request`.
  it("logs one line per failed attempt, and the last one carries the final status", async () => {
    const w = world({
      q4: () => {
        throw new Error("model said no");
      },
    });
    const id = w.enqueue("Creepers do 10 damage.", "I saw it.");
    for (let i = 0; i < MAX_ATTEMPTS; i++) await w.run();
    const failures = w.logs.filter((l) => l.event === LogEvent.AttemptFailed);
    expect(failures).toHaveLength(MAX_ATTEMPTS);
    expect(failures[MAX_ATTEMPTS - 1]).toMatchObject({ status: RunOnceStatus.Failed, request_id: id });
  });

  it("F18, F19 and F21 reach this layer as a thrown error and take the same path", async () => {
    for (const message of ["output invalid twice", "refusal after fallback", "question timed out after 120 s"]) {
      const w = world({
        q1: () => {
          throw new Error(message);
        },
      });
      // q1 only runs when there are candidates.
      await w.seed({ header: "Creeper damage", content: "Creepers do 10 damage." });
      const { id, r } = await w.submit("Creepers do 12 damage.", "I saw it.");
      expect(r).toMatchObject({ status: RunOnceStatus.Queued, error: message });
      expect(must(getRequest(w.store, id)).attempts).toBe(1);
    }
  });
});

describe('one transaction (technical/updates.md, "System failures", F13)', () => {
  it("a crash between the commit and finishRequest repeats the request as a duplicate (accepted behavior)", async () => {
    const w = world();
    const { id } = await w.submit("Creepers do 10 damage.", "I saw it.");
    // The row is done. Simulate the crash: the row is running again, as after a restart reset.
    w.store.db.prepare("UPDATE change_requests SET status = ? WHERE id = ?").run(RequestStatus.Queued, id);
    const factId = (w.store.db.prepare("SELECT fact_id FROM fact_versions").get() as { fact_id: string }).fact_id;
    w.q.set("q1", { matches: [factId] });
    w.q.set("q4", { supported: true, relation: Q4Relation.Same, wrongRelated: [], reason: "r" });
    const r = await w.run();
    expect(r.status).toBe(RunOnceStatus.Done);
    expect(count(w.store, "fact_versions")).toBe(1);
    expect(count(w.store, "retrievals", "kind = 'confirm'")).toBe(1);
  });
});

describe("pause between attempts", () => {
  it("runWorker waits attempts * retryDelayMs after a failed attempt", async () => {
    const db = join(tmpDir(), "game.sqlite");
    const s = open(db);
    const id = enqueueRequest(s, { change: "Creepers do 10 damage.", justification: "I saw it." });
    closeStore(s);
    const questions = new StubQuestions({
      q4: [
        () => {
          throw new Error("model said no");
        },
        { supported: true, wrongRelated: [], reason: "ok" },
      ],
    });
    const abort = new AbortController();
    const retryDelayMs = 400;
    // The timers of the loop are fake; the model load and the database stay real.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    let attemptFailed!: () => void;
    const failed = new Promise<void>((r) => (attemptFailed = r));
    const p = runWorker({
      dbPath: db,
      config,
      questions,
      pollMs: 10,
      retryDelayMs,
      signal: abort.signal,
      log: (l) => {
        if (l.event === LogEvent.AttemptFailed) attemptFailed();
      },
    });
    const check = open(db);
    try {
      await failed;
      // One tick short of the delay: the request still waits.
      await vi.advanceTimersByTimeAsync(retryDelayMs - 1);
      expect(must(getRequest(check, id))).toMatchObject({ status: RequestStatus.Queued, attempts: 1 });
      // The last tick ends the wait, and the second attempt runs.
      await vi.advanceTimersByTimeAsync(1);
    } finally {
      vi.useRealTimers();
    }
    await vi.waitFor(() => expect(must(getRequest(check, id)).status).toBe(RequestStatus.Done));
    abort.abort();
    await p;
    closeStore(check);
  });
});

describe('rate limit pause (technical/updates.md, "Model call failures")', () => {
  it("doubles the pause on each rate limit in a row up to the ceiling", () => {
    const first = nextRateLimitPauseMs(undefined);
    expect(first).toBe(RATE_LIMIT_PAUSE_MS);
    expect(nextRateLimitPauseMs(first)).toBe(RATE_LIMIT_PAUSE_MS * 2);
    let wait = first;
    for (let i = 0; i < 20; i++) wait = nextRateLimitPauseMs(wait);
    expect(wait).toBe(RATE_LIMIT_PAUSE_MAX_MS);
    expect(nextRateLimitPauseMs(RATE_LIMIT_PAUSE_MAX_MS - 1)).toBe(RATE_LIMIT_PAUSE_MAX_MS);
  });

  it("records the rate limit in the status without counting a failure", () => {
    const base = { pid: 1, startedAt: 0, lastPollAt: 0, consecutiveFailures: 1 };
    const after = nextWorkerStatus(base, { status: RunOnceStatus.RateLimited, requestId: "r", error: "429" }, 5);
    expect(after).toMatchObject({ consecutiveFailures: 1, lastCall: { ok: false, kind: CallFailureKind.RateLimit } });
  });

  it("runWorker leaves the request queued, pauses, doubles the pause, and starts again after a success", async () => {
    const db = join(tmpDir(), "game.sqlite");
    const s = open(db);
    const first = enqueueRequest(s, { change: "Creepers do 10 damage.", justification: "I saw it." });
    const second = enqueueRequest(s, { change: "Zombies do 5 damage.", justification: "I saw it." });
    closeStore(s);
    // The calls of q4 in order: 2 rate limits, a success, a rate limit, a success.
    const limit = () => {
      throw new Error("429 rate limit");
    };
    const ok = { supported: true, wrongRelated: [], reason: "ok" };
    const questions = new StubQuestions({ q4: [limit, limit, ok, limit, ok] });
    const lines: LogLine[] = [];
    let wake: () => void = () => undefined;
    const abort = new AbortController();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const nextPause = (): Promise<void> => new Promise<void>((r) => (wake = r));
    const pauses = (): number[] => lines.flatMap((l) => (l.event === LogEvent.RateLimitPause ? [l.waitMs] : []));
    let waiting = nextPause();
    const p = runWorker({
      dbPath: db,
      config: oneAtATime,
      questions,
      pollMs: 10,
      retryDelayMs: 10,
      signal: abort.signal,
      log: (l) => {
        lines.push(l);
        if (l.event === LogEvent.RateLimitPause) wake();
      },
    });
    const check = open(db);
    try {
      await waiting;
      expect(pauses()).toEqual([RATE_LIMIT_PAUSE_MS]);
      expect(must(getRequest(check, first))).toMatchObject({ status: RequestStatus.Queued, attempts: 0 });
      expect(readWorkerStatus(check)).toMatchObject({ state: WorkerState.Paused, pauseReason: PauseReason.RateLimit });
      expect(lines.some((l) => l.event === LogEvent.AttemptFailed)).toBe(false);
      // One tick short of the pause: the worker takes no request.
      await vi.advanceTimersByTimeAsync(RATE_LIMIT_PAUSE_MS - 1);
      expect(pauses()).toHaveLength(1);
      expect(must(getRequest(check, first)).status).toBe(RequestStatus.Queued);
      // The last tick ends the pause; the second rate limit doubles it.
      waiting = nextPause();
      await vi.advanceTimersByTimeAsync(1);
      await waiting;
      expect(pauses()).toEqual([RATE_LIMIT_PAUSE_MS, RATE_LIMIT_PAUSE_MS * 2]);
      expect(must(getRequest(check, first))).toMatchObject({ status: RequestStatus.Queued, attempts: 0 });
      // The third call succeeds, so the first request is done; the next rate limit starts at the first pause again.
      waiting = nextPause();
      await vi.advanceTimersByTimeAsync(RATE_LIMIT_PAUSE_MS * 2);
      await waiting;
      expect(pauses()).toEqual([RATE_LIMIT_PAUSE_MS, RATE_LIMIT_PAUSE_MS * 2, RATE_LIMIT_PAUSE_MS]);
      expect(must(getRequest(check, first)).status).toBe(RequestStatus.Done);
      expect(must(getRequest(check, second))).toMatchObject({ status: RequestStatus.Queued, attempts: 0 });
      await vi.advanceTimersByTimeAsync(RATE_LIMIT_PAUSE_MS);
    } finally {
      vi.useRealTimers();
    }
    await vi.waitFor(() => expect(must(getRequest(check, second)).status).toBe(RequestStatus.Done));
    expect(readWorkerStatus(check)?.state).toBeUndefined();
    abort.abort();
    await p;
    closeStore(check);
  });

  it.each([
    {
      name: "sleeps until the reset time plus the margin",
      reset: "4pm",
      expected: Date.parse("2026-10-19T23:00:00Z") + RATE_LIMIT_RESET_MARGIN_MS,
    },
    { name: "falls back to the doubled wait for a reset in the past", reset: "Oct 18, 4pm", expected: undefined },
  ])("$name when the error names the reset", async ({ reset, expected }) => {
    const db = join(tmpDir(), "game.sqlite");
    const s = open(db);
    const id = enqueueRequest(s, { change: "Creepers do 10 damage.", justification: "I saw it." });
    closeStore(s);
    const now = Date.parse("2026-10-19T12:00:00Z"); // 05:00 in Los Angeles
    const ok = { supported: true, wrongRelated: [], reason: "ok" };
    const limit = (): never => {
      throw new Error(`429 rate limit: You've hit your session limit · resets ${reset} (America/Los_Angeles)`);
    };
    const questions = new StubQuestions({ q4: [limit, ok] });
    const lines: LogLine[] = [];
    const abort = new AbortController();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"], now });
    let paused!: () => void;
    const pausedLogged = new Promise<void>((r) => (paused = r));
    const p = runWorker({
      dbPath: db,
      config: oneAtATime,
      questions,
      pollMs: 10,
      signal: abort.signal,
      log: (l) => {
        lines.push(l);
        if (l.event === LogEvent.RateLimitPause) paused();
      },
    });
    const check = open(db);
    try {
      await pausedLogged;
      const waitMs = (expected ?? now + RATE_LIMIT_PAUSE_MS) - now;
      expect(lines.find((l) => l.event === LogEvent.RateLimitPause)).toMatchObject({ waitMs });
      expect(readWorkerStatus(check)).toMatchObject({ state: WorkerState.Paused, pausedUntil: now + waitMs });
      await vi.advanceTimersByTimeAsync(waitMs - 1);
      expect(must(getRequest(check, id)).status).toBe(RequestStatus.Queued);
      await vi.advanceTimersByTimeAsync(1);
    } finally {
      vi.useRealTimers();
    }
    await vi.waitFor(() => expect(must(getRequest(check, id)).status).toBe(RequestStatus.Done));
    abort.abort();
    await p;
    closeStore(check);
  });

  it("ends the pause at once when the worker is told to stop", async () => {
    const db = join(tmpDir(), "game.sqlite");
    const s = open(db);
    const id = enqueueRequest(s, { change: "Creepers do 10 damage.", justification: "I saw it." });
    closeStore(s);
    const questions = new StubQuestions({
      q4: () => {
        throw new Error("429 rate limit");
      },
    });
    const abort = new AbortController();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    let paused!: () => void;
    const pausedLogged = new Promise<void>((r) => (paused = r));
    const p = runWorker({
      dbPath: db,
      config,
      questions,
      signal: abort.signal,
      log: (l) => {
        if (l.event === LogEvent.RateLimitPause) paused();
      },
    });
    try {
      await pausedLogged;
      abort.abort();
      await p;
    } finally {
      vi.useRealTimers();
    }
    const check = open(db);
    expect(must(getRequest(check, id))).toMatchObject({ status: RequestStatus.Queued, attempts: 0 });
    closeStore(check);
  });
});

describe('operator pause (technical/updates.md, "Queue and worker")', () => {
  it("takes no request while the key exists, logs the pause once, and resumes at the next poll after the key is gone", async () => {
    const db = join(tmpDir(), "game.sqlite");
    const s = open(db);
    const id = enqueueRequest(s, { change: "Creepers do 10 damage.", justification: "I saw it." });
    setQueuePause(s, "measuring", 1234);
    const pollMs = 50;
    const lines: LogLine[] = [];
    const abort = new AbortController();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    let seen!: () => void;
    const pauseLogged = new Promise<void>((r) => (seen = r));
    const p = runWorker({
      dbPath: db,
      config,
      questions: new StubQuestions(),
      pollMs,
      signal: abort.signal,
      log: (l) => {
        lines.push(l);
        if (l.event === LogEvent.QueuePause) seen();
      },
    });
    try {
      await pauseLogged;
      await vi.advanceTimersByTimeAsync(pollMs * 5);
      expect(must(getRequest(s, id))).toMatchObject({ status: RequestStatus.Queued, attempts: 0 });
      expect(readWorkerStatus(s)).toMatchObject({
        state: WorkerState.Paused,
        pauseReason: PauseReason.Operator,
        pausedSince: 1234,
      });
      expect(readWorkerStatus(s)?.pausedUntil).toBeUndefined();
      expect(lines.filter((l) => l.event === LogEvent.QueuePause)).toEqual([
        expect.objectContaining({ note: "measuring" }),
      ]);
      clearQueuePause(s);
      await vi.advanceTimersByTimeAsync(pollMs);
    } finally {
      vi.useRealTimers();
    }
    await vi.waitFor(() => expect(must(getRequest(s, id)).status).toBe(RequestStatus.Done));
    expect(readWorkerStatus(s)?.state).toBeUndefined();
    expect(lines.filter((l) => l.event === LogEvent.QueueResume)).toHaveLength(1);
    abort.abort();
    await p;
    closeStore(s);
  });
});

describe("runOnce", () => {
  it("returns idle on an empty queue", async () => {
    const w = world();
    expect(await runOnce(w.store, w.q, cfg, { log: silent })).toEqual({ status: RunOnceStatus.Idle });
  });
});

describe("commands", () => {
  async function fileDb() {
    const db = join(tmpDir(), "game.sqlite");
    // wikifact.json absent: the defaults apply, so the store uses the default embedding model.
    const { loadConfig } = await import("../../src/config/index.js");
    const c = loadConfig(db);
    const s = openStore(db, { embeddingModel: c.embeddingModel });
    return { db, s };
  }
  const cmd = (name: string) => must(commands.find((c) => c.name === name));

  it("F14: check exits 1 on drift, reindex repairs it", async () => {
    const { db, s } = await fileDb();
    const { applyChange } = await import("../../src/store/index.js");
    const rid = enqueueRequest(s, { change: "c", justification: "j" });
    await applyChange(s, rid, {
      outcome: ChangeOutcome.Accepted,
      summary: "s",
      changeReasoning: "r",
      facts: [
        {
          header: "Creeper damage",
          content: "Creepers do 10 damage.",
          justification: "j",
          references: [],
        },
      ],
    });
    s.db.prepare("DELETE FROM current_vec").run();
    closeStore(s);

    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((s: unknown) => {
      out.push(String(s).trimEnd());
      return true;
    });
    await cmd("check").run({ db, rest: [] });
    expect(process.exitCode).toBe(1);
    expect(out.join("\n")).toContain("current_vec");

    process.exitCode = undefined;
    await cmd("reindex").run({ db, rest: [] });
    out.length = 0;
    await cmd("check").run({ db, rest: [] });
    expect(process.exitCode).toBeUndefined();
  });

  it("F15: a changed embedding model makes the commands refuse to open the store", async () => {
    const { db, s } = await fileDb();
    closeStore(s);
    writeFileSync(join(db, "..", "wikifact.json"), JSON.stringify({ embeddingModel: "other/model-768" }));
    await expect(cmd("check").run({ db, rest: [] })).rejects.toThrow(StoreMismatchError);
  });

  it("F12: requeue lists failed rows and puts one back", async () => {
    const { db, s } = await fileDb();
    const id = enqueueRequest(s, { change: "Creepers do 10 damage.", justification: "j" });
    s.db
      .prepare("UPDATE change_requests SET status = 'failed', attempts = 3, error = 'API overloaded' WHERE id = ?")
      .run(id);
    closeStore(s);
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((s: unknown) => {
      out.push(String(s).trimEnd());
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await cmd("requeue").run({ db, rest: [] });
    expect(out[0]).toContain(id);
    expect(out[0]).toContain("API overloaded");

    await cmd("requeue").run({ db, rest: [id] });
    expect(out[1]).toContain(id);
    const again = open2(db);
    expect(getRequest(again, id)).toMatchObject({ status: RequestStatus.Queued, attempts: 0 });
    closeStore(again);

    await cmd("requeue").run({ db, rest: [id] });
    expect(process.exitCode).toBe(1);
  });
});

function open2(db: string): Store {
  return openStore(db, { embeddingModel: parseConfig({}).embeddingModel });
}
