import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { loadPrices, parseConfig, priceFor } from "../../../src/config/index.js";
import { BatchRunStatus, ChangeOutcome, QuestionId, RequestStatus, SupportKind } from "../../../src/domain/index.js";
import {
  applyChangeSync,
  closeStore,
  countQueuedSubmissions,
  enqueueRequest,
  openStore,
  recordModelCall,
  setQueuePause,
  takeNextRequest,
  type Store,
} from "../../../src/store/index.js";
import { StubQuestions } from "../../../fakes/stub-questions.js";
import { stubGroupCall } from "../../../fakes/stub-group-call.js";
import { accepted, draft, makeStore } from "../../../__tests__/helpers/store.js";
import { BulkArch, BulkPath, BulkStop } from "../../lib/enums.js";
import { parseBulkArgs } from "../args.js";
import { findDuplicates } from "../duplicates.js";
import { measureUsage } from "../measure.js";
import { makeCopy } from "../prepare.js";
import { runPath } from "../paths.js";
import { readResultFile } from "../resume.js";
import { unfinishedLine } from "../report.js";
import { runBulkTest } from "../run.js";
import type { BulkResultFile } from "../types.js";

// The group cut is 0 unless a test sets it: no grouping, so every request runs the full pipeline.
const config = (batchSize?: number, concurrency?: number, groupCut = 0) =>
  parseConfig({
    embeddingModel: "test-model",
    subject: "mobs",
    highVolume: {
      groupCut,
      ...(batchSize === undefined ? {} : { batchSize }),
      ...(concurrency === undefined ? {} : { concurrency }),
    },
  });

// A source file with `queued` queued submissions, about different mobs.
function makeSource(queued: number): { dir: string; db: string } {
  const dir = mkdtempSync(join(tmpdir(), "wikifact-bulk-"));
  const db = join(dir, "game.sqlite");
  const store = openStore(db, { embeddingModel: "test-model" });
  for (let i = 0; i < queued; i++) {
    enqueueRequest(
      store,
      { change: `Mob number ${i} drops item ${i} when it dies`, justification: "I saw it." },
      1_000 + i,
    );
  }
  closeStore(store);
  return { dir, db };
}

async function run(
  source: { dir: string; db: string },
  requests: number,
  over: {
    makeQuestions?: (s: Store) => StubQuestions;
    batchSize?: number;
    concurrency?: number;
    groupCut?: number;
    resume?: BulkResultFile;
    wiki?: { env: string; name: string };
    secondOnly?: boolean;
  } = {},
): Promise<{ file: BulkResultFile; stubs: Record<BulkPath, StubQuestions[]> }> {
  const stubs: Record<BulkPath, StubQuestions[]> = {
    [BulkPath.Sequential]: [],
    [BulkPath.Batch]: [],
  };
  let made = 0;
  const file = await runBulkTest({
    db: source.db,
    requests,
    workDir: join(source.dir, "work"),
    outPath: join(source.dir, "out", "result.json"),
    config: config(over.batchSize, over.concurrency, over.groupCut),
    // The sequential copy is made first, so its questions are asked for first.
    makeQuestions: (s) => {
      const q = over.makeQuestions ? over.makeQuestions(s) : new StubQuestions();
      stubs[made++ === 0 ? BulkPath.Sequential : BulkPath.Batch].push(q);
      return q;
    },
    judge: new StubQuestions(),
    prices: loadPrices(),
    log: () => undefined,
    stub: true,
    ...(over.resume ? { resume: over.resume } : {}),
    ...(over.wiki ? { wiki: over.wiki } : {}),
    ...(over.secondOnly ? { secondOnly: true } : {}),
  });
  return { file, stubs };
}

const RATE_LIMITED = (): StubQuestions =>
  new StubQuestions().set("q7", () => {
    throw new Error("API Error: 429 rate limit, resets 4pm");
  });

