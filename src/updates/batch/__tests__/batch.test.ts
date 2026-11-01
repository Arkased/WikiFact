import { describe, expect, it } from "vitest";
import { parseConfig } from "../../../config/index.js";
import {
  BatchReconciliation,
  BatchRunStatus,
  BatchStopReason,
  ChangeOutcome,
  LogEvent,
  LogLevel,
  ProcessOutcome,
  RequestKind,
  RequestStatus,
  Q4Relation,
  SupportKind,
} from "../../../domain/enums.js";
import type { LogLine } from "../../../log/index.js";
import {
  DUPLICATE_FACT_NEIGHBORS,
  MAX_ATTEMPTS,
  checkIndex,
  enqueueRequest,
  getFactMaterial,
  getRequest,
  highestChangeSeq,
  recordModelCall,
  readBatchProgress,
  readBatchStartSeq,
  recordSearch,
  search,
  seedChange,
  countStagedChanges,
  type Store,
} from "../../../store/index.js";
import { StubQuestions, draftOf, type StubAnswers } from "../../../../fakes/stub-questions.js";
import { stubGroupCall } from "../../../../fakes/stub-group-call.js";
import { accepted, draft, makeFileStore as makeStore } from "../../../../__tests__/helpers/store.js";
import { versions } from "../../../../__tests__/helpers/updates.js";
import type { GroupCall } from "../../types.js";
import { runBatch, type BatchRunResult } from "../index.js";

const JUSTIFICATION = "I saw it.";
const settings = parseConfig({ embeddingModel: "test-model" }).highVolume;
/** A cut under which no 2 requests group: every request is a group of 1. */
const NO_GROUPS = 0;
/** A cut over which all requests group. */
const ONE_GROUP = 2;

interface Rig {
  store: Store;
  q: StubQuestions;
  logs: LogLine[];
  ids: string[];
  add(change: string, targets?: string[], searchId?: string): string;
  run(over?: {
    probe?: () => BatchStopReason | undefined;
    concurrency?: number;
    groupCut?: number;
  }): Promise<BatchRunResult>;
}

function rig(answers: StubAnswers = {}): Rig {
  const store = makeStore();
  const q = new StubQuestions(answers);
  const logs: LogLine[] = [];
  const ids: string[] = [];
  let t = 1_000;
  const common = {
    store,
    questions: q,
    config: { subject: "Minecraft" },
    log: (l: LogLine) => logs.push(l),
  };
  return {
    store,
    q,
    logs,
    ids,
    add(change, targets, searchId) {
      if (searchId)
        recordSearch(store, { id: searchId, sessionId: null, query: "prior", at: t, durationMs: 1, results: [] });
      const id = enqueueRequest(
        store,
        { change, justification: JUSTIFICATION, ...(targets ? { targets } : {}), ...(searchId ? { searchId } : {}) },
        t++,
      );
      ids.push(id);
      return id;
    },
    run(over = {}) {
      return runBatch({
        ...common,
        settings: {
          ...settings,
          concurrency: over.concurrency ?? settings.concurrency,
          groupCut: over.groupCut ?? NO_GROUPS,
        },
        probe: over.probe ?? (() => undefined),
        ids: [...ids],
      });
    },
  };
}

function done(r: BatchRunResult): Extract<BatchRunResult, { status: BatchRunStatus.Done }> {
  if (r.status !== BatchRunStatus.Done) throw new Error(`expected done, got ${JSON.stringify(r)}`);
  return r;
}

const live = (store: Store, id: string): boolean => {
  const m = getFactMaterial(store, id);
  return m !== null && !m.isDeleted;
};

describe("a batch end to end", () => {
  it("runs the pipeline for each request, writes one change each and ends with the start seq deleted", async () => {
    const r = rig();
    r.add("Zombies burn in sunlight daily");
    r.add("Skeletons shoot arrows at players");
    r.add("Endermen teleport when hit by arrows");
    const res = done(await r.run());
    expect(res).toMatchObject({ size: 3, outcomes: { [ProcessOutcome.Accepted]: 3 }, failed: 0, stale: 0 });
    for (const id of r.ids) expect(getRequest(r.store, id)?.status).toBe(RequestStatus.Done);
    expect(r.store.db.prepare("SELECT COUNT(*) AS n FROM changes").get()).toEqual({ n: 3 });
    expect(readBatchStartSeq(r.store)).toBeUndefined();
    expect(r.logs.filter((l) => l.event === LogEvent.BatchDone)).toHaveLength(1);
  });

  it("runs up to the concurrency at once and no more", async () => {
    let inFlight = 0;
    let peak = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const r = rig({
      q7: async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        // The first call waits until a second one is in flight: a pool of 2 reaches that, a pool of 1 never would.
        if (inFlight === 2) release();
        await gate;
        inFlight--;
        return { oneClaim: true, claims: [], support: SupportKind.Observation, reason: "" };
      },
    });
    for (let i = 0; i < 5; i++) r.add(`Claim ${i} about mobs`);
    done(await r.run({ concurrency: 2 }));
    expect(peak).toBe(2);
  });
});

