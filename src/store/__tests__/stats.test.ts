import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChangeOutcome, RejectReason, RequestKind, RetrievalKind } from "../../domain/enums.js";
import {
  applyChangeSync,
  closeStore,
  countFacts,
  countLiveFacts,
  countQueued,
  countRetrievals,
  countVersions,
  enqueueRequest,
  finishRequest,
  firstSeqOfFacts,
  getChangeForRequest,
  listCurrentFacts,
  listRequestIds,
  listRequestIdsWithOutcome,
  queueStats,
  recordRetrieval,
  takeNextRequest,
  type Store,
} from "../index.js";
import { DAY, T0, accepted, draft, makeStore, write } from "../../../__tests__/helpers/store.js";

let store: Store;
beforeEach(() => {
  store = makeStore();
});
afterEach(() => closeStore(store));

// Writes a fact with one version and returns its id.
function oneFact(header: string, now: number): string {
  const res = write(store, accepted([draft({ header })]), now);
  const id = res.factIds[0];
  if (id === undefined) throw new Error("no fact id");
  return id;
}

describe("countRetrievals", () => {
  it("filters by time, kind and fact, and counts every version of a fact", () => {
    const a = oneFact("A", T0);
    const b = oneFact("B", T0);
    recordRetrieval(store, a, { now: T0 + 1 });
    recordRetrieval(store, a, { now: T0 + 3 * DAY });
    recordRetrieval(store, a, { now: T0 + 3 * DAY, kind: RetrievalKind.Confirm });
    recordRetrieval(store, b, { now: T0 + 3 * DAY });
    expect(countRetrievals(store)).toBe(4);
    expect(countRetrievals(store, { since: T0 + DAY })).toBe(3);
    expect(countRetrievals(store, { since: T0 + DAY, kind: RetrievalKind.Read })).toBe(2);
    expect(countRetrievals(store, { kind: RetrievalKind.Confirm })).toBe(1);
    expect(countRetrievals(store, { factIds: [a] })).toBe(3);
    expect(countRetrievals(store, { factIds: [a, b], kind: RetrievalKind.Read })).toBe(3);
    expect(countRetrievals(store, { factIds: [b], since: T0 + 4 * DAY })).toBe(0);
    expect(countRetrievals(store, { factIds: [] })).toBe(0);
    // A new version of `a` keeps the rows of the old one in the count.
    const req = enqueueRequest(store, { change: "c", justification: "j" }, T0 + 5 * DAY);
    applyChangeSync(store, req, accepted([draft({ factId: a, header: "A" })]), { now: T0 + 5 * DAY });
    recordRetrieval(store, a, { now: T0 + 6 * DAY });
    expect(countRetrievals(store, { factIds: [a] })).toBe(4);
  });
});

describe("countVersions", () => {
  it("counts the versions of a fact and gives 0 for an unknown id", () => {
    const a = oneFact("A", T0);
    expect(countVersions(store, a)).toBe(1);
    const req = enqueueRequest(store, { change: "c", justification: "j" }, T0 + 1);
    applyChangeSync(store, req, accepted([draft({ factId: a, header: "A" })]), { now: T0 + 1 });
    expect(countVersions(store, a)).toBe(2);
    expect(countVersions(store, "nope")).toBe(0);
  });
});

