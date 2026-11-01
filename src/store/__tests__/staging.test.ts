import { describe, expect, it } from "vitest";
import { ChangeOutcome, RejectReason, RequestStatus } from "../../domain/enums.js";
import { T0, accepted, draft, makeFileStore as makeStore } from "../../../__tests__/helpers/store.js";
import {
  LiveMovedError,
  applyChange,
  checkIndex,
  clearStaging,
  closeStore,
  countStagedChanges,
  enqueueRequest,
  getFactMaterial,
  getRequest,
  highestChangeSeq,
  openOverlay,
  promoteStaging,
  resetStaging,
  search,
  seedChange,
  stagedFacts,
  takeRequest,
  type ChangeSet,
  type Store,
} from "../index.js";

const rows = (store: Store, table: string): number =>
  (store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

/**
 * Starts a batch on a live store: empties the staging tables and opens the overlay.
 *
 * @param live - the live store, on a database file
 * @returns the overlay store, the handle a request runs on, and the start seq of the batch
 */
function startBatch(live: Store): { overlay: Store; target: Store; start: number } {
  resetStaging(live);
  const overlay = openOverlay(live);
  return { overlay, target: { ...live, stageTo: overlay }, start: highestChangeSeq(live) };
}

describe("the staging set", () => {
  it("holds the staged change in tables of its own: a write to it does not reach the live tables", async () => {
    const live = makeStore();
    await seedChange(live, accepted([draft({ header: "Seed", content: "Seeded fact" })]), { now: T0 });
    const { overlay, target, start } = startBatch(live);
    const req = enqueueRequest(live, { change: "c", justification: "j" }, T0 + 1);
    await applyChange(target, req, accepted([draft({ header: "Staged", content: "Only staged" })]), { now: T0 + 2 });
    expect(countStagedChanges(live)).toBe(1);
    expect(rows(live, "facts")).toBe(1);
    expect(rows(live, "fact_versions")).toBe(1);
    expect(highestChangeSeq(live)).toBe(start);
    // The overlay holds both, with a seq above the live seqs.
    expect(rows(overlay, "facts")).toBe(2);
    expect(highestChangeSeq(overlay)).toBe(start + 1);
    closeStore(overlay);
    clearStaging(live);
    expect(countStagedChanges(live)).toBe(0);
    closeStore(live);
  });

  it("is invisible to a reader of the live wiki: search, the fact material and the live tables see no staged row", async () => {
    const live = makeStore();
    await seedChange(live, accepted([draft({ header: "Seed", content: "Seeded fact" })]), { now: T0 });
    const { overlay, target } = startBatch(live);
    const req = enqueueRequest(live, { change: "c", justification: "j" }, T0 + 1);
    const res = await applyChange(
      target,
      req,
      accepted([draft({ header: "Endermen", content: "Endermen teleport when hit" })]),
      { now: T0 + 2 },
    );
    const [staged = ""] = res.factIds;
    expect((await search(live, "Endermen teleport when hit")).map((r) => r.id)).not.toContain(staged);
    expect(getFactMaterial(live, staged)).toBeNull();
    expect(getFactMaterial(overlay, staged)).not.toBeNull();
    expect(live.db.prepare("SELECT COUNT(*) AS n FROM current_fact_versions").get()).toEqual({ n: 1 });
    expect(checkIndex(live)).toEqual([]);
    closeStore(overlay);
    closeStore(live);
  });

  it("gives two requests of one batch the live wiki only: neither sees the staged change of the other", async () => {
    const live = makeStore();
    const { overlay, target } = startBatch(live);
    const [r1, r2] = ["c1", "c2"].map((change, i) => enqueueRequest(live, { change, justification: "j" }, T0 + i)) as [
      string,
      string,
    ];
    const one = await applyChange(target, r1, accepted([draft({ header: "One", content: "First staged" })]), {
      now: T0 + 5,
    });
    const [first = ""] = one.factIds;
    // Request 2 reads through the same handle: the live wiki has no fact of request 1.
    expect(getFactMaterial(target, first)).toBeNull();
    expect(rows(target, "facts")).toBe(0);
    // Its write is refused as stale when it rests on the fact of request 1; a write of its own goes through.
    const two = await applyChange(target, r2, accepted([draft({ header: "Two", content: "Second staged" })]), {
      now: T0 + 6,
    });
    expect(two.factIds).toHaveLength(1);
    expect(rows(live, "facts")).toBe(0);
    expect(stagedFacts(overlay).map((f) => f.requestId)).toEqual([r1, r2]);
    closeStore(overlay);
    closeStore(live);
  });
});

describe("promoteStaging", () => {
  it("promotes facts, references, a duplicate and a rejection with the staged seqs, and keeps the index whole", async () => {
    const live = makeStore();
    const seed = await seedChange(live, accepted([draft({ header: "Seed", content: "Seeded fact about creepers" })]), {
      now: T0,
    });
    const [seedFact = ""] = seed.factIds;
    const [r1, r2, r3, r4] = ["c1", "c2", "c3", "c4"].map((change, i) =>
      enqueueRequest(live, { change, justification: "j" }, T0 + 1 + i),
    ) as [string, string, string, string];
    const { overlay, target, start } = startBatch(live);

    const one = await applyChange(
      target,
      r1,
      accepted([
        draft({
          header: "Zombies",
          content: "Zombies burn in sunlight",
          references: [seedFact],
        }),
      ]),
      { now: T0 + 5 },
    );
    const [zombie = ""] = one.factIds;
    await applyChange(
      target,
      r2,
      { ...accepted([]), outcome: ChangeOutcome.Duplicate, duplicateOf: seedFact },
      { now: T0 + 6 },
    );
    // A change on the overlay reads the staged fact; the request of the batch itself cannot (see the stale rule), so write on the overlay.
    await applyChange(overlay, r3, accepted([draft({ factId: zombie, header: "", content: "", isDeleted: true })]), {
      now: T0 + 7,
    });
    await applyChange(
      target,
      r4,
      { ...accepted([]), outcome: ChangeOutcome.Rejected, rejectReason: RejectReason.Unsupported },
      { now: T0 + 8 },
    );

    const liveRequests = rows(live, "change_requests");
    const count = promoteStaging(live, { startSeq: start, done: [], priorChecks: [], now: T0 + 9 });
    expect(count).toBe(4);
    expect(rows(live, "changes")).toBe(start + 4);
    expect(
      (
        live.db.prepare("SELECT outcome FROM changes WHERE seq > ? ORDER BY seq").all(start) as { outcome: string }[]
      ).map((r) => r.outcome),
    ).toEqual([ChangeOutcome.Accepted, ChangeOutcome.Duplicate, ChangeOutcome.Accepted, ChangeOutcome.Rejected]);
    expect(rows(live, "fact_version_refs")).toBe(1);
    expect(live.db.prepare("SELECT is_deleted AS d FROM current_fact_versions WHERE fact_id = ?").get(zombie)).toEqual({
      d: 1,
    });
    expect(live.db.prepare("SELECT COUNT(*) AS n FROM retrievals").get()).toEqual({ n: 1 });
    expect(checkIndex(live)).toEqual([]);
    expect(rows(live, "change_requests")).toBe(liveRequests);
    // The staging tables are empty.
    expect(countStagedChanges(live)).toBe(0);
    expect(rows(live, "stg_vectors")).toBe(0);
    closeStore(overlay);
    closeStore(live);
  });

  it("does not depend on the order of the staged writes: the content is the same, apart from the seq and id numbers", async () => {
    const sets: ChangeSet[] = [
      accepted([draft({ header: "Alpha", content: "Alpha fact" })]),
      accepted([draft({ header: "Beta", content: "Beta fact" })]),
      { ...accepted([]), outcome: ChangeOutcome.Rejected, rejectReason: RejectReason.Unsupported },
    ];
    const run = async (order: number[]): Promise<unknown> => {
      const live = makeStore();
      await seedChange(live, accepted([draft({ header: "Seed", content: "Seeded fact" })]), { now: T0 });
      const ids = sets.map((_, i) => enqueueRequest(live, { change: `c${i}`, justification: "j" }, T0 + 1 + i));
      const { overlay, target, start } = startBatch(live);
      let now = T0 + 10;
      for (const i of order) {
        await applyChange(target, ids[i] ?? "", sets[i], { now: now++ });
      }
      promoteStaging(live, { startSeq: start, done: [], priorChecks: [], now: T0 + 50 });
      const dump = {
        facts: live.db
          .prepare("SELECT header, content, is_deleted AS d FROM current_fact_versions ORDER BY header, content")
          .all(),
        outcomes: live.db
          .prepare(
            "SELECT r.change AS request, c.outcome FROM changes c JOIN change_requests r ON r.id = c.request_id ORDER BY r.change",
          )
          .all(),
        index: checkIndex(live),
      };
      closeStore(overlay);
      closeStore(live);
      return dump;
    };
    const forward = await run([0, 1, 2]);
    const backward = await run([2, 1, 0]);
    expect(backward).toEqual(forward);
  });

  it("finds a promoted fact by search, with the staged vectors and no new embedding run", async () => {
    const live = makeStore();
    const req = enqueueRequest(live, { change: "c", justification: "j" }, T0);
    takeRequest(live, req, T0 + 1);
    const { overlay, target, start } = startBatch(live);
    await applyChange(target, req, accepted([draft({ header: "Endermen", content: "Endermen teleport when hit" })]), {
      now: T0 + 2,
    });
    promoteStaging(live, { startSeq: start, done: [{ id: req }], priorChecks: [], now: T0 + 3 });
    expect((await search(live, "Endermen teleport when hit")).length).toBeGreaterThan(0);
    expect(checkIndex(live)).toEqual([]);
    expect(getRequest(live, req)?.status).toBe(RequestStatus.Done);
    closeStore(overlay);
    closeStore(live);
  });

  it("inserts the requests that only the staging set holds, and marks the done requests with the error that Q7 gave", () => {
    const live = makeStore();
    const taken = enqueueRequest(live, { change: "c", justification: "j" }, T0);
    takeRequest(live, taken, T0 + 1);
    const { overlay, start } = startBatch(live);
    const child = enqueueRequest(overlay, { change: "child", justification: "j" }, T0 + 2);
    expect(getRequest(live, child)).toBeNull();
    promoteStaging(live, {
      startSeq: start,
      done: [{ id: taken, error: "not a claim" }],
      priorChecks: [],
      now: T0 + 3,
    });
    expect(getRequest(live, child)?.status).toBe(RequestStatus.Queued);
    expect(getRequest(live, taken)).toMatchObject({ status: RequestStatus.Done, error: "not a claim" });
    closeStore(overlay);
    closeStore(live);
  });

  it("refuses when the live wiki moved, and writes nothing", async () => {
    const live = makeStore();
    const req = enqueueRequest(live, { change: "c", justification: "j" }, T0 + 1);
    const { overlay, target, start } = startBatch(live);
    await applyChange(target, req, accepted([draft({ header: "Staged", content: "Only staged" })]), { now: T0 + 2 });
    await seedChange(live, accepted([draft({ header: "Live", content: "Written next to it" })]), { now: T0 + 3 });
    const before = {
      changes: rows(live, "changes"),
      facts: rows(live, "facts"),
      requests: rows(live, "change_requests"),
    };
    expect(() => promoteStaging(live, { startSeq: start, done: [], priorChecks: [], now: T0 + 4 })).toThrow(
      LiveMovedError,
    );
    expect({
      changes: rows(live, "changes"),
      facts: rows(live, "facts"),
      requests: rows(live, "change_requests"),
    }).toEqual(before);
    closeStore(overlay);
    closeStore(live);
  });
});