describe("the group judge", () => {
  it("judges a group of 2 with 1 group call and writes both answers, with no Q4 or Q5 of the full pipeline", async () => {
    const r = rig();
    let calls = 0;
    const inner = stubGroupCall();
    r.q.group = {
      retries: 0,
      ask: (input, ctx) => {
        calls++;
        expect(input.claims.map((c) => c.position)).toEqual([1, 2]);
        return inner.ask(input, ctx);
      },
    };
    r.add("Zombies burn in sunlight daily");
    r.add("Skeletons shoot arrows at players");
    const res = done(await r.run({ groupCut: ONE_GROUP }));
    expect(calls).toBe(1);
    expect(res).toMatchObject({ size: 2, outcomes: { [ProcessOutcome.Accepted]: 2 }, failed: 0, stale: 0 });
    expect(r.q.count("q4")).toBe(0);
    expect(r.q.count("q5")).toBe(0);
    expect(r.q.count("q7")).toBe(2);
    for (const id of r.ids) expect(getRequest(r.store, id)?.status).toBe(RequestStatus.Done);
    expect(r.store.db.prepare("SELECT COUNT(*) AS n FROM changes").get()).toEqual({ n: 2 });
  });

  it("falls back to the pipeline of 1 request at a time when the group answer is invalid twice", async () => {
    const r = rig();
    let calls = 0;
    const failing: GroupCall = {
      retries: 1,
      ask: () => {
        calls++;
        return Promise.reject(new Error("the group answer is invalid"));
      },
    };
    r.q.group = failing;
    r.add("Zombies burn in sunlight daily");
    r.add("Skeletons shoot arrows at players");
    const res = done(await r.run({ groupCut: ONE_GROUP }));
    expect(calls).toBe(1);
    expect(res).toMatchObject({ size: 2, outcomes: { [ProcessOutcome.Accepted]: 2 }, failed: 0 });
    // The pipeline ran for each member, from the gather on: Q7 was not asked again.
    expect(r.q.count("q5")).toBe(2);
    expect(r.q.count("q7")).toBe(2);
    expect(r.logs.filter((l) => l.event === LogEvent.Unhandled && l.level === LogLevel.Warn)).toHaveLength(1);
    for (const id of r.ids) expect(getRequest(r.store, id)?.status).toBe(RequestStatus.Done);
  });

  it("does not stale-refuse a claim for the staged write of its own group mate", async () => {
    const r = rig({ q1: (input) => ({ matches: input.candidates.map((c) => c.factId) }) });
    const seeded = await seedChange(
      r.store,
      accepted([draft({ header: "Creeper damage", content: "Creepers do 10 damage." })]),
    );
    const [fact = ""] = seeded.factIds;
    r.q.group = {
      retries: 0,
      ask: (input) =>
        Promise.resolve({
          output: {
            answers: input.claims.map((c) => ({
              position: c.position,
              target: { factId: fact },
              verdict: { supported: true, relation: Q4Relation.Different, wrongRelated: [], reason: "" },
              draft: { header: "Creeper damage", content: c.change, references: [] },
            })),
          },
          usage: { input: 0, output: 0 },
        }),
    };
    r.add("Creepers do 11 damage", [fact]);
    r.add("Creepers do 12 damage", [fact]);
    const res = done(await r.run({ groupCut: ONE_GROUP }));
    expect(res.stale).toBe(0);
    expect(versions(r.store, fact)).toHaveLength(3);
  });
});