describe("the harness runs both paths on the same sample", () => {
  it("runs the sample 1 at a time and as batches, and never writes the source", async () => {
    const source = makeSource(5);
    const { file, stubs } = await run(source, 3);

    expect(file.complete).toBe(true);
    expect(file.requests).toBe(3);
    expect(file.queuedInSource).toBe(5);
    expect(file.sequential?.requests.map((r) => r.status)).toEqual(Array(3).fill(RequestStatus.Done));
    expect(file.batch?.requests.map((r) => r.status)).toEqual(Array(3).fill(RequestStatus.Done));
    expect(file.sequential?.outcomes).toEqual({ [ChangeOutcome.Accepted]: 3 });
    expect(file.batch?.outcomes).toEqual({ [ChangeOutcome.Accepted]: 3 });
    // Both paths ask the single questions.
    const [seq] = stubs[BulkPath.Sequential];
    const [batch] = stubs[BulkPath.Batch];
    expect(seq?.count("q7")).toBeGreaterThan(0);
    expect(batch?.count("q7")).toBeGreaterThan(0);
    expect(file.batch?.batches.length).toBeGreaterThan(0);
    // Same requests in both paths.
    expect(file.sequential?.requests.map((r) => r.requestId)).toEqual(file.batch?.requests.map((r) => r.requestId));
    // The source keeps all its queued submissions.
    const s = openStore(source.db, { embeddingModel: "test-model" });
    expect(countQueuedSubmissions(s)).toBe(5);
    closeStore(s);
  });

  it("records the batch size, the concurrency and the group cut of the batch path in the file", async () => {
    const source = makeSource(3);
    const { file } = await run(source, 3, { batchSize: 2, concurrency: 1, groupCut: 0.4 });
    expect(file).toMatchObject({ batchSize: 2, concurrency: 1, groupCut: 0.4 });
    expect(file.arch).toBeUndefined();
    const onDisk = readResultFile(join(source.dir, "out", "result.json"));
    expect(onDisk).toMatchObject({ batchSize: 2, concurrency: 1, groupCut: 0.4 });
    // Batch size 2 over 3 requests: a batch of 2, then the last request alone (a batch with no wait).
    expect(file.batch?.batches.map((b) => b.size)).toEqual([2, 1]);
  });

  it("runs the batch path with the group call: a group of 2 is judged by one group call", async () => {
    const source = makeSource(2);
    const { file, stubs } = await run(source, 2, {
      groupCut: 2,
      makeQuestions: () => {
        const q = new StubQuestions();
        q.group = stubGroupCall();
        return q;
      },
    });
    expect(file.complete).toBe(true);
    expect(file.batch?.requests.map((r) => r.status)).toEqual(Array(2).fill(RequestStatus.Done));
    expect(stubs[BulkPath.Batch][0]?.count("q5")).toBe(0);
  });

  it("refuses a resume of a file of #60 that holds an arch, and says the architecture is gone", async () => {
    const source = makeSource(3);
    const { file } = await run(source, 3, { makeQuestions: RATE_LIMITED });
    const old: BulkResultFile = { ...file, arch: BulkArch.Groups };
    await expect(run(source, 3, { resume: old })).rejects.toThrow(/architecture is gone/);
  });

  it("writes the result file and compares the copies", async () => {
    const source = makeSource(4);
    const { file } = await run(source, 4);
    const onDisk = JSON.parse(readFileSync(join(source.dir, "out", "result.json"), "utf8")) as BulkResultFile;
    expect(onDisk.complete).toBe(true);
    expect(onDisk.sequential?.duplicates).toBeDefined();
    expect(onDisk.batch?.duplicates).toBeDefined();
    expect(file.differences?.outcomes).toEqual([]);
    expect(file.differences?.onlySequential).toEqual([]);
    expect(file.differences?.onlyBatch).toEqual([]);
    expect(file.differences?.sameHeader).toBeGreaterThan(0);
  });

  it("reports a request whose outcome differs between the paths", async () => {
    const source = makeSource(2);
    let asked = 0;
    const { file } = await run(source, 2, {
      // The questions of the first copy (the sequential path) judge the first claim a belief; the batch path passes it.
      makeQuestions: () => {
        const first = asked++ === 0;
        return new StubQuestions().set("q7", (i) => ({
          oneClaim: true,
          claims: [],
          support: first && i.change.includes("number 0") ? SupportKind.Belief : SupportKind.Observation,
          reason: "stub",
        }));
      },
    });
    expect(file.complete).toBe(true);
    const diff = file.differences?.outcomes ?? [];
    expect(diff).toHaveLength(1);
    expect(diff[0]).toMatchObject({ sequential: ChangeOutcome.Rejected, batch: ChangeOutcome.Accepted });
  });

  it("removes the working copies unless asked to keep them", async () => {
    const source = makeSource(2);
    await run(source, 1);
    expect(existsSync(join(source.dir, "work", "bulk-sequential.sqlite"))).toBe(false);
    expect(existsSync(join(source.dir, "work", "bulk-batch.sqlite"))).toBe(false);
  });

  it("stops at a rate limit, keeps the rows and runs no second path", async () => {
    const source = makeSource(2);
    const { file } = await run(source, 2, {
      makeQuestions: () =>
        new StubQuestions().set("q7", () => {
          throw new Error("API Error: 429 rate limit, resets 4pm");
        }),
    });
    expect(file.complete).toBe(false);
    expect(file.stoppedBy).toBe(BulkStop.RateLimit);
    expect(file.sequential?.complete).toBe(false);
    expect(file.batch).toBeUndefined();
  });
});

