import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChangeOutcome, RejectReason, RequestKind, RequestListSort, RequestStatus } from "../../domain/enums.js";
import {
  InvalidPageError,
  applyChange,
  closeStore,
  enqueueRequest,
  failAttempt,
  finishRequest,
  getRequestDetail,
  listRequests,
  seedChange,
  takeNextRequest,
  versionsOfChange,
  type Store,
} from "../index.js";
import { DAY, T0, accepted, draft, makeStore } from "../../../__tests__/helpers/store.js";

let store: Store;
beforeEach(() => {
  store = makeStore();
});
afterEach(() => closeStore(store));

interface Seeded {
  factId: string;
  accepted: string;
  update: string;
  rejected: string;
  duplicate: string;
  failed: string;
  queued: string;
  repair: string;
}

// One request per status and outcome. The update ran through the worker path, so it has a duration.
async function seed(): Promise<Seeded> {
  const a = await seedChange(store, accepted([draft({ header: "Alpha", content: "Alpha content." })]), {
    now: T0,
    change: "Alpha is so",
    justification: "I saw alpha",
  });
  const factId = a.factIds[0] ?? "";
  const update = enqueueRequest(store, { change: "Alpha is different", justification: "I checked" }, T0 + DAY);
  takeNextRequest(store, T0 + DAY + 1000);
  await applyChange(store, update, accepted([draft({ factId, header: "Alpha", content: "Alpha 2." })]), {
    now: T0 + DAY + 4000,
  });
  finishRequest(store, update, T0 + DAY + 5000);
  const rejected = await seedChange(
    store,
    {
      outcome: ChangeOutcome.Rejected,
      rejectReason: RejectReason.Unsupported,
      summary: "no support",
      changeReasoning: "r",
      facts: [],
    },
    { now: T0 + 2 * DAY, change: "Beta is so", justification: "I believe" },
  );
  const duplicate = await seedChange(
    store,
    {
      outcome: ChangeOutcome.Duplicate,
      duplicateOf: factId,
      summary: "same",
      changeReasoning: "r",
      facts: [],
    },
    { now: T0 + 3 * DAY, change: "Alpha is so, again", justification: "I saw it too" },
  );
  const failed = enqueueRequest(store, { change: "Gamma is so", justification: "j" }, T0 + 4 * DAY);
  for (let i = 0; i < 3; i++) failAttempt(store, failed, "boom", T0 + 4 * DAY + i);
  const queued = enqueueRequest(store, { change: "Delta is so", justification: "j" }, T0 + 5 * DAY);
  const repair = enqueueRequest(store, { kind: RequestKind.LookupRepair, targets: [factId] }, T0 + 6 * DAY);
  return {
    factId,
    accepted: a.requestId,
    update,
    rejected: rejected.requestId,
    duplicate: duplicate.requestId,
    failed,
    queued,
    repair,
  };
}

const ids = (page: ReturnType<typeof listRequests>): string[] => page.items.map((r) => r.id);

describe("listRequests", () => {
  it("is empty on an empty wiki", () => {
    expect(listRequests(store)).toEqual({ items: [], next: null });
  });

  it("joins each request with its last change, latest received first", async () => {
    const s = await seed();
    const page = listRequests(store);
    expect(ids(page)).toEqual([s.repair, s.queued, s.failed, s.duplicate, s.rejected, s.update, s.accepted]);
    const byId = new Map(page.items.map((r) => [r.id, r]));
    expect(byId.get(s.accepted)).toMatchObject({
      status: RequestStatus.Done,
      outcome: ChangeOutcome.Accepted,
      factIds: [s.factId],
      durationMs: null,
      change: "Alpha is so",
    });
    expect(byId.get(s.update)).toMatchObject({ durationMs: 4000, startedAt: T0 + DAY + 1000, factIds: [s.factId] });
    expect(byId.get(s.rejected)).toMatchObject({
      outcome: ChangeOutcome.Rejected,
      rejectReason: RejectReason.Unsupported,
    });
    expect(byId.get(s.duplicate)).toMatchObject({
      outcome: ChangeOutcome.Duplicate,
      duplicateOf: s.factId,
      factIds: [],
    });
    expect(byId.get(s.failed)).toMatchObject({
      status: RequestStatus.Failed,
      outcome: null,
      error: "boom",
      attempts: 3,
    });
    expect(byId.get(s.queued)).toMatchObject({ status: RequestStatus.Queued, outcome: null, factIds: [] });
    expect(byId.get(s.repair)).toMatchObject({ kind: RequestKind.LookupRepair, targets: [s.factId], change: null });
  });

  it("filters by status, kind, outcome, reject reason, fact, since and text", async () => {
    const s = await seed();
    expect(ids(listRequests(store, { status: RequestStatus.Failed }))).toEqual([s.failed]);
    expect(ids(listRequests(store, { kind: RequestKind.LookupRepair }))).toEqual([s.repair]);
    expect(ids(listRequests(store, { outcome: ChangeOutcome.Accepted }))).toEqual([s.update, s.accepted]);
    expect(ids(listRequests(store, { rejectReason: RejectReason.Unsupported }))).toEqual([s.rejected]);
    expect(ids(listRequests(store, { rejectReason: RejectReason.Compound }))).toEqual([]);
    expect(ids(listRequests(store, { factId: s.factId }))).toEqual([s.update, s.accepted]);
    expect(ids(listRequests(store, { since: T0 + 4 * DAY }))).toEqual([s.repair, s.queued, s.failed]);
    expect(ids(listRequests(store, { text: "alpha" }))).toEqual([s.duplicate, s.update, s.accepted]);
    expect(ids(listRequests(store, { text: "I BELIEVE" }))).toEqual([s.rejected]);
    expect(ids(listRequests(store, { text: "%" }))).toEqual([]);
    expect(ids(listRequests(store, { status: RequestStatus.Done, text: "alpha" }))).toEqual([
      s.duplicate,
      s.update,
      s.accepted,
    ]);
  });

  it("sorts by finish time and by duration with the rows that lack them last", async () => {
    const s = await seed();
    const finished = ids(listRequests(store, { sort: RequestListSort.Finished }));
    expect(finished.slice(0, 5)).toEqual([s.failed, s.duplicate, s.rejected, s.update, s.accepted]);
    expect(new Set(finished.slice(5))).toEqual(new Set([s.queued, s.repair]));
    const duration = ids(listRequests(store, { sort: RequestListSort.Duration }));
    expect(duration[0]).toBe(s.update);
    expect(duration).toHaveLength(7);
  });

  it("pages across a boundary and rejects a bad limit", async () => {
    const s = await seed();
    const p1 = listRequests(store, { limit: 3 });
    expect(ids(p1)).toEqual([s.repair, s.queued, s.failed]);
    const p2 = listRequests(store, { limit: 3, cursor: p1.next ?? undefined });
    expect(ids(p2)).toEqual([s.duplicate, s.rejected, s.update]);
    const p3 = listRequests(store, { limit: 3, cursor: p2.next ?? undefined });
    expect(ids(p3)).toEqual([s.accepted]);
    expect(p3.next).toBeNull();
    expect(() => listRequests(store, { limit: 201 })).toThrow(InvalidPageError);
  });
});

