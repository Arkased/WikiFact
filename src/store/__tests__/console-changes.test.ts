import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChangeOutcome, RejectReason, RequestKind } from "../../domain/enums.js";
import {
  InvalidPageError,
  applyChange,
  closeStore,
  enqueueRequest,
  finishRequest,
  listChanges,
  seedChange,
  type Store,
} from "../index.js";
import { T0, accepted, draft, makeStore } from "../../../__tests__/helpers/store.js";

let store: Store;
beforeEach(() => {
  store = makeStore();
});
afterEach(() => closeStore(store));

interface Seeded {
  factId: string;
  anchorId: string;
  seqs: { create: number; update: number; rejected: number; repair: number };
}

// 4 changes: a tagged creation, an update, a rejection, and a lookupRepair change that deletes the fact.
async function seed(): Promise<Seeded> {
  const create = await seedChange(
    store,
    accepted([
      draft({ header: "Alpha", content: "Alpha content." }),
      draft({ header: "Anchor", content: "Anchor content." }),
    ]),
    { now: T0 },
  );
  const factId = create.factIds[0] ?? "";
  const anchorId = create.factIds[1] ?? "";
  const update = await seedChange(store, accepted([draft({ factId, header: "Alpha", content: "Alpha 2." })]), {
    now: T0 + 1,
  });
  const rejected = await seedChange(
    store,
    {
      outcome: ChangeOutcome.Rejected,
      rejectReason: RejectReason.Compound,
      summary: "two claims",
      changeReasoning: "r",
      facts: [],
    },
    { now: T0 + 2 },
  );
  const req = enqueueRequest(store, { kind: RequestKind.LookupRepair, targets: [factId] }, T0 + 3);
  const repair = await applyChange(
    store,
    req,
    accepted([{ factId, header: "", content: "", justification: "gone", references: [], isDeleted: true }]),
    { now: T0 + 4 },
  );
  finishRequest(store, req, T0 + 5);
  return {
    factId,
    anchorId,
    seqs: { create: create.seq, update: update.seq, rejected: rejected.seq, repair: repair.seq },
  };
}

const seqs = (page: ReturnType<typeof listChanges>): number[] => page.items.map((c) => c.seq);

describe("listChanges", () => {
  it("is empty on an empty wiki", () => {
    expect(listChanges(store)).toEqual({ items: [], next: null });
  });

  it("lists changes newest first with their request kind and versions", async () => {
    const s = await seed();
    const page = listChanges(store);
    expect(seqs(page)).toEqual([s.seqs.repair, s.seqs.rejected, s.seqs.update, s.seqs.create]);
    const [repair, rejected, update, create] = page.items;
    expect(create).toMatchObject({
      requestKind: RequestKind.Submission,
      outcome: ChangeOutcome.Accepted,
      rejectReason: null,
      created: T0,
      versions: [
        { factId: s.factId, header: "Alpha", isDeleted: false, isNew: true },
        { factId: s.anchorId, header: "Anchor", isDeleted: false, isNew: true },
      ],
    });
    expect(update?.versions).toEqual([{ factId: s.factId, header: "Alpha", isDeleted: false, isNew: false }]);
    expect(rejected).toMatchObject({ rejectReason: RejectReason.Compound, summary: "two claims", versions: [] });
    expect(repair).toMatchObject({ requestKind: RequestKind.LookupRepair });
    expect(repair?.versions[0]?.isDeleted).toBe(true);
  });

  it("filters by outcome, kind, fact and seq range", async () => {
    const s = await seed();
    expect(seqs(listChanges(store, { outcome: ChangeOutcome.Rejected }))).toEqual([s.seqs.rejected]);
    expect(seqs(listChanges(store, { kind: RequestKind.LookupRepair }))).toEqual([s.seqs.repair]);
    expect(seqs(listChanges(store, { factId: s.factId }))).toEqual([s.seqs.repair, s.seqs.update, s.seqs.create]);
    expect(seqs(listChanges(store, { factId: "nope" }))).toEqual([]);
    expect(seqs(listChanges(store, { fromSeq: s.seqs.update, toSeq: s.seqs.rejected }))).toEqual([
      s.seqs.rejected,
      s.seqs.update,
    ]);
    expect(seqs(listChanges(store, { fromSeq: s.seqs.repair + 1 }))).toEqual([]);
  });

  it("pages across a boundary and rejects a bad cursor", async () => {
    const s = await seed();
    const p1 = listChanges(store, { limit: 3 });
    expect(seqs(p1)).toEqual([s.seqs.repair, s.seqs.rejected, s.seqs.update]);
    const p2 = listChanges(store, { limit: 3, cursor: p1.next ?? undefined });
    expect(seqs(p2)).toEqual([s.seqs.create]);
    expect(p2.next).toBeNull();
    expect(() => listChanges(store, { cursor: "!" })).toThrow(InvalidPageError);
  });
});