describe("the batch path of the worker", () => {
  const PARTS = (i: { change: string }): string[] => [`First part of ${i.change}`, `Second part of ${i.change}`];
  const splittingFirst = (): StubQuestions =>
    new StubQuestions().set("q7", (i) =>
      i.change.includes("number 0")
        ? { oneClaim: false, claims: PARTS(i), support: SupportKind.Observation, reason: "stub" }
        : { oneClaim: true, claims: [], support: SupportKind.Observation, reason: "stub" },
    );

  it("runs the children of a split in the same batch", async () => {
    const source = makeSource(3);
    const { file } = await run(source, 3, { makeQuestions: splittingFirst });
    expect(file.complete).toBe(true);
    expect(file.batch?.batches).toEqual([{ status: BatchRunStatus.Done, size: 5 }]);
    const children = file.batch?.requests.flatMap((r) => r.children) ?? [];
    expect(children.map((c) => c.status)).toEqual([RequestStatus.Done, RequestStatus.Done]);
  });

  it("stops at a rate limit and keeps the rows", async () => {
    const source = makeSource(3);
    const { file } = await run(source, 3, { makeQuestions: RATE_LIMITED });
    expect(file.complete).toBe(false);
    expect(file.stoppedBy).toBe(BulkStop.RateLimit);
  });

  it("runs the repair requests that the pipeline queued, until the queue is idle", async () => {
    const source = makeSource(2);
    let made = 0;
    let queued = false;
    const { file } = await run(source, 2, {
      makeQuestions: (store) =>
        made++ === 0
          ? new StubQuestions()
          : new StubQuestions().set("q7", () => {
              // A request that is not in the sample, as the repair requests of the cleanup are.
              if (!queued)
                enqueueRequest(store, { change: "Extra mob drops an extra item", justification: "I saw it." }, 9_000);
              queued = true;
              return { oneClaim: true, claims: [], support: SupportKind.Observation, reason: "stub" };
            }),
    });
    expect(queued).toBe(true);
    expect(file.complete).toBe(true);
  });

  it("resumes a run that a rate limit stopped, and runs it to its end", async () => {
    const source = makeSource(3);
    let made = 0;
    const { file: stopped } = await run(source, 3, {
      makeQuestions: () => (made++ === 0 ? new StubQuestions() : RATE_LIMITED()),
    });
    expect(stopped.batch?.complete).toBe(false);
    expect(stopped.batch?.batches.map((b) => b.status)).toEqual([BatchRunStatus.RateLimited]);
    const outPath = join(source.dir, "out", "result.json");
    const { file } = await run(source, 3, { resume: readResultFile(outPath) });
    expect(file.complete).toBe(true);
    expect(file.batch?.requests.map((r) => r.status)).toEqual(Array(3).fill(RequestStatus.Done));
    expect(file.batch?.startedAtMs).toBe(stopped.batch?.startedAtMs);
  });

  describe("the batch size", () => {
    const seesQ7 = (seen: string[], over: (change: string) => void = () => undefined) =>
      new StubQuestions().set("q7", (i) => {
        seen.push(i.change);
        over(i.change);
        return { oneClaim: true, claims: [], support: SupportKind.Observation, reason: "stub" };
      });

    it("runs the requests in batches of the batch size, and a request queued by the pipeline joins the last batch", async () => {
      const source = makeSource(5);
      const seen: string[] = [];
      let made = 0;
      let queued = false;
      const { file } = await run(source, 5, {
        batchSize: 2,
        makeQuestions: (store) =>
          made++ === 0
            ? new StubQuestions()
            : seesQ7(seen, () => {
                if (queued) return;
                queued = true;
                enqueueRequest(store, { change: "Extra mob drops an extra item", justification: "I saw it." }, 9_000);
              }),
      });
      expect(file.complete).toBe(true);
      expect(file.batch?.batches.slice(0, 3).map((b) => b.size)).toEqual([2, 2, 2]);
      expect(seen.filter((c) => c.startsWith("Extra mob"))).toHaveLength(1);
    });
  });
});