describe("listRequestIds and listRequestIdsWithOutcome", () => {
  it("lists the ids of a kind oldest first, and those with a change of the outcome", () => {
    const fact = oneFact("A", T0 + 10);
    const first = enqueueRequest(store, { change: "c1", justification: "j" }, T0 + 20);
    const lookup = enqueueRequest(store, { kind: RequestKind.LookupRepair, targets: [fact] }, T0 + 30);
    const second = enqueueRequest(store, { change: "c2", justification: "j" }, T0 + 15);
    applyChangeSync(store, first, accepted([]), { now: T0 + 40 });
    applyChangeSync(store, lookup, accepted([]), { now: T0 + 41 });
    const duplicate = { ...accepted([]), outcome: ChangeOutcome.Duplicate, duplicateOf: fact };
    applyChangeSync(store, second, duplicate, { now: T0 + 42 });
    const seed = listRequestIds(store, RequestKind.Submission)[0];
    expect(listRequestIds(store, RequestKind.Submission)).toEqual([seed, second, first]);
    expect(listRequestIds(store, RequestKind.LookupRepair)).toEqual([lookup]);
    expect(listRequestIdsWithOutcome(store, RequestKind.Submission, ChangeOutcome.Accepted)).toEqual([seed, first]);
    expect(listRequestIdsWithOutcome(store, RequestKind.Submission, ChangeOutcome.Duplicate)).toEqual([second]);
    expect(listRequestIdsWithOutcome(store, RequestKind.LookupRepair, ChangeOutcome.Accepted)).toEqual([lookup]);
    expect(listRequestIdsWithOutcome(store, RequestKind.Submission, ChangeOutcome.Rejected)).toEqual([]);
  });
});

describe("getChangeForRequest", () => {
  it("returns the outcome and time of the change of a request, and null for a request without one", () => {
    const waiting = enqueueRequest(store, { change: "c1", justification: "j" }, T0);
    const duplicated = enqueueRequest(store, { change: "c2", justification: "j" }, T0 + 1);
    const fact = oneFact("A", T0 + 2);
    applyChangeSync(
      store,
      duplicated,
      { ...accepted([]), outcome: ChangeOutcome.Duplicate, duplicateOf: fact },
      { now: T0 + 3 },
    );
    expect(getChangeForRequest(store, duplicated)).toEqual({
      outcome: ChangeOutcome.Duplicate,
      createdAt: T0 + 3,
      duplicateOf: fact,
      factIds: [],
      childIds: [],
    });
    expect(getChangeForRequest(store, waiting)).toBeNull();
    expect(getChangeForRequest(store, "01NOPE")).toBeNull();
  });

  it("names the facts that an accepted change wrote, and reads the last change of a request", () => {
    const req = enqueueRequest(store, { change: "c", justification: "j" }, T0);
    const merged = applyChangeSync(store, req, accepted([draft({ header: "M" })]), { now: T0 + 1 });
    const final = applyChangeSync(store, req, accepted([draft({ header: "A" }), draft({ header: "B" })]), {
      now: T0 + 2,
    });
    const change = getChangeForRequest(store, req);
    expect(change?.factIds).toEqual(final.factIds);
    expect(change?.factIds).toHaveLength(2);
    expect(change?.factIds).not.toContain(merged.factIds[0]);
    expect(change?.duplicateOf).toBeUndefined();
  });

  it("names the reason of a rejection, and none for another outcome", () => {
    const rejected = enqueueRequest(store, { change: "c1", justification: "j" }, T0);
    const fine = enqueueRequest(store, { change: "c2", justification: "j" }, T0 + 1);
    applyChangeSync(
      store,
      rejected,
      { ...accepted([]), outcome: ChangeOutcome.Rejected, rejectReason: RejectReason.Contradicted },
      { now: T0 + 2 },
    );
    applyChangeSync(store, fine, accepted([draft({ header: "A" })]), { now: T0 + 3 });
    expect(getChangeForRequest(store, rejected)?.rejectReason).toBe(RejectReason.Contradicted);
    expect(getChangeForRequest(store, fine)?.rejectReason).toBeUndefined();
  });
});

describe("firstSeqOfFacts", () => {
  it("gives the seq of the first version of each fact, whatever its later versions", () => {
    const a = oneFact("A", T0);
    const first = write(store, accepted([draft({ header: "B" })]), T0 + 1);
    const req = enqueueRequest(store, { change: "c", justification: "j" }, T0 + 2);
    const second = applyChangeSync(store, req, accepted([draft({ factId: a, header: "A2" })]), { now: T0 + 2 });
    const firstSeqs = firstSeqOfFacts(store);
    expect(firstSeqs.get(first.factIds[0] ?? "")).toBe(first.seq);
    expect(firstSeqs.get(a)).toBeLessThan(second.seq);
    expect(firstSeqs.size).toBe(2);
  });
});