describe("the stale check", () => {
  // Both requests correct the same fact. Both gather before either writes; the second write is refused and the request
  // runs again alone, from the version of the first.
  it("refuses the second write of 2 requests on one fact and runs that request again alone", async () => {
    let arrived = 0;
    let liveAtRerun = -1;
    let leftAtRerun: boolean | undefined;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const r = rig({
      q1: (input) => ({ matches: input.candidates.map((c) => c.factId) }),
      q4: (input) => ({
        supported: true,
        relation: input.existing ? Q4Relation.Different : undefined,
        wrongRelated: [],
        reason: "",
      }),
      q5: async (input) => {
        const n = arrived++;
        if (n === 2) {
          liveAtRerun = liveCount(r.store, "changes");
          // A crash during the rerun must find no staging set of a batch that is already promoted.
          leftAtRerun = readBatchStartSeq(r.store) !== undefined || countStagedChanges(r.store) > 0;
        }
        if (n < 2) {
          if (arrived === 2) release();
          await gate;
        }
        return draftOf({ header: "Creeper damage", content: input.change });
      },
    });
    const seeded = await seedChange(
      r.store,
      accepted([draft({ header: "Creeper damage", content: "Creepers do 10 damage." })]),
    );
    const [fact = ""] = seeded.factIds;
    r.add("Creepers do 11 damage", [fact]);
    r.add("Creepers do 12 damage", [fact]);
    const res = done(await r.run({ concurrency: 2 }));
    expect(res.stale).toBe(1);
    expect(res.outcomes).toEqual({ [ProcessOutcome.Accepted]: 2 });
    expect(versions(r.store, fact)).toHaveLength(3);
    expect(r.logs.filter((l) => l.event === LogEvent.BatchStale)).toHaveLength(1);
    for (const id of r.ids) expect(getRequest(r.store, id)?.status).toBe(RequestStatus.Done);
    // The first pass asked q5 twice, the rerun once more.
    expect(arrived).toBe(3);
    // The rerun ran after the promotion: the live wiki held the seed and the promoted request by then.
    expect(liveAtRerun).toBe(2);
    expect(leftAtRerun).toBe(false);
    // Both requests are done: the one that the promotion marked and the one that ran again.
    expect(readBatchProgress(r.store)).toMatchObject({ done: 2, taken: 2 });
  });

  it("runs the requests of a batch that touch different facts without a rerun", async () => {
    const r = rig();
    const a = await seedChange(r.store, accepted([draft({ header: "A", content: "Alpha" })]));
    const b = await seedChange(r.store, accepted([draft({ header: "B", content: "Beta" })]));
    r.add("Alpha is now Gamma", a.factIds);
    r.add("Beta is now Delta", b.factIds);
    expect(done(await r.run({ concurrency: 2 })).stale).toBe(0);
  });
});

describe("the reconciliation", () => {
  const FUSE = "A creeper fuse lasts 1.5 seconds.";
  const duplicates = {
    // The submissions get no match at the gather; the reconciliation asks Q1 with the text of a new fact.
    q1: (input: { change: string; candidates: { factId: string }[] }) => ({
      matches: input.change.includes(FUSE) ? input.candidates.slice(0, 1).map((c) => c.factId) : [],
    }),
    q5: (input: { change: string }) => draftOf({ header: input.change.slice(0, 30), content: FUSE }),
  };

  it("merges 2 new facts of the batch that share one scope, into the older fact", async () => {
    const r = rig(duplicates);
    r.add("Creeper fuse takes 30 ticks");
    r.add("The fuse of a creeper burns 1.5 s");
    const res = done(await r.run({ concurrency: 1 }));
    expect(res.merged).toBe(1);
    const facts = (r.store.db.prepare("SELECT id FROM facts ORDER BY id").all() as { id: string }[]).map((f) => f.id);
    expect(facts.filter((id) => live(r.store, id))).toHaveLength(1);
    expect(readBatchStartSeq(r.store)).toBeUndefined();
  });

  it("judges a pair of 2 new facts that are each other's neighbor 1 time", async () => {
    const r = rig({
      q1: () => ({ matches: [] }),
      q5: (input: { change: string }) => draftOf({ header: input.change, content: FUSE }),
    });
    r.add("Creeper fuse takes 30 ticks");
    r.add("The fuse of a creeper burns 1.5 s");
    const res = done(await r.run({ concurrency: 1 }));
    expect(res.merged).toBe(0);
    // Neither submission finds a live fact to ask Q1 about; the reconciliation asks it once for the pair, not twice.
    expect(r.q.count("q1")).toBe(1);
  });

  it("gives a pair inside 1 group no check", async () => {
    const r = rig(duplicates);
    r.add("Creeper fuse takes 30 ticks");
    r.add("The fuse of a creeper burns 1.5 s");
    const res = done(await r.run({ concurrency: 1, groupCut: ONE_GROUP }));
    expect(res.merged).toBe(0);
    // The facts of the one group stay as the group call (or its fallback) judged them: both are live.
    const facts = (r.store.db.prepare("SELECT id FROM facts").all() as { id: string }[]).map((f) => f.id);
    expect(facts.filter((id) => live(r.store, id))).toHaveLength(2);
  });

  it("keeps the progress of the batch: the requests done of those taken, and the reconciliation done", async () => {
    const r = rig();
    r.add("Zombies burn in sunlight daily");
    r.add("Skeletons shoot arrows at players");
    done(await r.run());
    expect(readBatchProgress(r.store)).toEqual({
      taken: 2,
      done: 2,
      staged: 2,
      stale: 0,
      reconciliation: BatchReconciliation.Done,
    });
  });

  it("leaves facts of different scopes alone", async () => {
    const r = rig({ q5: (input: { change: string }) => draftOf({ header: input.change, content: input.change }) });
    r.add("Zombies burn in sunlight daily");
    r.add("Skeletons shoot arrows at players");
    expect(done(await r.run()).merged).toBe(0);
  });
});