describe("--second-only", () => {
  it("makes no sequential copy, no sequential path and no differences", async () => {
    const source = makeSource(3);
    const { file } = await run(source, 3, { secondOnly: true });
    expect(file.complete).toBe(true);
    expect(file.secondOnly).toBe(true);
    expect(file.sequential).toBeUndefined();
    expect(file.differences).toBeUndefined();
    expect(file.batch?.requests.map((r) => r.status)).toEqual(Array(3).fill(RequestStatus.Done));
    expect(existsSync(join(source.dir, "work", "bulk-sequential.sqlite"))).toBe(false);
    const written = JSON.parse(readFileSync(join(source.dir, "out", "result.json"), "utf8")) as BulkResultFile;
    expect(written.sequential).toBeUndefined();
  });

  it("resumes as second-only from its file, whatever the options say", async () => {
    const source = makeSource(3);
    await run(source, 3, { secondOnly: true, makeQuestions: RATE_LIMITED });
    const work = join(source.dir, "work");
    expect(existsSync(join(work, "bulk-sequential.sqlite"))).toBe(false);
    expect(existsSync(join(work, "bulk-batch.sqlite"))).toBe(true);
    const stopped = readResultFile(join(source.dir, "out", "result.json"));
    expect(stopped.secondOnly).toBe(true);
    const { file } = await run(source, 3, { resume: stopped });
    expect(file.complete).toBe(true);
    expect(file.secondOnly).toBe(true);
    expect(file.sequential).toBeUndefined();
    expect(file.differences).toBeUndefined();
    expect(existsSync(join(work, "bulk-sequential.sqlite"))).toBe(false);
  });

  it("is a flag of the command line, refused with --resume", () => {
    expect(parseBulkArgs(["--db", "x.sqlite", "--requests", "3", "--second-only"]).secondOnly).toBe(true);
    expect(() => parseBulkArgs(["--db", "x.sqlite", "--resume", "r.json", "--second-only"])).toThrow(/second-only/);
  });
});

