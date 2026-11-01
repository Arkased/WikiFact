import { describe, expect, it } from "vitest";
import { BatchReconciliation, RequestStatus } from "../../domain/enums.js";
import { T0, accepted, draft, makeStore } from "../../../__tests__/helpers/store.js";
import {
  StaleChangeError,
  applyChange,
  clearBatchStartSeq,
  enqueueRequest,
  factsChangedSince,
  getRequest,
  highestChangeSeq,
  olderFirst,
  readBatchProgress,
  readBatchStartSeq,
  seedChange,
  stagedFacts,
  takeRequest,
  writeBatchProgress,
  writeBatchStartSeq,
} from "../index.js";

describe("the start seq of a batch", () => {
  it("is absent, written, replaced by a second write and deleted by clear", () => {
    const store = makeStore();
    expect(readBatchStartSeq(store)).toBeUndefined();
    writeBatchStartSeq(store, 7);
    expect(readBatchStartSeq(store)).toBe(7);
    writeBatchStartSeq(store, 9);
    expect(readBatchStartSeq(store)).toBe(9);
    clearBatchStartSeq(store);
    expect(readBatchStartSeq(store)).toBeUndefined();
  });
});

describe("factsChangedSince", () => {
  it("lists the facts with a live version above the seq", async () => {
    const store = makeStore();
    const a = await seedChange(store, accepted([draft({ header: "A", content: "a" })]), { now: T0 });
    const b = await seedChange(store, accepted([draft({ header: "B", content: "b" })]), { now: T0 + 1 });
    const [idA = ""] = a.factIds;
    const [idB = ""] = b.factIds;
    const at = highestChangeSeq(store);
    expect(factsChangedSince(store, { afterSeq: at, factIds: [idA, idB] }, "r")).toEqual([]);
    await seedChange(store, accepted([draft({ factId: idA, header: "A", content: "a2" })]), { now: T0 + 2 });
    expect(factsChangedSince(store, { afterSeq: at, factIds: [idA, idB] }, "r")).toEqual([idA]);
    expect(factsChangedSince(store, { afterSeq: at, factIds: [idB] }, "r")).toEqual([]);
  });
});

describe("stagedFacts", () => {
  it("is empty without a staging set, and olderFirst orders a pair of live facts by age", async () => {
    const store = makeStore();
    const a = await seedChange(store, accepted([draft({ header: "A", content: "a" })]), { now: T0 });
    const b = await seedChange(store, accepted([draft({ header: "B", content: "b" })]), { now: T0 + 1 });
    const [idA = ""] = a.factIds;
    const [idB = ""] = b.factIds;
    expect(stagedFacts(store)).toEqual([]);
    expect(olderFirst(store, idB, idA)).toEqual([idA, idB]);
  });
});

// The stale check of references: the write is refused inside the transaction, and nothing is written.
describe("the stale check of references", () => {
  const rows = (store: ReturnType<typeof makeStore>, table: string): number =>
    (store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

  it("refuses a draft that references a fact that another request deleted", async () => {
    const store = makeStore();
    const target = await seedChange(store, accepted([draft({ header: "T", content: "t" })]), { now: T0 });
    const [idT = ""] = target.factIds;
    const at = highestChangeSeq(store);
    await seedChange(store, accepted([draft({ factId: idT, header: "", content: "", isDeleted: true })]), {
      now: T0 + 1,
    });
    const req = enqueueRequest(store, { change: "c", justification: "j" }, T0 + 2);
    const before = rows(store, "fact_versions");
    // Stale by the version after the gather, and also when the gather came after the deletion.
    for (const afterSeq of [at, highestChangeSeq(store)]) {
      const err = await applyChange(store, req, accepted([draft({ header: "D", content: "d", references: [idT] })]), {
        now: T0 + 3,
        fresh: { afterSeq, factIds: [] },
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(StaleChangeError);
      expect((err as StaleChangeError).factIds).toEqual([idT]);
    }
    expect(rows(store, "fact_versions")).toBe(before);
  });

  it("writes a draft whose references are unchanged since the gather", async () => {
    const store = makeStore();
    const target = await seedChange(store, accepted([draft({ header: "T", content: "t" })]), {
      now: T0,
    });
    const [idT = ""] = target.factIds;
    const at = highestChangeSeq(store);
    const req = enqueueRequest(store, { change: "c", justification: "j" }, T0 + 1);
    const res = await applyChange(store, req, accepted([draft({ header: "D", content: "d", references: [idT] })]), {
      now: T0 + 2,
      fresh: { afterSeq: at, factIds: [] },
    });
    expect(res.factIds).toHaveLength(1);
  });
});

describe("the progress of a batch", () => {
  it("is absent, written, replaced and read back", () => {
    const store = makeStore();
    expect(readBatchProgress(store)).toBeUndefined();
    writeBatchProgress(store, { taken: 3, done: 1, staged: 1, stale: 0, reconciliation: BatchReconciliation.Pending });
    writeBatchProgress(store, { taken: 3, done: 3, staged: 4, stale: 1, reconciliation: BatchReconciliation.Done });
    expect(readBatchProgress(store)).toEqual({
      taken: 3,
      done: 3,
      staged: 4,
      stale: 1,
      reconciliation: BatchReconciliation.Done,
    });
  });
});

describe("takeRequest", () => {
  it("takes the named queued row to running, and returns null for a row that is not queued", () => {
    const store = makeStore();
    const id = enqueueRequest(store, { change: "c", justification: "j" }, 1);
    expect(takeRequest(store, id, 5)?.status).toBe(RequestStatus.Running);
    expect(getRequest(store, id)?.status).toBe(RequestStatus.Running);
    expect(takeRequest(store, id, 6)).toBeNull();
    expect(takeRequest(store, "nope", 6)).toBeNull();
  });
});
