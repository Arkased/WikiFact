import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChangeOutcome, DeletedFilter, FactListSort, RetrievalKind } from "../../domain/enums.js";
import {
  InvalidPageError,
  closeStore,
  exportFacts,
  getFactDetail,
  listFacts,
  recordRetrieval,
  seedChange,
  type Store,
} from "../index.js";
import { DAY, T0, accepted, draft, makeStore } from "../../../__tests__/helpers/store.js";

let store: Store;
beforeEach(() => {
  store = makeStore();
});
afterEach(() => closeStore(store));

const NOW = T0 + 10 * DAY;

// Alpha (tagged, read), Beta (untagged, unread), Gamma (deleted). Returns the ids and the seq of the deletion.
async function seedThree(): Promise<{ alpha: string; beta: string; gamma: string; deleteSeq: number }> {
  const a = await seedChange(store, accepted([draft({ header: "Alpha", content: "Alpha content." })]), { now: T0 });
  const b = await seedChange(store, accepted([draft({ header: "Beta", content: "Beta content." })]), {
    now: T0 + DAY,
  });
  const c = await seedChange(store, accepted([draft({ header: "Gamma", content: "Gamma content." })]), {
    now: T0 + 2 * DAY,
  });
  const alpha = a.factIds[0] ?? "";
  const beta = b.factIds[0] ?? "";
  const gamma = c.factIds[0] ?? "";
  const del = await seedChange(
    store,
    accepted([{ factId: gamma, header: "", content: "", justification: "gone", references: [], isDeleted: true }]),
    { now: T0 + 3 * DAY },
  );
  recordRetrieval(store, alpha, { now: T0 + 4 * DAY });
  return { alpha, beta, gamma, deleteSeq: del.seq };
}

describe("exportFacts", () => {
  it("is empty on an empty wiki", () => {
    expect(exportFacts(store, NOW, true)).toEqual([]);
  });

  it("reads every fact in one call, headers A to Z, with scores; the deleted ones on request", async () => {
    const { alpha, gamma } = await seedThree();
    const live = exportFacts(store, NOW, false);
    expect(live.map((f) => f.header)).toEqual(["Alpha", "Beta"]);
    expect(live[0]).toMatchObject({ id: alpha, versions: 1, isDeleted: false });
    expect(live[0]?.confidence).toBeGreaterThan(0);
    const all = exportFacts(store, NOW, true);
    expect(all.map((f) => f.header)).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(all[2]).toMatchObject({ id: gamma, isDeleted: true, confidence: 0, versions: 2 });
    // The same facts as the paged list gives, in the same order.
    const paged = listFacts(store, { now: NOW, deleted: DeletedFilter.All, sort: FactListSort.Header });
    expect(all).toEqual(paged.items);
  });
});