describe("the time of a path", () => {
  it("sums the time of the steps and keeps the snapshot time apart", async () => {
    const source = makeSource(3);
    const copy = await makeCopy(source.db, join(source.dir, "copy.sqlite"), config(), 3);
    const STEP_MS = 100;
    const SNAPSHOT_MS = 1_000;
    let clock = 50_000;
    const questions = new StubQuestions().set("q7", () => {
      clock += STEP_MS;
      return { oneClaim: true, claims: [], support: SupportKind.Observation, reason: "stub" };
    });
    const end = await runPath({
      path: BulkPath.Sequential,
      store: copy.store,
      questions,
      config: config(),
      prices: loadPrices(),
      log: () => undefined,
      ids: copy.ids,
      now: () => clock,
      // The caller's file write is snapshot time too.
      onProgress: () => {
        clock += SNAPSHOT_MS;
      },
    });
    closeStore(copy.store);
    expect(end.result.complete).toBe(true);
    expect(end.result.wallMs).toBe(STEP_MS * questions.count("q7"));
    expect(end.result.snapshotMs).toBe(SNAPSHOT_MS * end.result.steps);
  });
});

describe("resume", () => {
  it("continues a stopped run on its kept copies and keeps the start of each path", async () => {
    const source = makeSource(3);
    const { file: stopped } = await run(source, 3, { makeQuestions: RATE_LIMITED });
    expect(stopped.complete).toBe(false);
    expect(existsSync(join(source.dir, "work", "bulk-sequential.sqlite"))).toBe(true);
    const outPath = join(source.dir, "out", "result.json");
    const { file } = await run(source, 3, { resume: readResultFile(outPath) });

    expect(file.complete).toBe(true);
    expect(file.stoppedBy).toBeUndefined();
    expect(file.sequential?.requests.map((r) => r.status)).toEqual(Array(3).fill(RequestStatus.Done));
    expect(file.batch?.requests.map((r) => r.status)).toEqual(Array(3).fill(RequestStatus.Done));
    expect(file.sequential?.startedAtMs).toBe(stopped.sequential?.startedAtMs);
    expect(file.sequential?.steps).toBeGreaterThan(stopped.sequential?.steps ?? 0);
    expect(file.sequential?.attemptErrors[0]).toBe(stopped.sequential?.attemptErrors[0]);
    expect(file.differences).toBeDefined();
    // A finished run removes its copies.
    expect(existsSync(join(source.dir, "work", "bulk-sequential.sqlite"))).toBe(false);
  });

  it("does not run a path again that ended", async () => {
    const source = makeSource(2);
    let asked = 0;
    // The sequential path ends; the batch path is rate limited on its first call.
    const { file: stopped } = await run(source, 2, {
      makeQuestions: () =>
        asked++ === 0
          ? new StubQuestions()
          : new StubQuestions().set("q7", () => {
              throw new Error("API Error: 429 rate limit, resets 4pm");
            }),
    });
    expect(stopped.sequential?.complete).toBe(true);
    expect(stopped.batch?.complete).toBe(false);
    const { file } = await run(source, 2, { resume: readResultFile(join(source.dir, "out", "result.json")) });
    expect(file.complete).toBe(true);
    // The sequential path is not run again: its steps, its time and its usage are those of the first run.
    expect(file.sequential).toMatchObject({
      steps: stopped.sequential?.steps,
      wallMs: stopped.sequential?.wallMs,
      usage: stopped.sequential?.usage,
    });
  });

  describe("the env and the wiki of the result file", () => {
    const WIKI = { env: "local", name: "alpha" };
    async function stoppedRun(): Promise<{ source: { dir: string; db: string }; stopped: BulkResultFile }> {
      const source = makeSource(2);
      const { file: stopped } = await run(source, 2, { makeQuestions: RATE_LIMITED, wiki: WIKI });
      return { source, stopped };
    }

    it("resumes when the wiki and the env are the same", async () => {
      const { source, stopped } = await stoppedRun();
      const { file } = await run(source, 2, { resume: stopped, wiki: WIKI });
      expect(file.complete).toBe(true);
    });

    it("fails a resume of another wiki before any copy opens", async () => {
      const { source, stopped } = await stoppedRun();
      await expect(run(source, 2, { resume: stopped, wiki: { ...WIKI, name: "beta" } })).rejects.toThrow(/alpha.*beta/);
    });

    it("fails a resume of another env before any copy opens", async () => {
      const { source, stopped } = await stoppedRun();
      await expect(run(source, 2, { resume: stopped, wiki: { ...WIKI, env: "prod" } })).rejects.toThrow(/local.*prod/);
    });
  });

  it("refuses a resume when the copies are gone", async () => {
    const source = makeSource(2);
    const { file: stopped } = await run(source, 2, { makeQuestions: RATE_LIMITED });
    rmSync(join(source.dir, "work"), { recursive: true, force: true });
    await expect(run(source, 2, { resume: stopped })).rejects.toThrow(/missing/);
  });
});

