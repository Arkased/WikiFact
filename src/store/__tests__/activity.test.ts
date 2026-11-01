import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChangeOutcome, RejectReason, VersionWrite } from "../../domain/enums.js";
import { closeStore, enqueueRequest, listActivity, seedChange, type Store } from "../index.js";
import { DAY, T0, accepted, draft, makeStore } from "../../../__tests__/helpers/store.js";

let store: Store;
beforeEach(() => {
  store = makeStore();
});
afterEach(() => closeStore(store));

interface Seeded {
  factId: string;
  other: string;
  created: string;
  changed: string;
  deleted: string;
  revived: string;
  rejected: string;
  queued: string;
}

// One request per kind of write: the fact is new, then changed, deleted and revived; a second fact is new in the
// first request; one request is rejected and one is still queued.
async function seed(): Promise<Seeded> {
  const created = await seedChange(
    store,
    accepted([draft({ header: "Alpha", content: "Alpha 1." }), draft({ header: "Beta" })]),
    { now: T0 },
  );
  const [factId = "", other = ""] = created.factIds;
  const next = (n: number, over: Partial<ReturnType<typeof draft>>): Promise<{ requestId: string }> =>
    seedChange(store, accepted([draft({ factId, header: "Alpha", ...over })]), {
      now: T0 + n * DAY,
    });
  const changed = await next(1, { content: "Alpha 2." });
  const deleted = await next(2, { isDeleted: true });
  const revived = await next(3, { content: "Alpha 3." });
  const rejected = await seedChange(
    store,
    {
      outcome: ChangeOutcome.Rejected,
      rejectReason: RejectReason.Unsupported,
      summary: "no support",
      changeReasoning: "r",
      facts: [],
    },
    { now: T0 + 4 * DAY },
  );
  const queued = enqueueRequest(store, { change: "Later", justification: "j" }, T0 + 5 * DAY);
  return {
    factId,
    other,
    created: created.requestId,
    changed: changed.requestId,
    deleted: deleted.requestId,
    revived: revived.requestId,
    rejected: rejected.requestId,
    queued,
  };
}

describe("listActivity", () => {
  it("is empty on an empty wiki", () => {
    expect(listActivity(store)).toEqual({ items: [], next: null });
  });

  it("says per request what its changes wrote, with the 4 kinds of write", async () => {
    const s = await seed();
    const items = listActivity(store).items;
    const wrote = (id: string) => items.find((i) => i.id === id)?.wrote;
    expect(wrote(s.created)).toEqual([
      { factId: s.factId, header: "Alpha", kind: VersionWrite.New },
      { factId: s.other, header: "Beta", kind: VersionWrite.New },
    ]);
    expect(wrote(s.changed)).toEqual([{ factId: s.factId, header: "Alpha", kind: VersionWrite.Changed }]);
    expect(wrote(s.deleted)).toEqual([{ factId: s.factId, header: "Alpha", kind: VersionWrite.Deleted }]);
    expect(wrote(s.revived)).toEqual([{ factId: s.factId, header: "Alpha", kind: VersionWrite.Revived }]);
    expect(wrote(s.rejected)).toEqual([]);
    expect(wrote(s.queued)).toEqual([]);
  });

  it("keeps the rows, filters and order of listRequests", async () => {
    const s = await seed();
    expect(listActivity(store).items.map((i) => i.id)).toEqual([
      s.queued,
      s.rejected,
      s.revived,
      s.deleted,
      s.changed,
      s.created,
    ]);
    const filtered = listActivity(store, { outcome: ChangeOutcome.Rejected });
    expect(filtered.items.map((i) => i.id)).toEqual([s.rejected]);
    expect(filtered.items[0]).toMatchObject({
      outcome: ChangeOutcome.Rejected,
      rejectReason: RejectReason.Unsupported,
    });
  });

  it("pages with a cursor and reads the writes of each page", async () => {
    const s = await seed();
    const first = listActivity(store, { limit: 4 });
    expect(first.items.map((i) => i.id)).toEqual([s.queued, s.rejected, s.revived, s.deleted]);
    expect(first.items[2]?.wrote[0]?.kind).toBe(VersionWrite.Revived);
    expect(first.next).not.toBeNull();
    const second = listActivity(store, { limit: 4, ...(first.next === null ? {} : { cursor: first.next }) });
    expect(second.items.map((i) => i.id)).toEqual([s.changed, s.created]);
    expect(second.items[1]?.wrote).toHaveLength(2);
    expect(second.next).toBeNull();
  });
});
