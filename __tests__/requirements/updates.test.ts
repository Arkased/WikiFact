// The requirement tests of docs/requirements/updates.md: one test per row, named as the row.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseConfig } from "../../src/config/index.js";
import {
  BatchReconciliation,
  BatchRunStatus,
  CallerKind,
  Effort,
  Mode,
  ProcessOutcome,
  Q4Relation,
  QuestionId,
  RejectReason,
  RequestStatus,
  RunOnceStatus,
  StopReason,
  TransportName,
} from "../../src/domain/enums.js";
import { healthPage } from "../../src/console/pages/health.js";
import { parse } from "../../src/console/__tests__/helpers/dom.js";
import { openTmpWiki } from "../../src/console/__tests__/helpers/tmp-wiki.js";
import { readEnv } from "../../src/env.js";
import { InvariantError } from "../../src/must.js";
import {
  MAX_ATTEMPTS,
  closeStore,
  enqueueRequest,
  getRequest,
  openStore,
  requeue,
  search,
  takeNextRequest,
  writeBatchProgress,
  type Store,
} from "../../src/store/index.js";
import { StubQuestions, draftOf } from "../../fakes/stub-questions.js";
import { naiveStub, scriptedStub } from "../../fakes/scripted-stub.js";
import { runWorker } from "../../src/updates/index.js";
import { runBatch } from "../../src/updates/batch/index.js";
import { selectTransport, TransportError } from "../../src/updates/questions/index.js";
import { runReplay } from "../../eval/replay/run.js";
import { loadReplay } from "../../eval/replay/load.js";
import { loadModels } from "../../eval/questions/models.js";
import { passes, readResultFile } from "../../eval/questions/results.js";
import { runSets } from "../../eval/questions/run-sets.js";
import type { CallResponse, Transport } from "../../src/updates/questions/index.js";
import { hashedEntry } from "../../eval/questions/__tests__/helpers/entries.js";
import { must } from "../helpers/must.js";
import { T0, makeFileStore, makeStore } from "../helpers/store.js";
import { PROCESS_START_TIMEOUT_MS } from "../helpers/timeouts.js";
import { changesOf, count, refs, versions, world } from "../helpers/updates.js";

const tmpDb = (): string => {
  const d = mkdtempSync(join(tmpdir(), "wikifact-"));
  return join(d, "game.sqlite");
};
const parsed = parseConfig({ embeddingModel: "test-model" });
// No wait: a queued submission starts its batch at the next poll, as a request ran at once before.
const config = { ...parsed, highVolume: { ...parsed.highVolume, waitMs: 0 } };
const open = (db: string): Store => openStore(db, { embeddingModel: "test-model" });
const silent = () => undefined;

describe("updates requirements, queue", () => {
  let store: Store;
  beforeEach(() => {
    store = makeStore();
  });
  afterEach(() => closeStore(store));

  it("Consistent result", async () => {
    // The queue hands out one request at a time, the oldest first, also among requests of one millisecond.
    const a = enqueueRequest(store, { change: "c1", justification: "j" }, T0 + 1);
    const b = enqueueRequest(store, { change: "c2", justification: "j" }, T0 + 2);
    const same = [1, 2, 3].map(() => enqueueRequest(store, { change: "c", justification: "j" }, T0 + 3));
    const first = must(takeNextRequest(store));
    expect(first.id).toBe(a);
    expect(first.status).toBe(RequestStatus.Running);
    const order = [b, ...same];
    expect(order.map(() => must(takeNextRequest(store)).id)).toEqual(order);
    expect(takeNextRequest(store)).toBeNull();

    // The second request sees the change of the first.
    const w = world();
    w.enqueue("Creepers do 10 damage.", "I saw it.");
    w.enqueue("Creepers do 12 damage.", "I measured 12.");
    expect((await w.run()).status).toBe(RunOnceStatus.Done);
    const written = (w.store.db.prepare("SELECT fact_id FROM fact_versions").all() as { fact_id: string }[]).map(
      (r) => r.fact_id,
    );
    expect(written).toHaveLength(1);
    await w.run();
    const q1 = w.q.calls.filter((c) => c.q === "q1");
    expect(q1).toHaveLength(1);
    const seen = (q1[0]?.input as { candidates: { factId: string }[] }).candidates.map((c) => c.factId);
    expect(seen).toEqual(written);
  });
});