describe("the requests left running", () => {
  const PARTS = (i: { change: string }): string[] => [`First part of ${i.change}`, `Second part of ${i.change}`];
  // A change of the source splits into 2 claims; a claim is one.
  const splitting = (blocked?: { on: boolean }): StubQuestions =>
    new StubQuestions().set("q7", (i) => {
      if (!i.change.startsWith("Mob")) {
        if (blocked?.on) throw new Error("API Error: 429 rate limit, resets 4pm");
        return { oneClaim: true, claims: [], support: SupportKind.Observation, reason: "stub" };
      }
      return { oneClaim: false, claims: PARTS(i), support: SupportKind.Observation, reason: "stub" };
    });

  it("runs the requests of the batch that stopped again on a resume, and their children", async () => {
    const source = makeSource(2);
    const blocked = { on: true };
    let made = 0;
    // The first questions are those of the sequential copy, which is never blocked.
    const makeQuestions = (): StubQuestions => splitting(made++ === 0 ? undefined : blocked);
    const { file: stopped } = await run(source, 2, { makeQuestions });
    expect(stopped.batch?.complete).toBe(false);

    // A stop in the middle of a step leaves its requests `running`; the stub run stops cleanly, so it is done here.
    const copy = openStore(join(source.dir, "work", "bulk-batch.sqlite"), { embeddingModel: "test-model" });
    let stranded = 0;
    while (takeNextRequest(copy)) stranded++;
    closeStore(copy);
    expect(stranded).toBeGreaterThan(0);

    blocked.on = false;
    const { file } = await run(source, 2, {
      makeQuestions,
      resume: readResultFile(join(source.dir, "out", "result.json")),
    });
    expect(file.complete).toBe(true);
    const batch = file.batch;
    const children = batch?.requests.flatMap((r) => r.children) ?? [];
    // A stopped batch promotes nothing: its requests stay queued, and the run splits them again; each makes 2 children.
    const expected = stranded * PARTS({ change: "" }).length;
    expect(children).toHaveLength(expected);
    expect(children.map((c) => c.status)).toEqual(Array(expected).fill(RequestStatus.Done));
    expect(batch?.outcomes["child none"]).toBeUndefined();
    expect(batch?.unfinished).toBeUndefined();
  });

  it("marks a path that ends with a running request incomplete, and names the count in 1 line", async () => {
    const source = makeSource(3);
    // The first call of each copy takes a second request and never finishes it, as a crash would.
    const makeQuestions = (s: Store): StubQuestions => {
      let stranded = false;
      return new StubQuestions().set("q7", () => {
        if (!stranded) takeNextRequest(s);
        stranded = true;
        return { oneClaim: true, claims: [], support: SupportKind.Observation, reason: "stub" };
      });
    };
    const { file } = await run(source, 3, { makeQuestions });
    expect(file.complete).toBe(false);
    expect(file.sequential).toMatchObject({ complete: false, unfinished: 1 });
    expect(file.batch).toMatchObject({ complete: false, unfinished: 1 });
    const onDisk = JSON.parse(readFileSync(join(source.dir, "out", "result.json"), "utf8")) as BulkResultFile;
    expect(onDisk.sequential?.unfinished).toBe(1);
    const line = unfinishedLine(file) ?? "";
    expect(line.split("\n")).toHaveLength(1);
    expect(line).toMatch(/\b1\b/);
    expect(line).toContain("sequential");
  });

  it("has no line for a run in which every path ended", async () => {
    const source = makeSource(2);
    const { file } = await run(source, 2);
    expect(unfinishedLine(file)).toBeUndefined();
  });
});