const lookupRepairs = (store: Store): { targets: string[]; searchId: string | null }[] =>
  (
    store.db
      .prepare("SELECT targets, search_id AS searchId FROM change_requests WHERE kind = ? ORDER BY received_at")
      .all(RequestKind.LookupRepair) as { targets: string; searchId: string | null }[]
  ).map((q) => ({ targets: JSON.parse(q.targets) as string[], searchId: q.searchId }));

describe("step 3 and step 9 in a batch", () => {
  it("refuses a request whose scope holds 2 live facts and runs it again alone, after the promotion, with the merge", async () => {
    const r = rig({ q1: (input) => ({ matches: input.candidates.map((c) => c.factId) }) });
    const a = await seedChange(r.store, accepted([draft({ header: "Fuse A", content: "A fuse lasts 30 ticks." })]));
    const b = await seedChange(r.store, accepted([draft({ header: "Fuse B", content: "A fuse lasts 1.5 seconds." })]));
    r.add("The fuse of a creeper lasts 1.5 seconds");
    const res = done(await r.run({ concurrency: 1 }));
    expect(res.stale).toBe(1);
    expect(getRequest(r.store, r.ids[0] ?? "")?.status).toBe(RequestStatus.Done);
    // The rerun merged the 2 live facts into 1.
    const facts = [...a.factIds, ...b.factIds];
    expect(facts.filter((id) => live(r.store, id)).length).toBeLessThan(2);
  });

  it("skips step 9 in the batch and queues the check in the promotion, on the fact that the request wrote", async () => {
    const r = rig();
    r.add("Zombies burn in sunlight daily", undefined, "s-zombie");
    done(await r.run({ concurrency: 1 }));
    const checks = lookupRepairs(r.store);
    expect(checks).toHaveLength(1);
    expect(checks[0]?.searchId).toBe("s-zombie");
    const [fact = ""] = checks[0]?.targets ?? [];
    expect(live(r.store, fact)).toBe(true);
  });

  it("queues no check and loses none when the batch stops before the promotion: the request stays queued", async () => {
    let calls = 0;
    const r = rig();
    r.add("Claim one about mobs", undefined, "s-one");
    r.add("Claim two about mobs", undefined, "s-two");
    const res = await r.run({ concurrency: 1, probe: () => (calls++ === 0 ? undefined : BatchStopReason.QueuePause) });
    expect(res).toMatchObject({ status: BatchRunStatus.Stopped });
    expect(lookupRepairs(r.store)).toEqual([]);
    for (const id of r.ids) expect(getRequest(r.store, id)?.status).toBe(RequestStatus.Queued);
  });

  it("aims the check of a fact that the reconciliation merged away at the fact that it kept", async () => {
    const FUSE = "A creeper fuse lasts 1.5 seconds.";
    const r = rig({
      q1: (input) => ({
        matches: input.change.includes(FUSE) ? input.candidates.slice(0, 1).map((c) => c.factId) : [],
      }),
      q5: (input) => draftOf({ header: input.change.slice(0, 30), content: FUSE }),
    });
    r.add("Creeper fuse takes 30 ticks", undefined, "s-1");
    r.add("The fuse of a creeper burns 1.5 s", undefined, "s-2");
    const res = done(await r.run({ concurrency: 1 }));
    expect(res.merged).toBe(1);
    const checks = lookupRepairs(r.store);
    expect(checks).toHaveLength(2);
    // Both prior queries are checked against the one live fact; none names the fact that was merged away.
    const targets = new Set(checks.flatMap((c) => c.targets));
    expect(targets.size).toBe(1);
    expect(live(r.store, [...targets][0] ?? "")).toBe(true);
  });

  it("reconciles the live facts that 2 requests of the batch edit into one scope: 1 live fact is left", async () => {
    const FUSE = "A creeper fuse lasts 1.5 seconds.";
    const r = rig({
      // A request matches the fact that it names; the reconciliation asks with the staged content and gets the first neighbor.
      q1: (input) => ({
        matches: (input.change.includes(FUSE)
          ? input.candidates.slice(0, 1)
          : input.candidates.filter((c) => input.change.startsWith(c.header))
        ).map((c) => c.factId),
      }),
      q4: (input) => ({
        supported: true,
        relation: input.existing ? Q4Relation.Different : undefined,
        wrongRelated: [],
        reason: "",
      }),
      q5: () => draftOf({ header: "Creeper fuse", content: FUSE }),
    });
    const a = await seedChange(r.store, accepted([draft({ header: "Fuse A", content: "Fuse A lasts 30 ticks." })]));
    const b = await seedChange(r.store, accepted([draft({ header: "Fuse B", content: "Fuse B lasts 20 ticks." })]));
    r.add("Fuse A is 1.5 seconds", a.factIds);
    r.add("Fuse B is 1.5 seconds", b.factIds);
    const res = done(await r.run({ concurrency: 1 }));
    expect(res.merged).toBe(1);
    const all = (r.store.db.prepare("SELECT id FROM facts").all() as { id: string }[]).map((f) => f.id);
    expect(all.filter((id) => live(r.store, id))).toHaveLength(1);
  });
});