describe("updates requirements, failures", () => {
  it("Crash safety", async () => {
    // An error in the middle of the pipeline leaves no new fact version, and the request runs again with the next seq.
    const w = world();
    const base = await w.seed({ header: "Creeper damage", content: "Creepers do 10 damage." });
    await w.seed({ header: "Charged creeper", content: "A charged creeper one-shots a player.", references: [base] });
    w.q.set("q1", { matches: [base] });
    w.q.set("q4", { supported: true, relation: Q4Relation.Different, wrongRelated: [], reason: "r" });
    w.q.set("q8", { holds: false, stillDepends: [], reason: "changed" });
    w.q.set("q9", () => {
      throw new Error("crash after Q8 on the first dependents pass");
    });
    const versionsBefore = count(w.store, "fact_versions");
    const changesBefore = count(w.store, "changes");
    const seqBefore = (w.store.db.prepare("SELECT max(seq) AS s FROM changes").get() as { s: number }).s;
    const { id, r } = await w.submit("Creepers do 12 damage.", "I measured 12.");
    expect(r.status).toBe(RunOnceStatus.Queued);
    expect(count(w.store, "fact_versions")).toBe(versionsBefore);
    expect(count(w.store, "changes")).toBe(changesBefore);
    expect(must(getRequest(w.store, id)).status).toBe(RequestStatus.Queued);
    w.q.set("q9", undefined as never);
    const again = await w.run();
    expect(again.status).toBe(RunOnceStatus.Done);
    expect(count(w.store, "fact_versions")).toBe(versionsBefore + 2);
    const seqAfter = (w.store.db.prepare("SELECT max(seq) AS s FROM changes").get() as { s: number }).s;
    expect(seqAfter).toBe(seqBefore + 1);

    // A failure inside the write rolls back the claim and its dependents.
    const f = world();
    const fbase = await f.seed({ header: "Creeper damage", content: "Creepers do 10 damage." });
    f.q.set("q1", { matches: [fbase] });
    f.q.set("q4", { supported: true, relation: Q4Relation.Different, wrongRelated: [], reason: "r" });
    const before = count(f.store, "fact_versions");
    f.store.indexWriter = {
      write() {
        throw new Error("index failure");
      },
    };
    const failed = await f.submit("Creepers do 12 damage.", "I measured 12.");
    expect(failed.r).toMatchObject({ status: RunOnceStatus.Queued, error: "index failure" });
    expect(count(f.store, "fact_versions")).toBe(before);

    // A crash leaves a running row; it goes back to queued when the worker starts, and the worker runs it.
    const db = tmpDb();
    const s = open(db);
    const rid = enqueueRequest(s, { change: "Creepers do 10 damage.", justification: "I saw it." });
    expect(must(takeNextRequest(s)).id).toBe(rid); // the worker took it and died
    expect(must(getRequest(s, rid)).status).toBe(RequestStatus.Running);
    closeStore(s);
    const abort = new AbortController();
    const p = runWorker({
      dbPath: db,
      config,
      questions: new StubQuestions(),
      pollMs: 10,
      signal: abort.signal,
      log: silent,
    });
    const check = open(db);
    await vi.waitFor(() => expect(must(getRequest(check, rid)).status).toBe(RequestStatus.Done));
    abort.abort();
    await p;
    expect(count(check, "fact_versions")).toBe(1);
    expect(count(check, "changes")).toBe(1);
    closeStore(check);
  });

  it("Durable queue", { timeout: PROCESS_START_TIMEOUT_MS }, async () => {
    // A request that was accepted sits in the database file: the process that took it dies, a new worker runs it.
    const db = tmpDb();
    const s = open(db);
    const id = enqueueRequest(s, { change: "Creepers do 10 damage.", justification: "I saw it." });
    closeStore(s);
    const abort = new AbortController();
    const p = runWorker({
      dbPath: db,
      config,
      questions: new StubQuestions(),
      pollMs: 10,
      signal: abort.signal,
      log: silent,
    });
    const check = open(db);
    await vi.waitFor(() => expect(must(getRequest(check, id)).status).toBe(RequestStatus.Done));
    abort.abort();
    await p;
    expect(count(check, "fact_versions")).toBe(1);
    closeStore(check);

    // The same holds when a real process accepts the request and dies: the child queues it, the test kills the child,
    // and a worker of this process runs it from the file.
    const childDb = tmpDb();
    const storeUrl = pathToFileURL(join(process.cwd(), "src/store/index.ts")).href;
    const script = `
      import { enqueueRequest, openStore } from ${JSON.stringify(storeUrl)};
      const s = openStore(process.argv[1], { embeddingModel: "test-model" });
      const id = enqueueRequest(s, { change: "Creepers do 10 damage.", justification: "I saw it." });
      process.stdout.write("queued " + id + "\\n");
      setInterval(() => undefined, 1000);
    `;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, childDb], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "inherit"],
    });
    const queued = await new Promise<string>((resolve, reject) => {
      let out = "";
      child.stdout.on("data", (d: Buffer) => {
        out += d.toString();
        const m = /queued (\S+)/.exec(out);
        if (m?.[1]) resolve(m[1]);
      });
      child.on("exit", () => reject(new Error(`the child died before it queued the request: ${out}`)));
    });
    child.removeAllListeners("exit");
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
    const abort2 = new AbortController();
    const p2 = runWorker({
      dbPath: childDb,
      config,
      questions: new StubQuestions(),
      pollMs: 10,
      signal: abort2.signal,
      log: silent,
    });
    const check2 = open(childDb);
    await vi.waitFor(() => expect(must(getRequest(check2, queued)).status).toBe(RequestStatus.Done));
    abort2.abort();
    await p2;
    expect(count(check2, "fact_versions")).toBe(1);
    closeStore(check2);
  });

  it("Failed request", async () => {
    const w = world({
      q4: () => {
        throw new Error("model said no");
      },
    });
    const id = w.enqueue("Creepers do 10 damage.", "I saw it.");
    // A request that fails goes back to the queue with its error, until it has failed MAX_ATTEMPTS times.
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      expect(await w.run()).toMatchObject({ status: RunOnceStatus.Queued, error: "model said no" });
      expect(getRequest(w.store, id)).toMatchObject({
        status: RequestStatus.Queued,
        attempts: i,
        error: "model said no",
      });
    }
    expect((await w.run()).status).toBe(RunOnceStatus.Failed);
    expect(getRequest(w.store, id)).toMatchObject({
      status: RequestStatus.Failed,
      attempts: MAX_ATTEMPTS,
      error: "model said no",
    });
    expect((await w.run()).status).toBe(RunOnceStatus.Idle);
    // The operator puts it back in the queue, and it runs.
    expect(requeue(w.store, id)).toBe(true);
    w.q.set("q4", { supported: true, wrongRelated: [], reason: "ok" });
    expect((await w.run()).status).toBe(RunOnceStatus.Done);
    expect(getRequest(w.store, id)).toMatchObject({ status: RequestStatus.Done, attempts: 0 });

    // A rate limit of the model is not a failed attempt: the request stays queued with its count, however often it hits.
    const limited = world({
      q4: () => {
        throw new Error("429 rate limit");
      },
    });
    const waiting = limited.enqueue("Creepers do 10 damage.", "I saw it.");
    for (let i = 0; i < MAX_ATTEMPTS + 1; i++) {
      expect((await limited.run()).status).toBe(RunOnceStatus.RateLimited);
    }
    expect(getRequest(limited.store, waiting)).toMatchObject({ status: RequestStatus.Queued, attempts: 0 });

    // A deterministic failure (a broken invariant) gives the same result on each attempt, so it fails at the first.
    const broken = world({
      q4: () => {
        throw new InvariantError("the fact has no version");
      },
    });
    const doomed = broken.enqueue("Creepers do 10 damage.", "I saw it.");
    expect((await broken.run()).status).toBe(RunOnceStatus.Failed);
    expect(getRequest(broken.store, doomed)).toMatchObject({
      status: RequestStatus.Failed,
      attempts: 1,
      error: "the fact has no version",
    });
    expect((await broken.run()).status).toBe(RunOnceStatus.Idle);
  });
});

