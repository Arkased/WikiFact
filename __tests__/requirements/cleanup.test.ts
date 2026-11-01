// The requirement tests of docs/requirements/cleanup.md: one test per row, named as the row.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChangeOutcome,
  CleanupFinder,
  LogEvent,
  OperatorEditKind,
  ProcessOutcome,
  RejectReason,
  RequestKind,
  RequestStatus,
  RunOnceStatus,
} from "../../src/domain/enums.js";
import { post, serveConsole } from "../../src/console/__tests__/helpers/serve.js";
import { openTmpWiki } from "../../src/console/__tests__/helpers/tmp-wiki.js";
import type { LogLine } from "../../src/log/index.js";
import {
  CLEANUP_CAP,
  CLEANUP_EVERY,
  REPAIRS_TO_SHORTEN,
  readCleanupEvery,
  readCleanupSeq,
  cleanupCandidates,
  closeStore,
  enqueueRequest,
  enqueueCleanupRepair,
  getRequest,
  isCovered,
  openStore,
  seedChange,
  takeNextRequest,
  verdictSubject,
  writeCleanupFull,
  writeCleanupSeq,
  writeVerdicts,
  type Store,
} from "../../src/store/index.js";
import { runOnce, runWorker } from "../../src/updates/index.js";
import { cleanupIfDue, runCleanup } from "../../src/updates/cleanup-run.js";
import {
  seqsAt,
  duplicatePairs,
  endQueuedRepairs,
  workerConfig,
  wroteRepair,
} from "../../src/updates/__tests__/helpers/cleanup.js";
import { scripted } from "../../src/updates/__tests__/helpers/scripted-questions.js";
import { makeSchema15Db } from "../helpers/schema15.js";
import { must } from "../helpers/must.js";
import { T0, accepted, draft, makeStore } from "../helpers/store.js";
import { world } from "../helpers/updates.js";

const stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) closeStore(s);
});
const fresh = (): Store => {
  const s = makeStore();
  stores.push(s);
  return s;
};

const FINDER = CleanupFinder.DuplicateFact;

