import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseConfig } from "../../../config/index.js";
import { BatchReconciliation, BatchRunStatus, LogEvent, RequestKind, RequestStatus } from "../../../domain/enums.js";
import {
  clearQueuePause,
  closeStore,
  enqueueRequest,
  getRequest,
  openStore,
  readBatchNow,
  readBatchStartSeq,
  readWorkerStatus,
  resetRunning,
  seedChange,
  setQueuePause,
  takeRequest,
  writeBatchNow,
  writeBatchProgress,
  writeBatchStartSeq,
  type Store,
} from "../../../store/index.js";
import { StubQuestions, draftOf } from "../../../../fakes/stub-questions.js";
import type { LogLine } from "../../../log/index.js";
import { accepted, draft, makeFileStore, makeStore } from "../../../../__tests__/helpers/store.js";
import { runWorker } from "../../worker.js";
import { batchStep, planBatch } from "../index.js";

/** The poll interval of the worker in these tests, in ms of the fake clock. */
const POLL_MS = 5;
/** The polls that pass in the held test; under `waitMs`. */
const HELD_POLLS = 20;

const withBatch = (highVolume: { batchSize?: number; waitMs?: number } = {}) =>
  parseConfig({ embeddingModel: "test-model", highVolume });

function submissions(store: Store, n: number, from = 1_000): string[] {
  return Array.from({ length: n }, (_, i) =>
    enqueueRequest(store, { change: `Claim number ${i} about mobs`, justification: "I saw it." }, from + i),
  );
}

describe("when the worker takes a batch", () => {
  const cfg = withBatch({ batchSize: 3, waitMs: 60_000 }).highVolume;

  it("starts when the front holds batchSize submissions, and holds under it", () => {
    const store = makeStore();
    const ids = submissions(store, 2);
    expect(planBatch(store, cfg, 2_000)).toEqual({ ids: [], hold: true });
    ids.push(...submissions(store, 1, 1_500));
    expect(planBatch(store, cfg, 2_000)).toEqual({ ids, hold: false });
  });

  it("takes at most batchSize submissions", () => {
    const store = makeStore();
    const ids = submissions(store, 5);
    expect(planBatch(store, cfg, 2_000).ids).toEqual(ids.slice(0, 3));
  });

  it("starts when the oldest front submission waited waitMs", () => {
    const store = makeStore();
    const ids = submissions(store, 2);
    expect(planBatch(store, cfg, 1_000 + 59_999).ids).toEqual([]);
    expect(planBatch(store, cfg, 1_000 + 60_000)).toEqual({ ids, hold: false });
  });

  it("starts on batch_now with fewer, and deletes the key", () => {
    const store = makeStore();
    const ids = submissions(store, 1);
    writeBatchNow(store, 1_001);
    expect(planBatch(store, cfg, 1_002)).toEqual({ ids, hold: false });
    expect(readBatchNow(store)).toBeUndefined();
  });

  it("deletes batch_now and runs no batch when no submission is queued", () => {
    const store = makeStore();
    writeBatchNow(store, 1_001);
    expect(planBatch(store, cfg, 1_002)).toEqual({ ids: [], hold: false });
    expect(readBatchNow(store)).toBeUndefined();
    submissions(store, 1);
    expect(planBatch(store, cfg, 1_003).ids).toEqual([]);
  });

  it("leaves a request of another kind at the front of the queue to run alone", () => {
    const store = makeStore();
    const fact = submissions(store, 1, 3_000)[0] ?? "";
    enqueueRequest(store, { kind: RequestKind.LookupRepair, targets: [fact] }, 10);
    submissions(store, 3);
    writeBatchNow(store, 1);
    expect(planBatch(store, cfg, 9_999_999)).toEqual({ ids: [], hold: false });
  });
});