describe("the result file of a stopped run", () => {
  interface StoppedFile {
    path: string;
    json: { sequential: { requests: { status?: unknown }[] } };
  }

  // A real stopped run writes the file; each test breaks one part of it.
  async function stoppedFile(): Promise<StoppedFile> {
    const source = makeSource(2);
    await run(source, 2, { makeQuestions: RATE_LIMITED });
    const path = join(source.dir, "out", "result.json");
    return { path, json: JSON.parse(readFileSync(path, "utf8")) as StoppedFile["json"] };
  }

  it("refuses a file with a nested field missing", async () => {
    const { path, json } = await stoppedFile();
    delete json.sequential.requests[0]?.status;
    writeFileSync(path, JSON.stringify(json));
    expect(() => readResultFile(path)).toThrow(ZodError);
  });

  it("refuses a file with a nested field of the wrong type", async () => {
    const { path, json } = await stoppedFile();
    json.sequential.requests[0] = { ...json.sequential.requests[0], status: 7 };
    writeFileSync(path, JSON.stringify(json));
    expect(() => readResultFile(path)).toThrow(ZodError);
  });

  it("refuses a file that is not JSON", async () => {
    const { path } = await stoppedFile();
    writeFileSync(path, "{ not json");
    expect(() => readResultFile(path)).toThrow(SyntaxError);
  });
});

describe("the sample", () => {
  it("takes the first n queued submissions, clears the pause and fails the other queued rows", async () => {
    const source = makeSource(4);
    const s = openStore(source.db, { embeddingModel: "test-model" });
    setQueuePause(s, "operator", 1);
    closeStore(s);
    const copy = await makeCopy(source.db, join(source.dir, "copy.sqlite"), config(), 2);
    expect(copy.ids).toHaveLength(2);
    expect(copy.queued).toBe(4);
    expect(countQueuedSubmissions(copy.store)).toBe(2);
    closeStore(copy.store);
  });

  it("refuses a sample larger than the queue", async () => {
    const source = makeSource(1);
    await expect(makeCopy(source.db, join(source.dir, "copy.sqlite"), config(), 2)).rejects.toThrow(/fewer than/);
  });
});

describe("the cost of a path", () => {
  it("sums the model calls from the start and prices them with the price table", () => {
    const store = makeStore();
    const id = enqueueRequest(store, { change: "c", justification: "j" }, 1);
    const prices = loadPrices();
    const model = Object.keys(prices.models)[0] ?? "";
    const base = {
      requestId: id,
      effort: "low",
      tokensIn: 1000,
      tokensOut: 200,
      tokensCacheRead: 3000,
      tokensCacheWrite: 400,
      durationMs: 5,
      model,
    };
    recordModelCall(store, { ...base, question: QuestionId.Q7, at: 10 });
    recordModelCall(store, { ...base, question: QuestionId.Q8, at: 20 });
    recordModelCall(store, { ...base, question: QuestionId.Q8, at: 30 });
    recordModelCall(store, { ...base, question: QuestionId.Q1, at: 5 });
    const u = measureUsage(store, 10, prices);
    expect(u.calls).toBe(3);
    expect(u.callsByQuestion).toEqual({ [QuestionId.Q7]: 1, [QuestionId.Q8]: 2 });
    expect(u.tokens).toEqual({ input: 3000, output: 600, cacheRead: 9000, cacheWrite: 1200 });
    const p = priceFor(prices, model);
    const expected =
      3 *
      ((1000 * p.input +
        400 * p.input * prices.cacheWriteFactor +
        3000 * p.input * prices.cacheReadFactor +
        200 * p.output) /
        1_000_000);
    expect(u.usd).toBeCloseTo(expected, 9);
    expect(u.unpricedCalls).toBe(0);
  });
});

