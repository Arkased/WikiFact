import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LogLine } from "../../log/index.js";
import {
  CleanupFinder,
  LogEvent,
  LogLevel,
  OperatorEditKind,
  ProcessOutcome,
  RequestStatus,
  RunOnceStatus,
} from "../../domain/enums.js";
import {
  CLEANUP_CAP,
  CLEANUP_FINDERS,
  closeStore,
  enqueueOperatorEdit,
  highestChangeSeq,
  openStore,
  parseCleanupRepair,
  readCleanupFull,
  readCleanupSeq,
  writeCleanupFull,
  writeCleanupSeq,
  type Store,
} from "../../store/index.js";
import { T0, makeStore } from "../../../__tests__/helpers/store.js";
import { runOnce, runWorker, type RunOnceResult } from "../index.js";
import { cleanupIfDue, runCleanup } from "../cleanup-run.js";
import { duplicatePairs, queuedRepairs, seqsAt, workerConfig } from "./helpers/cleanup.js";
import { scripted } from "./helpers/scripted-questions.js";

const stores: Store[] = [];
afterEach(() => {
  logs.length = 0;
  for (const s of stores.splice(0)) closeStore(s);
});

function must<T>(x: T | undefined | null): T {
  if (x === undefined || x === null) throw new Error("expected a value");
  return x;
}

function fresh(): Store {
  const s = makeStore();
  stores.push(s);
  return s;
}

const logs: LogLine[] = [];
const log = (l: LogLine): void => void logs.push(l);
const runLines = (): LogLine[] => logs.filter((l) => l.event === LogEvent.CleanupRun);

describe("the cleanup trigger", () => {
  it("writes the current seq and queues nothing when the key is absent, so a store with old duplicates starts no backlog", async () => {
    const s = fresh();
    const res = await duplicatePairs(s, 1);
    expect(readCleanupSeq(s)).toBeUndefined();
    expect(cleanupIfDue(s, log)).toBeUndefined();
    expect(readCleanupSeq(s)).toEqual(seqsAt(res.seq));
    expect(queuedRepairs(s)).toEqual([]);
    expect(runLines()).toEqual([]);
  });

  it("writes 0 for every finder when the key is absent and no change exists", () => {
    const s = fresh();
    expect(cleanupIfDue(s, log)).toBeUndefined();
    expect(readCleanupSeq(s)).toEqual(seqsAt(0));
  });

  it("runs nothing and logs nothing while no write is newer than cleanup_seq", async () => {
    const s = fresh();
    const res = await duplicatePairs(s, 1);
    writeCleanupSeq(s, seqsAt(res.seq));
    expect(cleanupIfDue(s, log)).toBeUndefined();
    expect(readCleanupSeq(s)).toEqual(seqsAt(res.seq));
    expect(queuedRepairs(s)).toEqual([]);
    expect(runLines()).toEqual([]);
  });

  it("runs a finder that the cap cut once a write exists above its seq, and not when nothing wrote", async () => {
    const s = fresh();
    const res = await duplicatePairs(s, 1);
    // The interval is far off, and the duplicate fact check was cut by the cap in its last run.
    writeCleanupSeq(s, seqsAt(res.seq));
    writeCleanupFull(s, [CleanupFinder.DuplicateFact]);
    expect(cleanupIfDue(s, log)).toBeUndefined();
    expect(runLines()).toEqual([]);
    // A write moves the highest seq above the seq of the finder, though the interval is not reached.
    await duplicatePairs(s, 1);
    const highest = highestChangeSeq(s);
    writeCleanupSeq(s, seqsAt(highest, { [CleanupFinder.DuplicateFact]: highest - 1 }));
    cleanupIfDue(s, log);
    expect(runLines()).toMatchObject([{ finders: [CleanupFinder.DuplicateFact] }]);
    // That run cut nothing: the entry is gone.
    expect(readCleanupFull(s)).toEqual([]);
  });

  it("writes the cap-cut finder to cleanup_full and keeps its seq", async () => {
    const s = fresh();
    await duplicatePairs(s, CLEANUP_CAP + 5);
    writeCleanupSeq(s, seqsAt(7));
    expect(runCleanup(s, T0, log, [CleanupFinder.DuplicateFact])).toBe(CLEANUP_CAP);
    expect(readCleanupFull(s)).toEqual([CleanupFinder.DuplicateFact]);
    expect(readCleanupSeq(s)).toEqual(seqsAt(highestChangeSeq(s)));
    // The 5 others fit now (the 20 are held by queued requests), so the run cuts nothing and drops the entry.
    expect(runCleanup(s, T0 + 1, log, [CleanupFinder.DuplicateFact])).toBe(5);
    expect(readCleanupFull(s)).toEqual([]);
  });

  it("runs once after a new write, logs one cleanup_run line and advances the seq of the finder that ran", async () => {
    const s = fresh();
    const res = await duplicatePairs(s, 1);
    expect(res.seq).toBeGreaterThan(0);
    // The check is due as its last run was cut by the cap and a write is newer.
    writeCleanupSeq(s, seqsAt(res.seq - 1));
    writeCleanupFull(s, [CleanupFinder.DuplicateFact]);
    const before = Date.now();
    expect(cleanupIfDue(s, log)).toBe(1);
    expect(readCleanupSeq(s)).toEqual(seqsAt(res.seq));
    expect(cleanupIfDue(s, log)).toBeUndefined();
    expect(runLines()).toEqual([
      {
        event: LogEvent.CleanupRun,
        level: LogLevel.Info,
        finders: [CleanupFinder.DuplicateFact],
        queued: { [CleanupFinder.DuplicateFact]: 1 },
      },
    ]);
    const [row, ...more] = queuedRepairs(s);
    expect(more).toEqual([]);
    expect(row).toMatchObject({ status: RequestStatus.Queued });
    expect(must(row).received_at).toBeGreaterThanOrEqual(before);
    expect(parseCleanupRepair(must(row).change)).toEqual({
      finder: CleanupFinder.DuplicateFact,
      factIds: [must(res.factIds[0]), must(res.factIds[1])],
    });
  });
});