describe("the worker loop", () => {
  function setup(batchSize: number): { db: string; config: ReturnType<typeof withBatch> } {
    const dir = mkdtempSync(join(tmpdir(), "wikifact-batch-"));
    return { db: join(dir, "game.sqlite"), config: withBatch({ batchSize, waitMs: 60_000 }) };
  }

  async function runUntilDone(
    run: { db: string; config: ReturnType<typeof withBatch> },
    q: StubQuestions,
    ids: string[],
    lines: LogLine[],
  ) {
    const { db, config } = run;
    const abort = new AbortController();
    const worker = runWorker({
      dbPath: db,
      config,
      questions: q,
      pollMs: 5,
      signal: abort.signal,
      log: (l) => lines.push(l),
    });
    const store = openStore(db, { embeddingModel: "test-model" });
    await vi.waitFor(
      () => expect(ids.map((id) => getRequest(store, id)?.status)).toEqual(ids.map(() => RequestStatus.Done)),
      {
        timeout: 20_000,
      },
    );
    abort.abort();
    await worker;
    closeStore(store);
  }

  it("takes a batch when the queue holds batchSize submissions", async () => {
    const big = setup(3);
    const s = openStore(big.db, { embeddingModel: "test-model" });
    const ids = submissions(s, 3);
    closeStore(s);
    const q = new StubQuestions();
    const lines: LogLine[] = [];
    await runUntilDone(big, q, ids, lines);
    expect(lines.filter((l) => l.event === LogEvent.BatchDone)).not.toHaveLength(0);
    expect(q.count("q7")).toBe(3);
  });

  it("holds fewer submissions until the button asks for the batch, and runs none of them alone", async () => {
    // The clock and the timers are fake: the poll waits of the worker pass when the test advances them, and the wait time of
    // the submissions stays far under `waitMs`.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const run = setup(5);
    const s = openStore(run.db, { embeddingModel: "test-model" });
    const lines: LogLine[] = [];
    const abort = new AbortController();
    let worker: Promise<void> = Promise.resolve();
    try {
      const start = Date.now();
      const ids = [1, 2].map((i) =>
        enqueueRequest(s, { change: `Claim ${i} about mobs`, justification: "I saw it." }, start),
      );
      const q = new StubQuestions();
      worker = runWorker({
        dbPath: run.db,
        config: run.config,
        questions: q,
        pollMs: POLL_MS,
        signal: abort.signal,
        log: (l) => lines.push(l),
      });
      // The status shows polls after the start: the worker looked at the queue, held the submissions and ran none.
      await vi.advanceTimersByTimeAsync(HELD_POLLS * POLL_MS);
      await vi.waitFor(() => expect(readWorkerStatus(s)?.lastPollAt).toBeGreaterThan(start));
      expect(q.count("q7")).toBe(0);
      for (const id of ids) expect(getRequest(s, id)?.status).toBe(RequestStatus.Queued);
      writeBatchNow(s, Date.now());
      await vi.waitFor(
        () => expect(ids.map((id) => getRequest(s, id)?.status)).toEqual(ids.map(() => RequestStatus.Done)),
        { timeout: 20_000 },
      );
      expect(q.count("q7")).toBe(ids.length);
    } finally {
      abort.abort();
      await worker;
      vi.useRealTimers();
    }
    expect(lines.filter((l) => l.event === LogEvent.BatchDone)).toHaveLength(1);
    expect(readBatchNow(s)).toBeUndefined();
    closeStore(s);
  });

  it("after a failed promotion runs the requests of the batch 1 at a time, charges no attempt, and shows the error", async () => {
    const run = setup(3);
    const store = openStore(run.db, { embeddingModel: "test-model" });
    const ids = submissions(store, 3);
    // The live wiki gets a write during the batch, as if a second writer existed: its promotion fails.
    let writes = 0;
    const q = new StubQuestions({
      q5: async (input: { change: string }) => {
        if (writes++ < ids.length) {
          await seedChange(store, accepted([draft({ header: input.change, content: "Written next to the batch" })]));
        }
        return draftOf({ header: input.change, content: input.change });
      },
    });
    const lines: LogLine[] = [];
    const abort = new AbortController();
    const worker = runWorker({
      dbPath: run.db,
      config: run.config,
      questions: q,
      pollMs: 5,
      signal: abort.signal,
      log: (l) => lines.push(l),
    });
    try {
      // Without the 1-at-a-time run, the 3 queued requests make the next batch at once, and the queue never empties.
      await vi.waitFor(
        () => expect(ids.map((id) => getRequest(store, id)?.status)).toEqual(ids.map(() => RequestStatus.Done)),
        { timeout: 10_000 },
      );
    } finally {
      abort.abort();
      await worker;
    }
    expect(lines.filter((l) => l.event === LogEvent.BatchDropped)).toHaveLength(1);
    expect(lines.filter((l) => l.event === LogEvent.BatchDone)).toHaveLength(0);
    for (const id of ids) expect(getRequest(store, id)?.attempts).toBe(0);
    // The error shows while the requests run 1 at a time (the reducer tests keep it); the end of that run clears it.
    expect(readWorkerStatus(store)).toMatchObject({ consecutiveFailures: 0 });
    expect(readWorkerStatus(store)?.lastBatchError).toBeUndefined();
    expect(readWorkerStatus(store)?.lastCall?.ok).not.toBe(false);
    closeStore(store);
  });
});

