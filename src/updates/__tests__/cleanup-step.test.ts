// The cleanup step of the worker (technical/cleanup.md, "When it runs"): where the loop runs it, and how it ends.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CleanupFinder, LogEvent, RequestKind, RequestStatus } from "../../domain/enums.js";
import type { LogLine } from "../../log/index.js";
import {
  closeStore,
  enqueueCleanupRepair,
  enqueueRequest,
  getRequest,
  MAX_ATTEMPTS,
  openStore,
  seedChange,
  writeCleanupFull,
  writeCleanupSeq,
  type Store,
} from "../../store/index.js";
import { StubQuestions, draftOf } from "../../../fakes/stub-questions.js";
import { accepted, draft } from "../../../__tests__/helpers/store.js";
import { RATE_LIMIT_PAUSE_MS } from "../worker-status.js";
import { runWorker } from "../index.js";
import { duplicatePairs, seqsAt, workerConfig } from "./helpers/cleanup.js";
import { scripted, type Scripted } from "./helpers/scripted-questions.js";
import type { Q1Input, Q1Output } from "../types.js";

const FINDER = CleanupFinder.DuplicateFact;
const stores: Store[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const s of stores.splice(0)) closeStore(s);
});

// A batch of `n` submissions starts at the next poll (the wait is 0).
const batchOf = (n: number): typeof workerConfig => ({
  ...workerConfig,
  highVolume: { ...workerConfig.highVolume, batchSize: n },
});

interface Setup {
  dbPath: string;
  s: Store;
  /** The facts of the pairs, 2 per pair. */
  factIds: string[];
}

// A store with `pairs` pairs of near-duplicate facts and a due check: the cap cut the last run, 1 seq behind the last write.
async function dueStore(pairs: number): Promise<Setup> {
  const dbPath = join(mkdtempSync(join(tmpdir(), "wikifact-step-")), "game.sqlite");
  const s = openStore(dbPath, { embeddingModel: "test-model" });
  stores.push(s);
  const res = await duplicatePairs(s, pairs);
  writeCleanupSeq(s, seqsAt(0));
  writeCleanupFull(s, [FINDER]);
  return { dbPath, s, factIds: res.factIds };
}

const submit = (s: Store, change: string): string => enqueueRequest(s, { change, justification: "I saw it." });

const statusesOf = (s: Store, kind: RequestKind): RequestStatus[] =>
  (
    s.db.prepare("SELECT status FROM change_requests WHERE kind = ? ORDER BY received_at, rowid").all(kind) as {
      status: RequestStatus;
    }[]
  ).map((r) => r.status);

// Q1 also judges the submissions; the texts of the pairs of `duplicatePairs` start with "Pair", the submissions' do not.
const isRepair = (input: Q1Input): boolean => input.change.includes("Pair");
const repairCalls = (q: Scripted): number => q.q1.filter(isRepair).length;
const noMatch = (): Q1Output => ({ matches: [] });
const failing = (): never => {
  throw new Error("model said no");
};

// The number of submissions that wait (queued or running) at each `cleanup_run` line.
function waitingAtRuns(s: Store, lines: LogLine[]): (l: LogLine) => void {
  return (l) => {
    if (l.event !== LogEvent.CleanupRun) return;
    const row = s.db
      .prepare("SELECT count(*) AS n FROM change_requests WHERE kind = ? AND status IN (?, ?)")
      .get(RequestKind.Submission, RequestStatus.Queued, RequestStatus.Running) as { n: number };
    lines.push({ ...l, queued: { [FINDER]: row.n } });
  };
}
const waiting = (lines: LogLine[]): number[] =>
  lines.flatMap((l) => (l.event === LogEvent.CleanupRun ? [l.queued[FINDER] ?? -1] : []));