describe("the duplicates left", () => {
  function twoFacts(): Store {
    const store = makeStore();
    const reqA = enqueueRequest(store, { change: "a", justification: "j" }, 1);
    applyChangeSync(store, reqA, accepted([draft({ header: "Creeper damage", content: "Creepers do 10 damage." })]), {
      now: 2,
    });
    const reqB = enqueueRequest(store, { change: "b", justification: "j" }, 3);
    applyChangeSync(
      store,
      reqB,
      accepted([draft({ header: "Creeper explosion damage", content: "A creeper explosion does 10 damage." })]),
      { now: 4 },
    );
    return store;
  }
  const FAR = 2;

  it("counts a pair that Q1 confirms once, from either side", async () => {
    const store = twoFacts();
    const q = new StubQuestions().set("q1", (i) => ({ matches: i.candidates.map((c) => c.factId) }));
    const r = await findDuplicates({ store, questions: q, subject: "mobs", sinceSeq: 0, distance: FAR });
    expect(r.complete).toBe(true);
    expect(r.checkedFacts).toBe(2);
    expect(r.pairs).toHaveLength(1);
    expect(r.candidatePairs).toBe(1);
  });

  it("finds no pair when Q1 matches nothing, and checks only the facts written in the run", async () => {
    const store = twoFacts();
    const none = await findDuplicates({
      store,
      questions: new StubQuestions(),
      subject: "mobs",
      sinceSeq: 0,
      distance: FAR,
    });
    expect(none.pairs).toEqual([]);
    const later = await findDuplicates({
      store,
      questions: new StubQuestions(),
      subject: "mobs",
      sinceSeq: 1_000,
      distance: FAR,
    });
    expect(later.checkedFacts).toBe(0);
  });

  it("keeps what it judged and says why when a call fails", async () => {
    const store = twoFacts();
    const q = new StubQuestions().set("q1", () => {
      throw new Error("429 rate limit");
    });
    const r = await findDuplicates({ store, questions: q, subject: "mobs", sinceSeq: 0, distance: FAR });
    expect(r.complete).toBe(false);
    expect(r.error).toMatch(/rate limit/);
  });
});

describe("the command line", () => {
  it("reads the database, the sample size and the options", () => {
    const a = parseBulkArgs(["--db", "x.sqlite", "--requests", "10", "--batch-size", "5", "--stub"]);
    expect(a).toMatchObject({ db: "x.sqlite", requests: 10, batchSize: 5, stub: true, keepCopies: false });
    expect(a.concurrency).toBeUndefined();
  });

  it("takes the sample size from the result file on a resume", () => {
    const a = parseBulkArgs(["--db", "x.sqlite", "--resume", "r.json"]);
    expect(a.resume).toBe("r.json");
    expect(a.requests).toBe(0);
  });

  it("refuses a missing database, a missing size and a size that is not a positive integer", () => {
    expect(() => parseBulkArgs(["--requests", "10"])).toThrow(/--db/);
    expect(() => parseBulkArgs(["--db", "x"])).toThrow(/--requests/);
    expect(() => parseBulkArgs(["--db", "x", "--requests", "0"])).toThrow(/positive/);
    expect(() => parseBulkArgs(["--db", "x", "--requests", "5", "--bogus"])).toThrow();
  });
});