describe("the pause between steps", () => {
  it("stops at the queue pause before a request starts, keeps the start seq, and runs the batch when the pause ends", async () => {
    const store = makeFileStore();
    const ids = submissions(store, 3);
    const q = new StubQuestions();
    const config = withBatch({ batchSize: 3 });
    setQueuePause(store, "operator", 1);

    const first = await batchStep({ store, questions: q, config, log: () => undefined });
    expect(first).toMatchObject({ ran: true, result: { status: BatchRunStatus.Stopped } });
    expect(q.count("q7")).toBe(0);
    for (const id of ids) expect(getRequest(store, id)?.status).toBe(RequestStatus.Queued);
    // The staging set is gone with the stop, and the key with it.
    expect(readBatchStartSeq(store)).toBeUndefined();

    clearQueuePause(store);
    const second = await batchStep({ store, questions: q, config, log: () => undefined });
    expect(second).toMatchObject({ ran: true, result: { status: BatchRunStatus.Done, size: 3 } });
    expect(readBatchStartSeq(store)).toBeUndefined();
    for (const id of ids) expect(getRequest(store, id)?.status).toBe(RequestStatus.Done);
  });

  it("drops the staging set that a crash left, and runs its requests again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wikifact-crash-"));
    const store = openStore(join(dir, "game.sqlite"), { embeddingModel: "test-model" });
    const ids = submissions(store, 3);
    // What a crash leaves: a staged row, the key, the requests in `running`, and a progress key.
    store.db.prepare("INSERT INTO stg_change_requests SELECT * FROM change_requests WHERE id = ?").run(ids[0]);
    writeBatchStartSeq(store, 0);
    writeBatchProgress(store, { taken: 3, done: 0, staged: 2, stale: 0, reconciliation: BatchReconciliation.Running });
    for (const id of ids) takeRequest(store, id, 5_000);
    expect(resetRunning(store)).toBe(3);
    const logs: LogLine[] = [];
    const q = new StubQuestions();
    const r = await batchStep({
      store,
      questions: q,
      config: withBatch({ batchSize: 3 }),
      log: (l) => logs.push(l),
    });
    expect(logs.find((l) => l.event === LogEvent.BatchDropped)).toMatchObject({ staged: 2 });
    expect(r).toMatchObject({ ran: true, result: { status: BatchRunStatus.Done, size: 3 } });
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM stg_change_requests").get()).toEqual({ n: 0 });
    expect(readBatchStartSeq(store)).toBeUndefined();
    for (const id of ids) expect(getRequest(store, id)?.status).toBe(RequestStatus.Done);
    // The 3 requests ran again from the start: 3 changes, each from a fresh run of the pipeline.
    expect(q.count("q7")).toBe(3);
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM changes").get()).toEqual({ n: 3 });
    closeStore(store);
  });

  it("stops at the stop signal", async () => {
    const store = makeFileStore();
    submissions(store, 3);
    const abort = new AbortController();
    abort.abort();
    const r = await batchStep({
      store,
      questions: new StubQuestions(),
      config: withBatch({ batchSize: 3 }),
      log: () => undefined,
      signal: abort.signal,
    });
    expect(r).toMatchObject({ ran: true, result: { status: BatchRunStatus.Stopped } });
  });
});