describe("where the worker runs the cleanup step", () => {
  // Each test keeps a submission or a request queued behind the request that ends. A step that runs only at an idle poll
  // would see 0 waiting submissions.
  it("runs it after a batch that ended, with the next batch still queued", async () => {
    const { dbPath, s } = await dueStore(1);
    submit(s, "Creepers do 10 damage.");
    submit(s, "Zombies do 5 damage.");
    const lines: LogLine[] = [];
    const abort = new AbortController();
    const worker = runWorker({
      dbPath,
      config: batchOf(1),
      questions: scripted({}).q,
      pollMs: 10,
      signal: abort.signal,
      log: waitingAtRuns(s, lines),
    });
    try {
      await vi.waitFor(() => expect(waiting(lines).length).toBeGreaterThan(0));
      expect(waiting(lines)[0]).toBe(1);
    } finally {
      abort.abort();
      await worker;
    }
  });

  it("runs it after a dropped batch, before the requests of the batch run 1 at a time", async () => {
    const { dbPath, s } = await dueStore(1);
    const ids = ["Creepers do 10 damage.", "Zombies do 5 damage.", "Spiders do 3 damage."].map((c) => submit(s, c));
    // The live wiki gets a write during the batch, as if a second writer existed: its promotion fails.
    let writes = 0;
    const q = new StubQuestions({
      q5: async (input: { change: string }) => {
        if (writes++ < ids.length) {
          await seedChange(s, accepted([draft({ header: input.change, content: "Written next to the batch" })]));
        }
        return draftOf({ header: input.change, content: input.change });
      },
    });
    const lines: LogLine[] = [];
    const abort = new AbortController();
    const worker = runWorker({
      dbPath,
      config: batchOf(3),
      questions: q,
      pollMs: 10,
      signal: abort.signal,
      log: (l) => {
        waitingAtRuns(s, lines)(l);
        if (l.event === LogEvent.BatchDropped) lines.push(l);
      },
    });
    try {
      await vi.waitFor(() => expect(waiting(lines).length).toBeGreaterThan(0));
      // All 3 requests of the dropped batch still wait; after the first of them ran, 2 would.
      expect(lines.some((l) => l.event === LogEvent.BatchDropped)).toBe(true);
      expect(waiting(lines)[0]).toBe(ids.length);
    } finally {
      abort.abort();
      await worker;
    }
  });

  it("runs it after a request that failed for good, with the next request still queued", async () => {
    const { dbPath, s, factIds } = await dueStore(1);
    // A repair on its last attempt: its failure ends it. The next submission arrives in that failure.
    const repair = enqueueCleanupRepair(s, { finder: FINDER, factIds: [factIds[0] ?? "", factIds[1] ?? ""] });
    s.db.prepare("UPDATE change_requests SET attempts = ? WHERE id = ?").run(MAX_ATTEMPTS - 1, repair);
    let next = "";
    const lines: LogLine[] = [];
    const count = waitingAtRuns(s, lines);
    const abort = new AbortController();
    const worker = runWorker({
      dbPath,
      config: batchOf(1),
      questions: scripted({ q1: (input) => (isRepair(input) ? failing() : noMatch()) }).q,
      pollMs: 10,
      signal: abort.signal,
      log: (l) => {
        if (l.event === LogEvent.AttemptFailed && next === "") next = submit(s, "Zombies do 5 damage.");
        count(l);
      },
    });
    try {
      await vi.waitFor(() => expect(waiting(lines).length).toBeGreaterThan(0));
      expect(getRequest(s, repair)?.status).toBe(RequestStatus.Failed);
      expect(waiting(lines)[0]).toBe(1);
    } finally {
      abort.abort();
      await worker;
    }
  });
});