const config = workerConfig;

describe("the worker", () => {
  it("writes the seq at its first idle poll, then runs the cleanup after a new write, and takes the requests it queued", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wikifact-cleanup-"));
    const dbPath = join(dir, "game.sqlite");
    const s = openStore(dbPath, { embeddingModel: "test-model" });
    stores.push(s);
    await duplicatePairs(s, 1);
    const abort = new AbortController();
    const worker = runWorker({
      dbPath,
      config,
      questions: scripted({}).q,
      pollMs: 10,
      signal: abort.signal,
      log: () => undefined,
    });
    try {
      await vi.waitFor(() => expect(readCleanupSeq(s)).toBeDefined());
      expect(queuedRepairs(s)).toEqual([]);
      // The worker saw the existing write; this one is newer, and the check was cut by the cap.
      writeCleanupSeq(s, seqsAt(0));
      writeCleanupFull(s, [CleanupFinder.DuplicateFact]);
      await vi.waitFor(() => expect(queuedRepairs(s).map((r) => r.status)).toEqual([RequestStatus.Done]));
      expect(must(readCleanupSeq(s))[CleanupFinder.DuplicateFact]).toBeGreaterThan(0);
    } finally {
      abort.abort();
      await worker;
    }
  });

  it("writes an error line when a finder throws, has already advanced cleanup_seq, and keeps polling", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wikifact-cleanup-"));
    const dbPath = join(dir, "game.sqlite");
    const s = openStore(dbPath, { embeddingModel: "test-model" });
    stores.push(s);
    await duplicatePairs(s, 2);
    const lines: LogLine[] = [];
    const errors = (): LogLine[] => lines.filter((l) => l.event === LogEvent.Unhandled);
    const abort = new AbortController();
    const worker = runWorker({
      dbPath,
      config,
      questions: scripted({}).q,
      pollMs: 10,
      signal: abort.signal,
      log: (l) => void lines.push(l),
    });
    try {
      await vi.waitFor(() => expect(readCleanupSeq(s)).toBeDefined());
      // The worker created the schema when it opened the store. Every finder reads this view, so a run throws.
      s.db.exec("DROP VIEW current_fact_versions");
      writeCleanupSeq(s, seqsAt(0));
      writeCleanupFull(s, [CleanupFinder.DuplicateFact]);
      await vi.waitFor(() => expect(errors()).toHaveLength(1));
      expect(errors()[0]).toMatchObject({
        level: LogLevel.Error,
        error: expect.stringContaining("cleanup") as string,
      });
      expect(must(readCleanupSeq(s))[CleanupFinder.DuplicateFact]).toBe(highestChangeSeq(s));
      expect(queuedRepairs(s)).toEqual([]);
      // The worker still polls: a second due run reaches the finder and fails the same way.
      writeCleanupSeq(s, seqsAt(0));
      await vi.waitFor(() => expect(errors()).toHaveLength(2));
    } finally {
      abort.abort();
      await worker;
    }
    expect(lines.some((l) => l.event === LogEvent.WorkerStop)).toBe(true);
  });
});

describe("the operator cleanup edit", () => {
  const done = (r: RunOnceResult) => {
    if (r.status !== RunOnceStatus.Done) throw new Error(`expected done, got ${JSON.stringify(r)}`);
    return r.result;
  };
  const run = (s: Store): Promise<RunOnceResult> =>
    runOnce(s, scripted({}).q, { subject: "Minecraft" }, { log, now: () => T0 + 99 });

  it("always runs the finders, writes cleanup_seq and queues the requests behind it", async () => {
    const s = fresh();
    const seeded = await duplicatePairs(s, 1);
    // Even with nothing newer than cleanup_seq, the operator run runs.
    writeCleanupSeq(s, seqsAt(seeded.seq));
    enqueueOperatorEdit(s, { edit: OperatorEditKind.Cleanup, note: "run it now" });
    const res = done(await run(s));
    expect(res.outcome).toBe(ProcessOutcome.Skipped);
    expect(readCleanupSeq(s)).toEqual(seqsAt(seeded.seq));
    expect(runLines()).toMatchObject([{ finders: CLEANUP_FINDERS }]);
    expect(runLines()).toMatchObject([{ queued: { [CleanupFinder.DuplicateFact]: 1 } }]);
    expect(queuedRepairs(s)).toHaveLength(1);
    expect(parseCleanupRepair(must(queuedRepairs(s)[0]).change).finder).toBe(CleanupFinder.DuplicateFact);
  });
});