describe("updates requirements, evals", () => {
  it("Question accuracy", () => {
    // The pass condition exists: a mean under the bar fails, a run under the bar fails, a run that meets it passes.
    const { passBar } = loadModels();
    const question = QuestionId.Q8;
    expect(passBar.strict).not.toContain(question);
    const at = (runs: number[]) =>
      passes(
        hashedEntry(question, undefined, undefined, {
          runAccuracy: runs,
          mean: runs.reduce((a, b) => a + b, 0) / runs.length,
        }),
      );
    expect(at([1, 1, 1])).toBe(true);
    expect(at([passBar.mean, passBar.mean, passBar.mean])).toBe(true);
    expect(at([passBar.mean - 0.05, passBar.mean - 0.05, passBar.mean - 0.05])).toBe(false);
    expect(at([1, 1, passBar.minRun - 0.05])).toBe(false);
    // The runner scores a model whose answers are all wrong at zero, so that it fails the bar.
    expect(at([0])).toBe(false);
  });

  it("No duplicates", async () => {
    const replayConfig = parseConfig({ subject: loadReplay().subject });
    // A stub that never matches a scope lets a duplicate through: the replay marks it a critical miss and fails.
    const naive = await runReplay({ config: replayConfig, makeQuestions: () => naiveStub() });
    expect(naive.pass).toBe(false);
    expect(naive.results.some((x) => x.criticalMisses.length > 0)).toBe(true);
    // A compound submission that Q7 lets through and that comes out as one fact is a critical miss.
    const compoundFact = {
      drafts: [
        {
          header: "Skeleton facts",
          content: "Skeletons are hostile and spawn at night.",
          references: [],
        },
      ],
    };
    const compound = await runReplay({
      config: replayConfig,
      only: "r05",
      makeQuestions: (c, ids) =>
        scriptedStub({ ...c, stub: { q1: [], q4: { supported: true }, q5: compoundFact } }, ids),
    });
    expect(compound.pass).toBe(false);
    expect(compound.results[0]?.criticalMisses.length).toBeGreaterThan(0);
  });

  it("Known cost", async () => {
    const out = join(dirname(tmpDb()), "out.json");
    const transport: Transport = {
      send: () =>
        Promise.resolve<CallResponse>({
          stopReason: StopReason.EndTurn,
          text: "{}",
          usage: { input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0 },
        }),
    };
    const models = ["claude-sonnet-5-5", "claude-opus-5-5"];
    const efforts = [Effort.Low, Effort.High];
    await runSets(
      { qs: [QuestionId.Q1], models, efforts, runs: 1, concurrency: 2, limit: 2 },
      { transport, transportName: "fake", outPath: out, print: () => undefined },
    );
    const results = readResultFile(out).results;
    // One result per model and effort level, each with its own cost.
    for (const model of models)
      for (const effort of efforts) {
        const r = results.find((x) => x.model === model && x.effort === effort);
        expect(r, `${model} ${effort}`).toBeDefined();
        expect(r?.costEstimateUsd).toBeGreaterThan(0);
      }
  });
});