describe("how the cleanup step ends", () => {
  it("does not run a repair again in the step when it fails an attempt, and runs it in the next step", async () => {
    const { dbPath, s } = await dueStore(1);
    submit(s, "Creepers do 10 damage.");
    const second = submit(s, "Zombies do 5 damage.");
    const q = scripted({ q1: (input) => (isRepair(input) ? failing() : noMatch()) });
    let atSecond: { calls: number; attempts: number[] } | undefined;
    const abort = new AbortController();
    const worker = runWorker({
      dbPath,
      config: batchOf(1),
      questions: q.q,
      pollMs: 10,
      retryDelayMs: 10,
      signal: abort.signal,
      log: (l) => {
        if ("request_id" in l && l.request_id === second && atSecond === undefined) {
          const rows = s.db
            .prepare("SELECT attempts FROM change_requests WHERE kind = ?")
            .all(RequestKind.CleanupRepair) as { attempts: number }[];
          atSecond = { calls: repairCalls(q), attempts: rows.map((r) => r.attempts) };
        }
      },
    });
    try {
      await vi.waitFor(() => expect(atSecond).toBeDefined());
      // The step made 1 attempt of the repair, and the submission ran next.
      expect(atSecond).toEqual({ calls: 1, attempts: [1] });
      // The next step runs the repair again.
      await vi.waitFor(() => expect(repairCalls(q)).toBeGreaterThan(1));
    } finally {
      abort.abort();
      await worker;
    }
  });

  it("runs the second attempt of a repair no earlier than its retry delay, with no submission queued", async () => {
    const { dbPath, s, factIds } = await dueStore(1);
    const repair = enqueueCleanupRepair(s, { finder: FINDER, factIds: [factIds[0] ?? "", factIds[1] ?? ""] });
    // The submission runs first; the repair then runs in the cleanup step, with no submission left in the queue.
    submit(s, "Creepers do 10 damage.");
    const q = scripted({ q1: (input) => (isRepair(input) ? failing() : noMatch()) });
    const RETRY_MS = 10000;
    let failed!: () => void;
    const firstFailed = new Promise<void>((r) => (failed = r));
    const abort = new AbortController();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const worker = runWorker({
      dbPath,
      config: batchOf(1),
      questions: q.q,
      pollMs: 10,
      retryDelayMs: RETRY_MS,
      signal: abort.signal,
      log: (l) => {
        if (l.event === LogEvent.AttemptFailed && l.request_id === repair) failed();
      },
    });
    try {
      await firstFailed;
      // Many polls and steps pass inside the delay: none runs the repair again.
      await vi.advanceTimersByTimeAsync(RETRY_MS - 1000);
      expect(repairCalls(q)).toBe(1);
      expect(getRequest(s, repair)?.attempts).toBe(1);
      await vi.advanceTimersByTimeAsync(2000);
      expect(repairCalls(q)).toBe(2);
    } finally {
      vi.useRealTimers();
      abort.abort();
      await worker;
    }
  });

  it("ends the step at a rate limit, and the repairs left run first in the next step", async () => {
    const { dbPath, s } = await dueStore(3);
    submit(s, "Creepers do 10 damage.");
    const second = submit(s, "Zombies do 5 damage.");
    // The first repair hits the limit, once.
    let limited = false;
    const q = scripted({
      q1: (input) => {
        if (!isRepair(input) || limited) return noMatch();
        limited = true;
        throw new Error("429 rate limit");
      },
    });
    const runLines: LogLine[] = [];
    let callsAtSecond: number | undefined;
    let paused!: () => void;
    const pausedLogged = new Promise<void>((r) => (paused = r));
    const abort = new AbortController();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const worker = runWorker({
      dbPath,
      config: batchOf(1),
      questions: q.q,
      pollMs: 10,
      signal: abort.signal,
      log: (l) => {
        if (l.event === LogEvent.CleanupRun) runLines.push(l);
        if (l.event === LogEvent.RateLimitPause) paused();
        if ("request_id" in l && l.request_id === second && callsAtSecond === undefined) callsAtSecond = repairCalls(q);
      },
    });
    try {
      await pausedLogged;
      // The first repair hit the limit: the other 2 did not run, and the second submission waits for the pause.
      expect(repairCalls(q)).toBe(1);
      expect(statusesOf(s, RequestKind.CleanupRepair)).toEqual(Array(3).fill(RequestStatus.Queued) as RequestStatus[]);
      expect(getRequest(s, second)?.status).toBe(RequestStatus.Queued);
      await vi.advanceTimersByTimeAsync(RATE_LIMIT_PAUSE_MS);
    } finally {
      vi.useRealTimers();
    }
    try {
      await vi.waitFor(() =>
        expect(statusesOf(s, RequestKind.CleanupRepair)).toEqual(Array(3).fill(RequestStatus.Done) as RequestStatus[]),
      );
      // The submission ran first, then the next step ran the 3 repairs before it looked for a due check again.
      expect(callsAtSecond).toBe(1);
      expect(repairCalls(q)).toBe(4);
      expect(runLines).toHaveLength(1);
    } finally {
      abort.abort();
      await worker;
    }
  });

  it("ends the step at a stop, and the repairs left run first in the next worker", async () => {
    const { dbPath, s } = await dueStore(3);
    submit(s, "Creepers do 10 damage.");
    const stop = new AbortController();
    const q: Scripted = scripted({
      q1: (input) => {
        if (isRepair(input) && repairCalls(q) === 1) stop.abort();
        return noMatch();
      },
    });
    await runWorker({
      dbPath,
      config: batchOf(1),
      questions: q.q,
      pollMs: 10,
      signal: stop.signal,
      log: () => undefined,
    });
    // The stop came during the first repair: it ended, and the other 2 stay queued.
    expect(repairCalls(q)).toBe(1);
    expect(statusesOf(s, RequestKind.CleanupRepair).sort()).toEqual(
      [RequestStatus.Done, RequestStatus.Queued, RequestStatus.Queued].sort(),
    );
    const abort = new AbortController();
    const worker = runWorker({
      dbPath,
      config: batchOf(1),
      questions: q.q,
      pollMs: 10,
      signal: abort.signal,
      log: () => undefined,
    });
    try {
      await vi.waitFor(() =>
        expect(statusesOf(s, RequestKind.CleanupRepair)).toEqual(Array(3).fill(RequestStatus.Done) as RequestStatus[]),
      );
      expect(repairCalls(q)).toBe(3);
    } finally {
      abort.abort();
      await worker;
    }
  });
});