describe("the pair check of the reconciliation", () => {
  const FUSE = "A creeper fuse lasts 1.5 seconds.";
  const fuseAnswers = {
    q1: (input: { change: string; candidates: { factId: string }[] }) => ({
      matches: input.change.includes(FUSE) ? input.candidates.slice(0, 1).map((c) => c.factId) : [],
    }),
    q5: (input: { change: string }) => draftOf({ header: input.change.slice(0, 30), content: FUSE }),
  };

  it("leaves a new fact alone next to a live fact from before the batch: the request read the live fact at its own Q1", async () => {
    const r = rig(fuseAnswers);
    await seedChange(r.store, accepted([draft({ header: "Fuse", content: FUSE })]));
    r.add("Creeper fuse takes 30 ticks");
    expect(done(await r.run({ concurrency: 1 })).merged).toBe(0);
  });

  it("takes the nearest facts among the facts of other groups, so live facts do not crowd them out", async () => {
    const r = rig(fuseAnswers);
    // More live facts of the same text than the pair check takes, all as near to the new facts as the new facts are to each other.
    for (let i = 0; i < DUPLICATE_FACT_NEIGHBORS + 1; i++) {
      await seedChange(r.store, accepted([draft({ header: `Fuse ${i}`, content: FUSE })]));
    }
    r.add("Creeper fuse takes 30 ticks");
    r.add("The fuse of a creeper burns 1.5 s");
    expect(done(await r.run({ concurrency: 1 })).merged).toBe(1);
  });
});

describe("a request refused from the gather", () => {
  const crowded = async (answers: StubAnswers): Promise<Rig> => {
    const r = rig({ q1: (input) => ({ matches: input.candidates.map((c) => c.factId) }), ...answers });
    await seedChange(r.store, accepted([draft({ header: "Fuse A", content: "A fuse lasts 30 ticks." })]));
    await seedChange(r.store, accepted([draft({ header: "Fuse B", content: "A fuse lasts 1.5 seconds." })]));
    return r;
  };

  it("keeps the answer of Q7 for the rerun: the rerun starts at the gather", async () => {
    const r = await crowded({});
    r.add("The fuse of a creeper lasts 1.5 seconds");
    const res = done(await r.run({ concurrency: 1 }));
    expect(res.stale).toBe(1);
    expect(r.q.count("q7")).toBe(1);
    expect(getRequest(r.store, r.ids[0] ?? "")?.status).toBe(RequestStatus.Done);
  });

  it("runs the refused requests after the promotion in queue order, not in the order of their refusal", async () => {
    const order: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const r = await crowded({
      q7: async (input) => {
        // The first request is held until the third has answered, so that it is refused last.
        if (input.change.includes("first")) await gate;
        if (input.change.includes("third")) release();
        return { oneClaim: true, claims: [], support: SupportKind.Observation, reason: "" };
      },
      q5: (input) => {
        order.push(input.change);
        return draftOf({ header: "Fuse A", content: input.change });
      },
    });
    r.add("The first fuse claim");
    r.add("The second fuse claim");
    r.add("The third fuse claim");
    const res = done(await r.run({ concurrency: 3 }));
    expect(res.stale).toBe(3);
    expect(order.map((c) => c.split(" ")[1])).toEqual(["first", "second", "third"]);
  });
});

