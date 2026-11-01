import { afterEach, describe, expect, it } from "vitest";
import {
  ChangeOutcome,
  CleanupFinder,
  LogEvent,
  OperatorEditKind,
  ProcessOutcome,
  Q2Stands,
  RejectReason,
  RunOnceStatus,
  CleanupRepairResult,
} from "../../domain/enums.js";
import type { LogLine } from "../../log/index.js";
import {
  cleanupCandidates,
  closeStore,
  enqueueOperatorEdit,
  enqueueCleanupRepair,
  getFactMaterial,
  isCovered,
  parseCleanupRepair,
  seedChange,
  verdictSubject,
  type Store,
} from "../../store/index.js";
import { T0, accepted, draft, makeStore } from "../../../__tests__/helpers/store.js";
import { changesOf, refs, versions } from "../../../__tests__/helpers/updates.js";
import { runOnce, type RunOnceResult } from "../index.js";
import { queuedRepairs } from "./helpers/cleanup.js";
import { scripted, type Scripts } from "./helpers/scripted-questions.js";

const stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) closeStore(s);
});

type FactSpec = Parameters<typeof draft>[0];

function world(scripts: Scripts = {}) {
  const store = makeStore();
  stores.push(store);
  const s = scripted(scripts);
  const logs: LogLine[] = [];
  let clock = T0;
  const put = async (spec: FactSpec): Promise<string> => {
    clock += 1000;
    const res = await seedChange(store, accepted([draft(spec)]), { now: clock });
    const [id] = res.factIds;
    if (id === undefined) throw new Error("no fact written");
    return id;
  };
  const run = async (): Promise<RunOnceResult> => {
    const r = await runOnce(store, s.q, { subject: "Minecraft" }, { log: (l) => logs.push(l), now: () => clock });
    if (r.status !== RunOnceStatus.Done) throw new Error(`expected done, got ${JSON.stringify(r)}`);
    return r;
  };
  const live = (id: string): boolean => {
    const m = getFactMaterial(store, id);
    return m !== null && !m.isDeleted;
  };
  return { store, s, logs, put, run, live };
}

const FUSE = "A creeper fuse burns for 1.5 seconds.";
const older = { header: "Creeper fuse time", content: FUSE };
const newer = { header: "Creeper fuse duration", content: FUSE };