describe("getRequestDetail", () => {
  it("is null for an unknown id", () => {
    expect(getRequestDetail(store, "nope")).toBeNull();
  });

  it("gives the row and every change with its versions and the version before each", async () => {
    const s = await seed();
    const d = getRequestDetail(store, s.update);
    expect(d?.request).toMatchObject({ id: s.update, status: RequestStatus.Done, startedAt: T0 + DAY + 1000 });
    expect(d?.changes).toHaveLength(1);
    const c = d?.changes[0];
    expect(c).toMatchObject({ outcome: ChangeOutcome.Accepted, duplicateOf: null, summary: "test change" });
    expect(c?.versions).toHaveLength(1);
    expect(c?.versions[0]?.factId).toBe(s.factId);
    expect(c?.versions[0]?.version.content).toBe("Alpha 2.");
    expect(c?.versions[0]?.previous?.content).toBe("Alpha content.");

    const first = getRequestDetail(store, s.accepted);
    expect(first?.changes[0]?.versions[0]?.previous).toBeNull();
    const dup = getRequestDetail(store, s.duplicate);
    expect(dup?.changes[0]?.duplicateOf).toEqual({ id: s.factId, header: "Alpha" });
    expect(dup?.changes[0]?.versions).toEqual([]);
    expect(getRequestDetail(store, s.queued)?.changes).toEqual([]);
    expect(getRequestDetail(store, s.failed)?.request.error).toBe("boom");
  });

  it("lists the changes of one request oldest first", async () => {
    const first = await seedChange(store, accepted([draft({ header: "A", content: "A." })]), { now: T0 });
    const factId = first.factIds[0] ?? "";
    // A merge and the request's own change under one request.
    const req = enqueueRequest(store, { change: "c", justification: "j" }, T0 + 1);
    const merge = await applyChange(store, req, accepted([draft({ factId, header: "A", content: "A merged." })]), {
      now: T0 + 2,
    });
    const own = await applyChange(store, req, accepted([draft({ header: "B", content: "B." })]), { now: T0 + 3 });
    finishRequest(store, req, T0 + 4);
    const d = getRequestDetail(store, req);
    expect(d?.changes.map((c) => c.seq)).toEqual([merge.seq, own.seq]);
    expect(versionsOfChange(store, own.seq)[0]?.version.header).toBe("B");
  });

  it("labels the references of a version: a header for a live fact and the last header for a deleted one", async () => {
    const live =
      (await seedChange(store, accepted([draft({ header: "Live base", content: "L." })]), { now: T0 })).factIds[0] ??
      "";
    const gone =
      (await seedChange(store, accepted([draft({ header: "Gone base", content: "G." })]), { now: T0 + 1 }))
        .factIds[0] ?? "";
    await seedChange(
      store,
      accepted([{ factId: gone, header: "", content: "", justification: "gone", references: [], isDeleted: true }]),
      { now: T0 + 2 },
    );
    const written = await seedChange(
      store,
      accepted([draft({ header: "Dependent", content: "D.", references: [live, gone] })]),
      { now: T0 + 3 },
    );
    const seq = getRequestDetail(store, written.requestId)?.changes[0]?.seq ?? 0;
    const labels = versionsOfChange(store, seq)[0]?.referenceLabels;
    expect(labels).toEqual({
      [live]: { id: live, header: "Live base", isDeleted: false },
      [gone]: { id: gone, header: "Gone base", isDeleted: true },
    });
    expect(getRequestDetail(store, written.requestId)?.changes[0]?.versions[0]?.referenceLabels).toEqual(labels);
  });
});