describe("the children of a split", () => {
  const FUSE = "A creeper fuse lasts 1.5 seconds.";
  const PARTS = ["Zombies burn in sunlight daily", "Skeletons shoot arrows at players"];
  const splitting = (): Rig => {
    const r = rig({
      q7: (input) =>
        input.change.startsWith("Compound")
          ? { oneClaim: false, claims: PARTS, support: SupportKind.Observation, reason: "" }
          : { oneClaim: true, claims: [], support: SupportKind.Observation, reason: "" },
      q5: (input) => draftOf({ header: input.change, content: input.change }),
    });
    r.add("Compound claim about mobs");
    return r;
  };
  const statusOfChildren = (r: Rig): (RequestStatus | undefined)[] =>
    (r.store.db.prepare("SELECT id FROM change_requests WHERE id <> ?").all(r.ids[0] ?? "") as { id: string }[]).map(
      (c) => getRequest(r.store, c.id)?.status,
    );

  it("runs the children in the same batch: done at the promotion, their facts live", async () => {
    const r = splitting();
    const res = done(await r.run({ concurrency: 1 }));
    expect(res.size).toBe(3);
    expect(res.outcomes).toEqual({ [ProcessOutcome.Accepted]: 2, [ProcessOutcome.Split]: 1 });
    expect(statusOfChildren(r)).toEqual([RequestStatus.Done, RequestStatus.Done]);
    expect(getRequest(r.store, r.ids[0] ?? "")?.status).toBe(RequestStatus.Done);
    expect(liveCount(r.store, "facts")).toBe(2);
    expect(readBatchStartSeq(r.store)).toBeUndefined();
    expect(countStagedChanges(r.store)).toBe(0);
  });

  it("reconciles a child with the other facts of the batch", async () => {
    const r = rig({
      q1: (input) => ({
        matches: input.change.includes(FUSE) ? input.candidates.slice(0, 1).map((c) => c.factId) : [],
      }),
      q7: (input) =>
        input.change.startsWith("Compound")
          ? {
              oneClaim: false,
              claims: ["Creeper fuse takes 30 ticks", "Zombies burn in sunlight daily"],
              support: SupportKind.Observation,
              reason: "",
            }
          : { oneClaim: true, claims: [], support: SupportKind.Observation, reason: "" },
      q5: (input) =>
        draftOf({
          header: input.change.slice(0, 30),
          content: input.change.toLowerCase().includes("fuse") ? FUSE : input.change,
        }),
    });
    r.add("Compound claim about creepers");
    r.add("The fuse of a creeper burns 1.5 s");
    const res = done(await r.run({ concurrency: 1 }));
    expect(res.merged).toBe(1);
  });

  // Makes the stub write a `model_calls` row under `ctx.requestId`, as the real `Caller` does.
  const recordCalls = (r: Rig): void => {
    const record = (question: string, requestId: string | undefined): void => {
      if (requestId === undefined) return;
      recordModelCall(r.store, {
        requestId,
        question,
        model: "stub",
        effort: "low",
        tokensIn: 1,
        tokensOut: 1,
        tokensCacheRead: 0,
        tokensCacheWrite: 0,
        durationMs: 1,
        at: 1,
      });
    };
    const q7 = r.q.q7.bind(r.q);
    r.q.q7 = (input, ctx) => {
      record("Q7", ctx.requestId);
      return q7(input, ctx);
    };
    const group = r.q.group;
    r.q.group = {
      retries: 0,
      ask: (input, ctx) => {
        record("QG", ctx.requestId);
        return group.ask(input, ctx);
      },
    };
  };
  const callRows = (r: Rig): { request_id: string; question: string }[] =>
    r.store.db.prepare("SELECT request_id, question FROM model_calls").all() as {
      request_id: string;
      question: string;
    }[];

  it("writes the model call rows of the children under the parent, and judges them in the batch", async () => {
    const r = splitting();
    recordCalls(r);
    const res = done(await r.run({ concurrency: 1 }));
    expect(res).toMatchObject({
      size: 3,
      failed: 0,
      outcomes: { [ProcessOutcome.Accepted]: 2, [ProcessOutcome.Split]: 1 },
    });
    const rows = callRows(r);
    expect(rows.filter((c) => c.question === "Q7")).toHaveLength(3);
    expect(rows.every((c) => c.request_id === r.ids[0])).toBe(true);
  });

  it("does the same for 2 children in 1 group", async () => {
    const r = splitting();
    recordCalls(r);
    const res = done(await r.run({ concurrency: 1, groupCut: ONE_GROUP }));
    expect(res).toMatchObject({ failed: 0, outcomes: { [ProcessOutcome.Accepted]: 2, [ProcessOutcome.Split]: 1 } });
    const rows = callRows(r);
    expect(rows.some((c) => c.question === "QG")).toBe(true);
    expect(rows.every((c) => c.request_id === r.ids[0])).toBe(true);
  });

  it("sends a child that met a rate limit back to the queue and drops the batch", async () => {
    const r = rig({
      q7: (input) => {
        if (input.change.startsWith("Compound")) {
          return { oneClaim: false, claims: PARTS, support: SupportKind.Observation, reason: "" };
        }
        throw new Error("API Error: 429 rate limit, resets 4pm");
      },
    });
    r.add("Compound claim about mobs");
    const res = await r.run({ concurrency: 1 });
    expect(res.status).toBe(BatchRunStatus.RateLimited);
    expect(readBatchStartSeq(r.store)).toBeUndefined();
    expect(countStagedChanges(r.store)).toBe(0);
    // The parent is queued again and splits again; no child row is left in the live queue.
    expect(getRequest(r.store, r.ids[0] ?? "")?.status).toBe(RequestStatus.Queued);
    expect(statusOfChildren(r)).toEqual([]);
  });
});