describe("a cleanupRepair request of the duplicate fact finder", () => {
  it("asks Q1 with the newer fact as the claim and the older fact and the other nearest facts as candidates", async () => {
    const w = world({ q1: { matches: [] } });
    const a = await w.put(older);
    const b = await w.put(newer);
    const c = await w.put({ header: "Creeper fuse seconds", content: FUSE });
    enqueueCleanupRepair(w.store, { finder: CleanupFinder.DuplicateFact, factIds: [a, b] });
    await w.run();
    const [input] = w.s.q1;
    expect(input?.change).toContain(newer.header);
    expect(input?.change).toContain(FUSE);
    expect(input?.candidates.map((x) => x.factId)).toEqual(expect.arrayContaining([a, c]));
    expect(input?.candidates.map((x) => x.factId)).not.toContain(b);
    expect(input?.candidates[0]?.factId).toBe(a);
  });

  it("merges the 2 facts into the older one when Q1 returns the older fact, as 1 accepted change", async () => {
    const w = world({ q1: (input) => ({ matches: input.candidates.map((x) => x.factId).slice(0, 1) }) });
    const a = await w.put(older);
    const b = await w.put(newer);
    const dep = await w.put({ header: "Fuse risk", content: "The fuse time is short.", references: [b] });
    const id = enqueueCleanupRepair(w.store, { finder: CleanupFinder.DuplicateFact, factIds: [a, b] });
    const res = await w.run();
    expect(res.status === RunOnceStatus.Done ? res.result.outcome : undefined).toBe(ProcessOutcome.Accepted);
    expect(w.live(a)).toBe(true);
    expect(w.live(b)).toBe(false);
    const changes = changesOf(w.store, id);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.outcome).toBe(ChangeOutcome.Accepted);
    expect(changes[0]?.summary).toContain(older.header);
    // The dependents step of the merge: the dependent of the merged-away fact now references the kept fact.
    const depVersions = versions(w.store, dep);
    expect(depVersions).toHaveLength(2);
    expect(refs(w.store, depVersions[1]?.id ?? 0)).toEqual([a]);
    // The pair is gone from the finder.
    expect(cleanupCandidates(w.store, {}, [CleanupFinder.DuplicateFact]).candidates).toEqual([]);
  });

  it("writes a verdict row for the pair and no change when Q1 does not return the older fact", async () => {
    const w = world({ q1: { matches: [] } });
    const a = await w.put(older);
    const b = await w.put(newer);
    const id = enqueueCleanupRepair(w.store, { finder: CleanupFinder.DuplicateFact, factIds: [a, b] });
    const res = await w.run();
    expect(res.status === RunOnceStatus.Done ? res.result.outcome : undefined).toBe(ProcessOutcome.Skipped);
    expect(changesOf(w.store, id)).toEqual([]);
    expect(isCovered(w.store, CleanupFinder.DuplicateFact, verdictSubject([a, b]))).toBe(true);
    expect(w.live(a) && w.live(b)).toBe(true);
    expect(w.logs.find((l) => l.event === LogEvent.CleanupRepair)).toMatchObject({
      finder: CleanupFinder.DuplicateFact,
      result: CleanupRepairResult.NoChange,
    });
    expect(cleanupCandidates(w.store, {}, [CleanupFinder.DuplicateFact]).candidates).toEqual([]);
  });

  it("writes a verdict row and no change when Q2 calls the 2 facts unrelated, and both facts stay live", async () => {
    const w = world({
      q1: (input) => ({ matches: input.candidates.map((x) => x.factId).slice(0, 1) }),
      q2: { stands: Q2Stands.Unrelated, reason: "different scopes" },
    });
    const a = await w.put(older);
    const b = await w.put(newer);
    const id = enqueueCleanupRepair(w.store, { finder: CleanupFinder.DuplicateFact, factIds: [a, b] });
    const res = await w.run();
    expect(res.status === RunOnceStatus.Done ? res.result.outcome : undefined).toBe(ProcessOutcome.Skipped);
    expect(changesOf(w.store, id)).toEqual([]);
    expect(versions(w.store, a)).toHaveLength(1);
    expect(versions(w.store, b)).toHaveLength(1);
    expect(w.live(a) && w.live(b)).toBe(true);
    expect(isCovered(w.store, CleanupFinder.DuplicateFact, verdictSubject([a, b]))).toBe(true);
    expect(w.logs.find((l) => l.event === LogEvent.CleanupRepair)).toMatchObject({
      finder: CleanupFinder.DuplicateFact,
      result: CleanupRepairResult.NoChange,
    });
    expect(w.logs.find((l) => l.event === LogEvent.ScopeOvermatch)).toMatchObject({
      request_id: id,
      existingFactId: b,
      keptFactId: a,
    });
  });

  it("ends stale with no question and no write when a fact of the pair is deleted", async () => {
    const w = world({ q1: { matches: [] } });
    const a = await w.put(older);
    const b = await w.put(newer);
    await seedChange(w.store, accepted([draft({ factId: b, ...newer, isDeleted: true })]), { now: T0 + 5000 });
    const id = enqueueCleanupRepair(w.store, { finder: CleanupFinder.DuplicateFact, factIds: [a, b] });
    const res = await w.run();
    expect(res.status === RunOnceStatus.Done ? res.result.outcome : undefined).toBe(ProcessOutcome.Skipped);
    expect(w.s.q1).toEqual([]);
    expect(changesOf(w.store, id)).toEqual([]);
    expect(w.logs.find((l) => l.event === LogEvent.CleanupRepair)).toMatchObject({
      finder: CleanupFinder.DuplicateFact,
      result: CleanupRepairResult.Stale,
    });
    expect(isCovered(w.store, CleanupFinder.DuplicateFact, verdictSubject([a, b]))).toBe(false);
  });

  it("rejects a document that names a fact that does not exist, with no question and no write", async () => {
    const w = world({ q1: { matches: [] } });
    const a = await w.put(older);
    const id = enqueueCleanupRepair(w.store, { finder: CleanupFinder.DuplicateFact, factIds: [a, "nope"] });
    const res = await w.run();
    expect(res.status === RunOnceStatus.Done ? res.result.outcome : undefined).toBe(ProcessOutcome.Rejected);
    expect(res.status === RunOnceStatus.Done ? res.result.error : undefined).toBe("fact nope does not exist");
    expect(w.s.q1).toEqual([]);
    expect(changesOf(w.store, id)[0]).toMatchObject({ reject_reason: RejectReason.Unsupported });
  });

  it("refuses a document that names the same fact twice", () => {
    expect(() =>
      parseCleanupRepair(JSON.stringify({ finder: CleanupFinder.DuplicateFact, factIds: ["x", "x"] })),
    ).toThrow(/2 different facts/);
  });

  describe("a queued document that the finder cannot do", () => {
    const insertRaw = (w: ReturnType<typeof world>, change: string): string => {
      w.store.db
        .prepare(
          "INSERT INTO change_requests(id, kind, status, change, targets, received_at) VALUES ('raw1', 'cleanupRepair', 'queued', ?, '[]', 1)",
        )
        .run(change);
      return "raw1";
    };

    it("rejects a document that is not valid, as unsupported, on the first attempt", async () => {
      const w = world();
      const id = insertRaw(w, '{"finder":"nope"}');
      const res = await w.run();
      expect(res).toMatchObject({ result: { outcome: ProcessOutcome.Rejected } });
      expect(changesOf(w.store, id)[0]).toMatchObject({
        outcome: ChangeOutcome.Rejected,
        reject_reason: RejectReason.Unsupported,
      });
    });

    it.each([["oldFinder", { factId: "f1" }]])(
      "rejects a queued %s document of an older wiki, as unsupported, with no write and no question",
      async (finder, rest) => {
        const w = world();
        const a = await w.put(older);
        const id = insertRaw(w, JSON.stringify({ finder, ...rest }));
        const before = versions(w.store, a).length;
        const res = await w.run();
        expect(res).toMatchObject({ result: { outcome: ProcessOutcome.Rejected } });
        expect(changesOf(w.store, id)).toHaveLength(1);
        expect(changesOf(w.store, id)[0]).toMatchObject({
          outcome: ChangeOutcome.Rejected,
          reject_reason: RejectReason.Unsupported,
        });
        expect(versions(w.store, a)).toHaveLength(before);
        expect(w.s.q1).toEqual([]);
        expect(w.s.q2).toEqual([]);
      },
    );
  });

  it("is queued by the operator Run, which runs the duplicate fact finder too", async () => {
    const w = world();
    const a = await w.put(older);
    const b = await w.put(newer);
    enqueueOperatorEdit(w.store, { edit: OperatorEditKind.Cleanup, note: "run now" });
    await w.run();
    const docs = queuedRepairs(w.store).map((r) => JSON.parse(r.change) as unknown);
    expect(docs).toContainEqual({ finder: CleanupFinder.DuplicateFact, factIds: [a, b] });
  });
});