describe("listFacts", () => {
  it("is empty on an empty wiki", () => {
    expect(listFacts(store, { now: NOW })).toEqual({ items: [], next: null, total: 0 });
  });

  it("counts every fact that matches the filters, not only the page", async () => {
    const { alpha, beta } = await seedThree();
    const first = listFacts(store, { now: NOW, limit: 1, sort: FactListSort.Header });
    expect(first.items).toHaveLength(1);
    expect(first.total).toBe(2);
    expect(listFacts(store, { now: NOW, deleted: DeletedFilter.All, limit: 1 }).total).toBe(3);
    const conf = new Map(listFacts(store, { now: NOW }).items.map((f) => [f.id, f.confidence]));
    const higher = Math.max(conf.get(alpha) ?? 0, conf.get(beta) ?? 0);
    expect(listFacts(store, { now: NOW, minConfidence: higher, limit: 1 }).total).toBe(1);
  });

  it("lists live facts newest first by default, with scores and version counts", async () => {
    const { alpha, beta } = await seedThree();
    const page = listFacts(store, { now: NOW });
    expect(page.items.map((f) => f.id)).toEqual([beta, alpha]);
    expect(page.next).toBeNull();
    const a = page.items[1];
    expect(a?.versions).toBe(1);
    expect(a?.created).toBe(T0);
    expect(a?.isDeleted).toBe(false);
    expect(a?.usefulness).toBeGreaterThan(0);
    expect(page.items[0]?.usefulness).toBe(0);
    expect(a?.confidence).toBeGreaterThan(0);
  });

  it("filters by deleted state, unread and changedSince", async () => {
    const { beta, gamma, deleteSeq } = await seedThree();
    const ids = (o: Parameters<typeof listFacts>[1]): string[] => listFacts(store, o).items.map((f) => f.id);
    expect(ids({ now: NOW, deleted: DeletedFilter.Deleted })).toEqual([gamma]);
    expect(ids({ now: NOW, deleted: DeletedFilter.All })).toHaveLength(3);
    expect(listFacts(store, { now: NOW, deleted: DeletedFilter.Deleted }).items[0]).toMatchObject({
      isDeleted: true,
      confidence: 0,
      versions: 2,
      lastChangedSeq: deleteSeq,
    });
    expect(ids({ now: NOW, unread: true })).toEqual([beta]);
    expect(ids({ now: NOW, changedSince: 1, deleted: DeletedFilter.All })).toEqual([gamma, beta]);
    expect(ids({ now: NOW, changedSince: deleteSeq })).toEqual([]);
  });

  it("filters by a confidence range", async () => {
    const { alpha, beta } = await seedThree();
    const all = listFacts(store, { now: NOW });
    const conf = new Map(all.items.map((f) => [f.id, f.confidence]));
    const a = conf.get(alpha) ?? 0;
    const b = conf.get(beta) ?? 0;
    expect(a).not.toBe(b);
    const lower = Math.min(a, b);
    const higher = Math.max(a, b);
    const ids = (o: Parameters<typeof listFacts>[1]): string[] => listFacts(store, o).items.map((f) => f.id);
    expect(ids({ now: NOW, minConfidence: higher })).toEqual([a > b ? alpha : beta]);
    expect(ids({ now: NOW, maxConfidence: lower })).toEqual([a > b ? beta : alpha]);
    expect(ids({ now: NOW, minConfidence: higher + 0.01 })).toEqual([]);
  });

  it("sorts by every column", async () => {
    const { alpha, beta } = await seedThree();
    await seedChange(store, accepted([draft({ factId: beta, header: "Beta", content: "Beta again." })]), {
      now: T0 + 5 * DAY,
    });
    const ids = (sort: FactListSort): string[] => listFacts(store, { now: NOW, sort }).items.map((f) => f.id);
    expect(ids(FactListSort.Header)).toEqual([alpha, beta]);
    expect(ids(FactListSort.Created)).toEqual([beta, alpha]);
    expect(ids(FactListSort.Changed)).toEqual([beta, alpha]);
    expect(ids(FactListSort.Versions)).toEqual([beta, alpha]);
    expect(ids(FactListSort.Usefulness)).toEqual([alpha, beta]);
    // Beta's observed version is newer, so its confidence is higher at NOW.
    expect(ids(FactListSort.Confidence)).toEqual([beta, alpha]);
  });

  it("pages across a boundary with a cursor and rejects a bad limit", async () => {
    const { alpha, beta } = await seedThree();
    const p1 = listFacts(store, { now: NOW, limit: 1, sort: FactListSort.Header });
    expect(p1.items.map((f) => f.id)).toEqual([alpha]);
    expect(p1.next).not.toBeNull();
    const p2 = listFacts(store, { now: NOW, limit: 1, sort: FactListSort.Header, cursor: p1.next ?? undefined });
    expect(p2.items.map((f) => f.id)).toEqual([beta]);
    expect(p2.next).toBeNull();
    expect(() => listFacts(store, { now: NOW, limit: 0 })).toThrow(InvalidPageError);
  });
});

describe("getFactDetail", () => {
  it("is null for an unknown id", () => {
    expect(getFactDetail(store, "nope", NOW)).toBeNull();
  });

  it("gives every version newest first with its change, retrievals and observed flag, plus the links", async () => {
    const ref = await seedChange(store, accepted([draft({ header: "Ref", content: "Ref content." })]), { now: T0 });
    const refId = ref.factIds[0] ?? "";
    const main = await seedChange(
      store,
      accepted([draft({ header: "Main", content: "Main content.", references: [refId] })]),
      { now: T0 + DAY },
    );
    const mainId = main.factIds[0] ?? "";
    // A version with no content change: not observed.
    const quiet = await seedChange(
      store,
      accepted([draft({ factId: mainId, header: "Main", content: "Main content.", references: [refId] })]),
      { now: T0 + 2 * DAY },
    );
    recordRetrieval(store, mainId, { now: T0 + 3 * DAY });
    recordRetrieval(store, mainId, { now: T0 + 3 * DAY, kind: RetrievalKind.Confirm });

    const d = getFactDetail(store, mainId, NOW);
    expect(d).not.toBeNull();
    expect(d?.versions.map((v) => v.seq)).toEqual([quiet.seq, main.seq]);
    expect(d?.versions.map((v) => v.observed)).toEqual([false, true]);
    expect(d?.versions[0]?.change).toEqual({
      seq: quiet.seq,
      outcome: ChangeOutcome.Accepted,
      summary: "test change",
      requestId: quiet.requestId,
      created: T0 + 2 * DAY,
    });
    expect(d?.versions[0]?.retrievals).toEqual({ [RetrievalKind.Read]: 1, [RetrievalKind.Confirm]: 1 });
    expect(d?.versions[1]?.retrievals).toEqual({ [RetrievalKind.Read]: 0, [RetrievalKind.Confirm]: 0 });
    expect(d?.references).toEqual([{ id: refId, header: "Ref", isDeleted: false }]);
    expect(d?.usefulness).toBeGreaterThan(0);
    expect(d?.isDeleted).toBe(false);

    const r = getFactDetail(store, refId, NOW);
    expect(r?.dependents).toEqual([{ id: mainId, header: "Main" }]);
  });

  it("shows a deleted fact with confidence 0 and the deletion as observed", async () => {
    const { gamma } = await seedThree();
    const d = getFactDetail(store, gamma, NOW);
    expect(d?.isDeleted).toBe(true);
    expect(d?.confidence).toBe(0);
    expect(d?.versions.map((v) => [v.isDeleted, v.observed])).toEqual([
      [true, true],
      [false, true],
    ]);
  });
});