describe("cleanup requirements", () => {
  it("Free for submissions", async () => {
    // Repairs are queued, then a submission arrives: the worker takes the submission first.
    const queue = fresh();
    const pair: [string, string] = ["f1", "f2"];
    const repairs = [1, 2, 3].map((n) => enqueueCleanupRepair(queue, { finder: FINDER, factIds: pair }, T0 + n));
    const late = enqueueRequest(queue, { change: "Creepers do 10 damage.", justification: "I saw it." }, T0 + 10);
    expect(must(takeNextRequest(queue, T0 + 11)).id).toBe(late);
    expect(must(takeNextRequest(queue, T0 + 12)).id).toBe(repairs[0]);

    const dir = mkdtempSync(join(tmpdir(), "wikifact-cleanup-"));
    const dbPath = join(dir, "game.sqlite");
    const s = openStore(dbPath, { embeddingModel: "test-model" });
    stores.push(s);
    // A cleanup is due (the check was cut by its cap, a seq behind the last write), and 2 submissions wait in the queue.
    await duplicatePairs(s, 1);
    writeCleanupSeq(s, seqsAt(0));
    writeCleanupFull(s, [FINDER]);
    const first = enqueueRequest(s, { change: "Creepers do 10 damage.", justification: "I saw it." });
    // A second submission arrives while the first runs. The due check runs when the first ends, with this one still queued: the
    // queue does not gate the check.
    let id = "";
    const waiting: number[] = [];
    // The repairs that have not ended, and the repairs in all, at the first line of the queued submission.
    let atStart: { open: number; all: number } | undefined;
    const repairCount = (open: boolean): number =>
      (
        s.db
          .prepare(`SELECT count(*) AS n FROM change_requests WHERE kind = ? AND (? = 0 OR status IN (?, ?))`)
          .get(RequestKind.CleanupRepair, open ? 1 : 0, RequestStatus.Queued, RequestStatus.Running) as { n: number }
      ).n;
    const log = (l: LogLine): void => {
      if (l.event === LogEvent.Change && id === "") {
        id = enqueueRequest(s, { change: "Zombies do 5 damage.", justification: "I saw it." });
      }
      if ("request_id" in l && l.request_id === id && atStart === undefined) {
        atStart = { open: repairCount(true), all: repairCount(false) };
      }
      if (l.event !== LogEvent.CleanupRun) return;
      const row = s.db
        .prepare("SELECT count(*) AS n FROM change_requests WHERE kind = ? AND status IN (?, ?)")
        .get(RequestKind.Submission, RequestStatus.Queued, RequestStatus.Running) as { n: number };
      waiting.push(row.n);
    };
    const abort = new AbortController();
    const worker = runWorker({
      dbPath,
      config: workerConfig,
      questions: scripted({}).q,
      pollMs: 10,
      signal: abort.signal,
      log,
    });
    try {
      await vi.waitFor(() => expect(waiting.length).toBeGreaterThan(0));
      expect(waiting[0]).toBe(1);
      // The queued submission starts after the run of the check, and after every repair of that run has ended.
      await vi.waitFor(() => expect(atStart).toBeDefined());
      expect(atStart?.all).toBeGreaterThan(0);
      expect(atStart?.open).toBe(0);
      await vi.waitFor(() => expect(getRequest(s, id)?.status).toBe(RequestStatus.Done));
      expect(getRequest(s, first)?.status).toBe(RequestStatus.Done);
    } finally {
      abort.abort();
      await worker;
    }
  });

  it("Interval", async () => {
    const s = fresh();
    const logs: LogLine[] = [];
    const log = (l: LogLine): void => void logs.push(l);
    const runLines = (): LogLine[] => logs.filter((l) => l.event === LogEvent.CleanupRun);
    const every = CLEANUP_EVERY[FINDER];
    // As many writes as the interval, so that the seq one interval below the highest is 0.
    let res = await duplicatePairs(s, 1);
    for (let i = 1; i < every; i++) res = await duplicatePairs(s, 1);
    expect(res.seq).toBeGreaterThanOrEqual(every);
    // The check is 1 write short of its interval: it does not run.
    writeCleanupSeq(s, seqsAt(1));
    expect(cleanupIfDue(s, log)).toBeUndefined();
    expect(runLines()).toEqual([]);
    // One write more reaches the interval, and the check runs.
    writeCleanupSeq(s, seqsAt(0));
    cleanupIfDue(s, log);
    expect(runLines()).toMatchObject([{ finders: [FINDER] }]);
    expect(readCleanupSeq(s)).toEqual(seqsAt(res.seq));

    // The run had no repair (its queued requests ended with no change): the interval is longer.
    endQueuedRepairs(s);
    cleanupIfDue(s, log);
    const afterNone = readCleanupEvery(s);
    expect(afterNone[FINDER]).toBeGreaterThan(every);

    // A run with REPAIRS_TO_SHORTEN repairs that wrote: the interval is shorter.
    const t = fresh();
    await duplicatePairs(t, 1);
    writeCleanupSeq(t, seqsAt(0));
    runCleanup(t, Date.now(), log, [FINDER]);
    endQueuedRepairs(t);
    for (let i = 0; i < REPAIRS_TO_SHORTEN; i++) wroteRepair(t, FINDER, T0 + 1000 + i);
    cleanupIfDue(t, log);
    expect(readCleanupEvery(t)[FINDER]).toBeLessThan(every);
  });

  it("Cap", async () => {
    const s = fresh();
    // CLEANUP_CAP + 1 pairs of duplicate facts: the check stops at the cap and is reported as cut.
    await duplicatePairs(s, CLEANUP_CAP + 1);
    const found = cleanupCandidates(s);
    expect(found.candidates.filter((c) => c.finder === FINDER)).toHaveLength(CLEANUP_CAP);
    expect(found.cut).toContain(FINDER);
  });

  it("No repeat check", async () => {
    const s = fresh();
    const seeded = await duplicatePairs(s, 1);
    const ids = [must(seeded.factIds[0]), must(seeded.factIds[1])];
    const subject = verdictSubject(ids);
    const offered = (): boolean => cleanupCandidates(s).candidates.some((c) => c.finder === FINDER);
    expect(offered()).toBe(true);
    writeVerdicts(s, FINDER, [subject], T0 + 100);
    expect(isCovered(s, FINDER, subject)).toBe(true);
    expect(offered()).toBe(false);
    // A new version of 1 fact, with a changed content, ends the verdict.
    await seedChange(
      s,
      accepted([
        draft({ factId: ids[0], header: "Pair0x one", content: "Pair0x alpha0x beta0x gamma0x delta0x, edited." }),
      ]),
      { now: T0 + 200 },
    );
    expect(isCovered(s, FINDER, subject)).toBe(false);
    expect(offered()).toBe(true);
  });

  it("Operator start", async () => {
    const wiki = openTmpWiki("alpha");
    const server = await serveConsole(wiki.deps);
    try {
      await seedChange(
        wiki.store,
        accepted([draft({ header: "Creeper damage", content: "A creeper deals 49 damage." })]),
        {
          now: T0,
        },
      );
      const idOf = (res: Response): string => res.headers.get("location")?.split("/").pop() ?? "";
      const all = await post(server.base, "/console/w/alpha/jobs/cleanup", { note: "first run", confirm: "1" });
      expect(all.status).toBe(303);
      expect(getRequest(wiki.store, idOf(all))).toMatchObject({ kind: RequestKind.OperatorEdit, targets: [] });
      expect(getRequest(wiki.store, idOf(all))?.operatorEdit).toEqual({
        edit: OperatorEditKind.Cleanup,
        note: "first run",
      });
    } finally {
      await server.close();
      wiki.close();
    }
  });

  it("Old repair rejected", async () => {
    // The cleanup has 1 check.
    expect(Object.values(CleanupFinder)).toEqual([CleanupFinder.DuplicateFact]);
    const w = world();
    // A queued repair of a check that the cleanup no longer has ends as rejected unsupported, with no write and no question.
    const insertRaw = (id: string, change: string): void => {
      w.store.db
        .prepare(
          "INSERT INTO change_requests(id, kind, status, change, targets, received_at) VALUES (?, 'cleanupRepair', 'queued', ?, '[]', 1)",
        )
        .run(id, change);
    };
    const removed = ["oldFinder", "otherFinder"];
    removed.forEach((finder, i) => insertRaw(`raw${i}`, JSON.stringify({ finder, factId: "f" })));
    const factsBefore = w.store.db.prepare("SELECT count(*) AS n FROM fact_versions").get() as { n: number };
    for (const [i] of removed.entries()) {
      const r = await w.run();
      expect(r.status).toBe(RunOnceStatus.Done);
      if (r.status === RunOnceStatus.Done) expect(r.result.outcome).toBe(ProcessOutcome.Rejected);
      const change = w.store.db
        .prepare("SELECT outcome, reject_reason FROM changes WHERE request_id = ?")
        .get(`raw${i}`) as { outcome: string; reject_reason: string };
      expect(change).toEqual({ outcome: ChangeOutcome.Rejected, reject_reason: RejectReason.Unsupported });
    }
    const factsAfter = w.store.db.prepare("SELECT count(*) AS n FROM fact_versions").get() as { n: number };
    expect(factsAfter).toEqual(factsBefore);
    expect(w.q.calls).toHaveLength(0);
  });

  it("Store migrated", async () => {
    // A store of the previous schema opens migrated, and its cleanup merges duplicate facts.
    const old = makeSchema15Db();
    const s = openStore(old.path, { embeddingModel: "test-model" });
    stores.push(s);
    const names = (s.db.prepare("SELECT name FROM sqlite_master").all() as { name: string }[]).map((r) => r.name);
    expect(names.filter((n) => n.includes("tag"))).toEqual([]);
    const vectorsSql = s.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'stg_vectors'").pluck().get() as string;
    expect(vectorsSql).not.toContain("'tag'");
    const seeded = await duplicatePairs(s, 1);
    const id = enqueueCleanupRepair(
      s,
      { finder: FINDER, factIds: [seeded.factIds[0] ?? "", seeded.factIds[1] ?? ""] },
      T0 + 10,
    );
    const q = scripted({ q1: (input) => ({ matches: input.candidates.map((x) => x.factId).slice(0, 1) }) });
    // The old request of the store runs first and ends rejected as unsupported; then the merge runs.
    for (let i = 0; i < 2; i++) {
      const r = await runOnce(s, q.q, { subject: "Minecraft" }, { log: () => undefined, now: () => T0 + 20 });
      expect(r.status).toBe(RunOnceStatus.Done);
    }
    const outcomeOf = (requestId: string): string =>
      (s.db.prepare("SELECT outcome FROM changes WHERE request_id = ?").get(requestId) as { outcome: string }).outcome;
    expect(outcomeOf(old.oldRequestId)).toBe(ChangeOutcome.Rejected);
    expect(outcomeOf(id)).toBe(ChangeOutcome.Accepted);
  });
});