describe("queueStats", () => {
  it("counts the queued requests and gives no mean while no request is done", () => {
    expect(queueStats(store)).toEqual({ queued: 0 });
    enqueueRequest(store, { change: "c1", justification: "j" }, T0);
    enqueueRequest(store, { change: "c2", justification: "j" }, T0 + 1);
    expect(queueStats(store)).toEqual({ queued: 2, oldestQueuedAt: T0 });
  });

  it("gives the receive time of the oldest queued request, and none once the queue is empty", () => {
    const first = enqueueRequest(store, { change: "c1", justification: "j" }, T0);
    enqueueRequest(store, { change: "c2", justification: "j" }, T0 + DAY);
    expect(queueStats(store).oldestQueuedAt).toBe(T0);
    // The head is taken: the next queued row is the oldest; a running row does not count.
    expect(takeNextRequest(store, T0 + 2 * DAY)?.id).toBe(first);
    expect(queueStats(store)).toMatchObject({ queued: 1, oldestQueuedAt: T0 + DAY });
    finishRequest(store, first, T0 + 2 * DAY + 1);
    takeNextRequest(store, T0 + 3 * DAY);
    expect(queueStats(store)).not.toHaveProperty("oldestQueuedAt");
  });

  it("averages finished_at - started_at over the last 10 done requests", () => {
    // 3 old requests of 100 s, then 10 recent ones of 10 s: only the recent 10 count.
    for (let i = 0; i < 13; i++) {
      const id = enqueueRequest(store, { change: `c${i}`, justification: "j" }, T0 + i);
      const duration = i < 3 ? 100_000 : 10_000;
      expect(takeNextRequest(store, T0 + i * DAY)?.id).toBe(id);
      finishRequest(store, id, T0 + i * DAY + duration);
    }
    expect(queueStats(store)).toEqual({ queued: 0, meanDurationMs: 10_000 });
    enqueueRequest(store, { change: "waiting", justification: "j" }, T0 + 20 * DAY);
    expect(queueStats(store)).toMatchObject({ queued: 1, oldestQueuedAt: T0 + 20 * DAY });
  });
});

describe("countLiveFacts", () => {
  it("leaves out a fact whose current version is a deletion, which countFacts keeps", () => {
    expect(countLiveFacts(store)).toBe(0);
    const a = oneFact("A", T0);
    oneFact("B", T0 + 1);
    expect(countLiveFacts(store)).toBe(2);
    const req = enqueueRequest(store, { change: "c", justification: "j" }, T0 + 2);
    applyChangeSync(
      store,
      req,
      accepted([draft({ factId: a, header: "A", isDeleted: true, justification: "Gone." })]),
      {
        now: T0 + 2,
      },
    );
    expect(countFacts(store)).toBe(2);
    expect(countLiveFacts(store)).toBe(1);
  });
});

describe("countQueued", () => {
  it("counts the queued requests, not the running ones", () => {
    expect(countQueued(store)).toBe(0);
    enqueueRequest(store, { change: "c1", justification: "j" }, T0);
    enqueueRequest(store, { change: "c2", justification: "j" }, T0 + 1);
    expect(countQueued(store)).toBe(2);
    expect(takeNextRequest(store)).not.toBeNull();
    expect(countQueued(store)).toBe(1);
  });
});

describe("countFacts and listCurrentFacts", () => {
  it("counts facts and lists the current version of each fact", () => {
    expect(countFacts(store)).toBe(0);
    expect(listCurrentFacts(store)).toEqual([]);
    const a = oneFact("A", T0);
    write(store, accepted([draft({ header: "B" })]), T0 + 1);
    expect(countFacts(store)).toBe(2);
    const req = enqueueRequest(store, { change: "c", justification: "j" }, T0 + 2);
    applyChangeSync(store, req, accepted([draft({ factId: a, header: "A2", content: "New." })]), { now: T0 + 2 });
    const rows = listCurrentFacts(store);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.fact_id === a)).toMatchObject({ header: "A2", content: "New.", is_deleted: 0 });
    expect(countFacts(store)).toBe(2);
  });
});