const liveCount = (store: Store, table: string): number =>
  (store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe("the staging set", () => {
  it("keeps the live wiki unchanged while the batch runs, and shows the staged changes in the progress", async () => {
    const seen: { changes: number; facts: number; staged: number | undefined }[] = [];
    const r = rig({
      q5: (input: { change: string }) => {
        seen.push({
          changes: liveCount(r.store, "changes"),
          facts: liveCount(r.store, "facts"),
          staged: readBatchProgress(r.store)?.staged,
        });
        return draftOf({ header: input.change, content: input.change });
      },
    });
    r.add("Zombies burn in sunlight daily");
    r.add("Skeletons shoot arrows at players");
    r.add("Endermen teleport when hit by arrows");
    const res = done(await r.run({ concurrency: 1 }));
    // Each request saw a live wiki with no change and no fact, while the staged count grew.
    expect(seen).toEqual([
      { changes: 0, facts: 0, staged: 0 },
      { changes: 0, facts: 0, staged: 1 },
      { changes: 0, facts: 0, staged: 2 },
    ]);
    expect(res.promoted).toBe(3);
    expect(liveCount(r.store, "changes")).toBe(3);
    expect(liveCount(r.store, "facts")).toBe(3);
  });

  it("promotes the changes of the batch with the next seqs of the live wiki, and indexes them", async () => {
    const r = rig();
    await seedChange(r.store, accepted([draft({ header: "Old", content: "Old fact" })]));
    const start = highestChangeSeq(r.store);
    r.add("Zombies burn in sunlight daily");
    r.add("Skeletons shoot arrows at players");
    r.add("Endermen teleport when hit by arrows");
    done(await r.run({ concurrency: 1 }));
    const rows = r.store.db.prepare("SELECT seq, request_id AS requestId FROM changes WHERE seq > ?").all(start) as {
      seq: number;
      requestId: string;
    }[];
    // The order of the changes is not part of the contract (docs/technical/updates.md#high-volume-mode): the set of requests and the set of seqs are.
    expect(rows.map((c) => c.requestId).sort()).toEqual([...r.ids].sort());
    expect(rows.map((c) => c.seq).sort((a, b) => a - b)).toEqual([start + 1, start + 2, start + 3]);
    expect(checkIndex(r.store)).toEqual([]);
    expect((await search(r.store, "Zombies burn in sunlight daily")).length).toBeGreaterThan(0);
  });

  it("marks the requests done at the promotion, not before", async () => {
    const statuses: (RequestStatus | undefined)[] = [];
    const r = rig({
      q5: (input: { change: string }) => {
        statuses.push(getRequest(r.store, r.ids[0] ?? "")?.status);
        return draftOf({ header: input.change, content: input.change });
      },
    });
    r.add("Zombies burn in sunlight daily");
    r.add("Skeletons shoot arrows at players");
    done(await r.run({ concurrency: 1 }));
    // While the second request ran, the first had ended on the staging set but was still running on the live wiki.
    expect(statuses).toEqual([RequestStatus.Running, RequestStatus.Running]);
    for (const id of r.ids) expect(getRequest(r.store, id)?.status).toBe(RequestStatus.Done);
  });

  // The live wiki gets a write during every run, as if a second writer existed: the promotion fails on each batch.
  const movingLive = (): Rig => {
    const r: Rig = rig({
      q5: async (input: { change: string }) => {
        await seedChange(r.store, accepted([draft({ header: input.change, content: "Written next to the batch" })]));
        return draftOf({ header: input.change, content: input.change });
      },
    });
    return r;
  };

  it("drops the batch when the live wiki moved: the staging set and the key are gone, the requests are queued, the live wiki is unchanged", async () => {
    const r = movingLive();
    r.add("Zombies burn in sunlight daily");
    r.add("Skeletons shoot arrows at players");
    const res = await r.run({ concurrency: 1 });
    expect(res).toMatchObject({ status: BatchRunStatus.Dropped, ids: r.ids });
    // The fault is the batch's: no request is charged an attempt.
    for (const id of r.ids)
      expect(getRequest(r.store, id)).toMatchObject({ status: RequestStatus.Queued, attempts: 0 });
    // Only the changes of the live writes are there: 2 requests, 2 writes next to them.
    expect(liveCount(r.store, "changes")).toBe(2);
    expect(readBatchStartSeq(r.store)).toBeUndefined();
    expect(countStagedChanges(r.store)).toBe(0);
    const dropped = r.logs.filter((l) => l.event === LogEvent.BatchDropped);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatchObject({ level: LogLevel.Error, reason: (res as { error: string }).error });
    // A request that went back to the queue is not done.
    expect(readBatchProgress(r.store)).toMatchObject({ done: 0, reconciliation: BatchReconciliation.Pending });
  });

  it("charges no attempt however often the promotion fails: the request never ends failed for it", async () => {
    const r = movingLive();
    const id = r.add("Zombies burn in sunlight daily");
    for (let i = 0; i < MAX_ATTEMPTS + 1; i++) {
      expect((await r.run({ concurrency: 1 })).status).toBe(BatchRunStatus.Dropped);
    }
    expect(getRequest(r.store, id)).toMatchObject({ status: RequestStatus.Queued, attempts: 0 });
  });
});

describe("stops and failures", () => {
  it("stops before the first request at a probe reason, drops the staging set and leaves the requests queued", async () => {
    const r = rig();
    r.add("Claim one about mobs");
    const res = await r.run({ probe: () => BatchStopReason.QueuePause });
    expect(res).toEqual({ status: BatchRunStatus.Stopped, reason: BatchStopReason.QueuePause });
    expect(getRequest(r.store, r.ids[0] ?? "")?.status).toBe(RequestStatus.Queued);
    expect(readBatchStartSeq(r.store)).toBeUndefined();
    expect(countStagedChanges(r.store)).toBe(0);
  });

  it("stops after the first request: the live wiki is unchanged and every request is queued again", async () => {
    let calls = 0;
    const r = rig();
    r.add("Claim one about mobs");
    r.add("Claim two about mobs");
    const res = await r.run({ concurrency: 1, probe: () => (calls++ === 0 ? undefined : BatchStopReason.QueuePause) });
    expect(res).toMatchObject({ status: BatchRunStatus.Stopped });
    for (const id of r.ids) expect(getRequest(r.store, id)?.status).toBe(RequestStatus.Queued);
    expect(liveCount(r.store, "changes")).toBe(0);
    expect(liveCount(r.store, "facts")).toBe(0);
  });
});

describe("failures", () => {
  it("settles a rate limit: no further request starts, the request goes back to the queue and the staging set is dropped", async () => {
    const r = rig({
      q7: () => {
        throw new Error("API Error: 429 rate limit, resets 4pm");
      },
    });
    r.add("Claim one about mobs");
    r.add("Claim two about mobs");
    const res = await r.run({ concurrency: 1 });
    expect(res.status).toBe(BatchRunStatus.RateLimited);
    for (const id of r.ids) expect(getRequest(r.store, id)?.status).toBe(RequestStatus.Queued);
    expect(r.q.count("q7")).toBe(1);
    expect(readBatchStartSeq(r.store)).toBeUndefined();
    expect(liveCount(r.store, "changes")).toBe(0);
  });

  it("counts a request that fails its attempt and finishes the others", async () => {
    const r = rig({
      q5: (input: { change: string }) => {
        if (input.change.includes("bad")) throw new Error("boom");
        return draftOf({ header: input.change, content: input.change });
      },
    });
    r.add("A good claim about mobs");
    r.add("A bad claim about mobs");
    const res = done(await r.run());
    expect(res).toMatchObject({ failed: 1, error: "boom" });
    expect(res.outcomes).toEqual({ [ProcessOutcome.Accepted]: 1 });
    expect(
      r.store.db.prepare("SELECT COUNT(*) AS n FROM changes WHERE outcome = ?").get(ChangeOutcome.Accepted),
    ).toEqual({
      n: 1,
    });
  });
});