describe("updates requirements, credentials", () => {
  it("Credentials", () => {
    const bin = process.execPath;
    // A deployed worker needs a key.
    expect(() =>
      selectTransport(CallerKind.Worker, readEnv({ WIKIFACT_CLAUDE_BIN: bin }), { mode: Mode.Deployed }),
    ).toThrow(TransportError);
    expect(selectTransport(CallerKind.Worker, readEnv({ ANTHROPIC_API_KEY: "k" }), { mode: Mode.Deployed }).name).toBe(
      TransportName.Sdk,
    );
    // A local worker can use the Claude Code login: a key means the sdk, else the cli.
    expect(selectTransport(CallerKind.Worker, readEnv({ WIKIFACT_CLAUDE_BIN: bin }), { mode: Mode.Local }).name).toBe(
      TransportName.Cli,
    );
    expect(
      selectTransport(CallerKind.Worker, readEnv({ ANTHROPIC_API_KEY: "k", WIKIFACT_CLAUDE_BIN: bin }), {
        mode: Mode.Local,
      }).name,
    ).toBe(TransportName.Sdk);
  });

  it("Stale fact deleted", async () => {
    const w = world();
    const id = await w.seed({ header: "Torch recipe", content: "Torches can be crafted from coal and sticks." });
    w.q.set("q1", { matches: [id] });

    // A claim that negates the fact and gives no new content deletes it: accepted, and no negated fact is written.
    w.q.set("q4", { supported: true, relation: Q4Relation.Negates, wrongRelated: [], reason: "r" });
    const del = await w.submit("Torches can no longer be crafted.", "I tried at the table: nothing came out.");
    expect(del.r).toMatchObject({ status: RunOnceStatus.Done, result: { outcome: ProcessOutcome.Accepted } });
    const v = versions(w.store, id);
    // One new version, a deletion, with the justification as sent and no references.
    expect(v).toHaveLength(2);
    const deletion = must(v.at(-1));
    expect(deletion.is_deleted).toBe(1);
    expect(deletion.justification).toBe("I tried at the table: nothing came out.");
    expect(refs(w.store, deletion.id)).toEqual([]);
    expect(count(w.store, "facts")).toBe(1);
    expect(w.q.count("q5")).toBe(0);

    // A claim that gives new content for the subject is a correction: exactly one new version, live, not a deletion.
    const w2 = world();
    const id2 = await w2.seed({ header: "Torch recipe", content: "Torches can be crafted from coal and sticks." });
    w2.q.set("q1", { matches: [id2] });
    w2.q.set("q4", { supported: true, relation: Q4Relation.Different, wrongRelated: [], reason: "r" });
    const fix = await w2.submit("Torches need charcoal and sticks.", "I crafted one with charcoal.");
    expect(fix.r).toMatchObject({ status: RunOnceStatus.Done, result: { outcome: ProcessOutcome.Accepted } });
    expect(versions(w2.store, id2)).toHaveLength(2);
    expect(versions(w2.store, id2).at(-1)?.is_deleted).toBe(0);
  });

  it("Negation on return", async () => {
    const w = world();
    const id = await w.seed({ header: "Torch recipe", content: "Torches can be crafted from coal and sticks." });
    await w.seedDelete(id, "I tried at the table in the current version: nothing came out.");
    w.q.set("q1", { matches: [id] });

    // A weaker observation does not restore the claim: a new live version says that it is no longer true.
    w.q.set("q4", { supported: true, relation: Q4Relation.Stale, wrongRelated: [], reason: "r" });
    w.q.set("q5", {
      drafts: [
        {
          header: "Torch recipe",
          content: "Torches can no longer be crafted from coal and sticks.",
          references: [],
        },
      ],
    });
    const weak = await w.submit("Torches can be crafted from coal and sticks.", "A friend said it still works.");
    expect(weak.r).toMatchObject({ status: RunOnceStatus.Done, result: { outcome: ProcessOutcome.Accepted } });
    // The new version belongs to the deleted fact, is live, and Q5 was asked to negate.
    const v = versions(w.store, id);
    expect(v).toHaveLength(3);
    expect(v[2]?.fact_id).toBe(id);
    expect(v[2]?.is_deleted).toBe(0);
    expect(count(w.store, "facts")).toBe(1);
    expect(w.q.calls.filter((c) => c.q === "q5").map((c) => (c.input as { negate?: boolean }).negate)).toEqual([true]);

    // An observation at least as strong restores the claim.
    const s = world();
    const sid = await s.seed({ header: "Torch recipe", content: "Torches can be crafted from coal and sticks." });
    await s.seedDelete(sid, "I looked once and found no recipe.");
    s.q.set("q1", { matches: [sid] });
    s.q.set("q4", { supported: true, relation: Q4Relation.Same, wrongRelated: [], reason: "r" });
    s.q.set("q5", {
      drafts: [
        {
          header: "Torch recipe",
          content: "Torches can be crafted from coal and sticks.",
          references: [],
        },
      ],
    });
    const strong = await s.submit("Torches can be crafted from coal and sticks.", "I crafted 4 torches, on video.");
    expect(strong.r).toMatchObject({ status: RunOnceStatus.Done, result: { outcome: ProcessOutcome.Accepted } });
    const restored = must(versions(s.store, sid).at(-1));
    expect(restored.fact_id).toBe(sid);
    expect(restored.is_deleted).toBe(0);
    expect(s.q.calls.filter((c) => c.q === "q5").map((c) => (c.input as { negate?: boolean }).negate)).toEqual([
      undefined,
    ]);

    // "Rejected" is only for a request that writes nothing.
    const r = world();
    const rid = await r.seed({ header: "Torch recipe", content: "Torches can be crafted from coal and sticks." });
    await r.seedDelete(rid);
    r.q.set("q1", { matches: [rid] });
    r.q.set("q4", { supported: false, rejectReason: RejectReason.Unsupported, wrongRelated: [], reason: "r" });
    const none = await r.submit("Torches can be crafted from coal and sticks.", "I think so.");
    expect(none.r).toMatchObject({ status: RunOnceStatus.Done, result: { outcome: ProcessOutcome.Rejected } });
    expect(versions(r.store, rid)).toHaveLength(2);
    expect(r.q.count("q5")).toBe(0);
  });

  it("Negation of a deleted fact", async () => {
    const w = world();
    const id = await w.seed({ header: "Torch recipe", content: "Torches can be crafted from coal and sticks." });
    await w.seedDelete(id, "I tried at the table in the current version: nothing came out.");
    w.q.set("q1", { matches: [id] });
    w.q.set("q4", { supported: true, relation: Q4Relation.Negates, wrongRelated: [], reason: "r" });
    const seqBefore = count(w.store, "fact_versions");
    const { id: reqId, r } = await w.submit("Torches can no longer be crafted.", "I tried at the table: nothing.");
    // The request is a duplicate of the deletion: no new version, no confirmation event, no draft question.
    expect(r).toMatchObject({ status: RunOnceStatus.Done, result: { outcome: ProcessOutcome.Duplicate } });
    expect(changesOf(w.store, reqId)[0]).toMatchObject({ outcome: "duplicate", duplicate_of: id });
    expect(count(w.store, "fact_versions")).toBe(seqBefore);
    expect(versions(w.store, id).at(-1)?.is_deleted).toBe(1);
    expect(count(w.store, "retrievals", "kind = 'confirm'")).toBe(0);
    expect(w.q.count("q5")).toBe(0);
  });

  it.todo("Request time");

  // The targets in numbers come with the design of the high volume mode (Q-7) and the throughput work of #15.
  it.todo("Queue keeps up");

  it.todo("High volume mode");

  it("Staged batch", async () => {
    const w = world({}, makeFileStore());
    const seen: { facts: number; hits: number }[] = [];
    const q = new StubQuestions({
      q5: async (input: { change: string }) => {
        seen.push({
          facts: count(w.store, "facts"),
          hits: (await search(w.store, "Skeletons shoot arrows at players")).length,
        });
        return draftOf({ header: input.change, content: input.change });
      },
    });
    const ids = [
      w.enqueue("Zombies burn in sunlight daily", "I saw it."),
      w.enqueue("Skeletons shoot arrows at players", "I saw it."),
    ];
    const res = await runBatch({
      store: w.store,
      questions: q,
      config: { subject: "Minecraft" },
      settings: { ...config.highVolume, concurrency: 1 },
      log: silent,
      probe: () => undefined,
      ids,
    });
    expect(res.status).toBe(BatchRunStatus.Done);
    // A search and a read of the live wiki saw no staged change while the second request ran, after the first had ended.
    expect(seen[1]).toEqual({ facts: 0, hits: 0 });
    // The promotion wrote the whole batch at once, and the search finds it.
    expect(count(w.store, "facts")).toBe(2);
    expect((await search(w.store, "Skeletons shoot arrows at players")).length).toBeGreaterThan(0);
  });

  it.todo("Reconciliation of a batch");

  // The build of the cached prefix is #16.
  it.todo("Cache use");

  it("Batch visible", async () => {
    const wiki = openTmpWiki();
    try {
      writeBatchProgress(wiki.store, {
        taken: 5,
        done: 3,
        staged: 4,
        stale: 1,
        reconciliation: BatchReconciliation.Pending,
      });
      const page = parse(await healthPage(wiki.ctx()));
      // The progress of the batch and the state of its reconciliation.
      const batch = page.section("Batch, now");
      expect(batch?.stat("Done")).toBe("3 of 5");
      expect(batch?.stat("Staged changes")).toBe("4");
      expect(batch?.stat("Stale reruns")).toBe("1");
      expect(batch?.stat("Reconciliation")).toBe("pending");
    } finally {
      wiki.close();
    }
  });
});
