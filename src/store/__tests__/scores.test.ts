import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChangeOutcome } from "../../domain/enums.js";
import {
  closeStore,
  confidence,
  confidences,
  decay,
  enqueueRequest,
  applyChangeSync,
  getFact,
  openStore,
  recordRetrieval,
  usefulness,
  DEFAULT_WEIGHTS,
  type Store,
} from "../index.js";
import { DAY, T0, accepted, draft, makeStore, write } from "../../../__tests__/helpers/store.js";

function must<T>(x: T | null | undefined): T {
  if (x === null || x === undefined) throw new Error("expected a value");
  return x;
}

let store: Store;
beforeEach(() => {
  store = makeStore();
});
afterEach(() => closeStore(store));

const conf = (id: string, now: number) => confidence(store, id, now);
const S = (c: number) => -Math.log2(1 - c); // back to the sum, for readable asserts

describe("defaults", () => {
  it("match technical/README.md, Open settings", () => {
    expect(DEFAULT_WEIGHTS).toEqual({
      wUpdate: 1,
      wConfirm: 1,
      wRead: 0,
      halfLifeConf: 30 * DAY,
      wUse: 0.01,
      useBound: 0.1,
      halfLifeUse: 30 * DAY,
    });
  });
  it("decay halves per half-life", () => {
    expect(decay(0, 30 * DAY, 30 * DAY)).toBeCloseTo(0.5, 12);
    expect(decay(0, 0, 30 * DAY)).toBe(1);
  });
});

describe('confidence (technical/lookup.md, "Confidence")', () => {
  it("an update counts at its creation time and decays", () => {
    const f = write(store, accepted([draft()]), T0).factIds[0];
    expect(conf(f, T0)).toBeCloseTo(0.5, 12);
    expect(S(conf(f, T0 + 30 * DAY))).toBeCloseTo(0.5, 10);
    expect(conf("unknown", T0)).toBe(0);
  });

  it("a read does not count while W_READ is 0, and counts when it is set", () => {
    const f = write(store, accepted([draft()]), T0).factIds[0];
    recordRetrieval(store, f, { now: T0 });
    expect(conf(f, T0)).toBeCloseTo(0.5, 12);
    store.weights.wRead = 0.5;
    expect(S(conf(f, T0))).toBeCloseTo(1.5, 10);
  });

  it("a confirm row from duplicateOf counts as W_CONFIRM at the change time", () => {
    const f = write(store, accepted([draft()]), T0).factIds[0];
    write(
      store,
      { outcome: ChangeOutcome.Duplicate, duplicateOf: f, summary: "dup", changeReasoning: "r", facts: [] },
      T0 + 30 * DAY,
    );
    const rows = store.db.prepare("SELECT kind, at, weight FROM retrievals").all();
    expect(rows).toEqual([{ kind: "confirm", at: T0 + 30 * DAY, weight: 1 }]);
    expect(S(conf(f, T0 + 30 * DAY))).toBeCloseTo(0.5 + 1, 10);
  });

  it("a maintenance write (header, justification) does not reset confidence", () => {
    const f = write(store, accepted([draft()]), T0).factIds[0];
    write(
      store,
      { outcome: ChangeOutcome.Duplicate, duplicateOf: f, summary: "dup", changeReasoning: "r", facts: [] },
      T0 + 10 * DAY,
    );
    const before = conf(f, T0 + 40 * DAY);
    // same content, new header, and a new justification
    write(
      store,
      accepted([draft({ factId: f, header: "Creeper damage (melee)", justification: "reworded" })]),
      T0 + 20 * DAY,
    );
    expect(conf(f, T0 + 40 * DAY)).toBeCloseTo(before, 12);
    // the confirm on the older version still counts
    expect(S(before)).toBeCloseTo(
      decay(T0, T0 + 40 * DAY, 30 * DAY) + decay(T0 + 10 * DAY, T0 + 40 * DAY, 30 * DAY),
      10,
    );
  });

  it("a version with an empty justification does not reset confidence", () => {
    const f = write(store, accepted([draft()]), T0).factIds[0];
    const before = conf(f, T0 + 5 * DAY);
    write(store, accepted([draft({ factId: f, content: "Creepers do 12 damage.", justification: "" })]), T0 + 3 * DAY);
    expect(conf(f, T0 + 5 * DAY)).toBeCloseTo(before, 12);
  });

  it("an observed version resets: older events no longer count", () => {
    const f = write(store, accepted([draft()]), T0).factIds[0];
    write(
      store,
      { outcome: ChangeOutcome.Duplicate, duplicateOf: f, summary: "dup", changeReasoning: "r", facts: [] },
      T0 + DAY,
    );
    const t2 = T0 + 10 * DAY;
    write(store, accepted([draft({ factId: f, content: "Creepers do 12 damage.", justification: "saw 12" })]), t2);
    expect(S(conf(f, t2))).toBeCloseTo(1, 10);
    // a confirm on the new version counts
    write(
      store,
      { outcome: ChangeOutcome.Duplicate, duplicateOf: f, summary: "dup", changeReasoning: "r", facts: [] },
      t2,
    );
    expect(S(conf(f, t2))).toBeCloseTo(2, 10);
  });

  it("a fact with no observed version takes the lowest confidence of its references", () => {
    const a = write(store, accepted([draft({ header: "A", content: "a" })]), T0).factIds[0];
    const b = write(store, accepted([draft({ header: "B", content: "b" })]), T0 + 20 * DAY).factIds[0];
    const eq = write(
      store,
      accepted([
        draft({ header: "Skellies", content: "Skellies are skeletons.", justification: "", references: [a, b] }),
      ]),
      T0 + 21 * DAY,
    ).factIds[0];
    const now = T0 + 25 * DAY;
    const lowest = Math.min(conf(a, now), conf(b, now));
    expect(lowest).toBe(conf(a, now));
    expect(conf(eq, now)).toBeCloseTo(lowest, 12);
    // the reference moves with the evidence
    write(
      store,
      { outcome: ChangeOutcome.Duplicate, duplicateOf: a, summary: "dup", changeReasoning: "r", facts: [] },
      now,
    );
    expect(conf(eq, now)).toBeCloseTo(Math.min(conf(a, now), conf(b, now)), 12);
  });

  it("a fact with no observed version and no references has confidence 0", () => {
    const f = write(store, accepted([draft({ justification: "" })]), T0).factIds[0];
    expect(conf(f, T0)).toBe(0);
  });

  it("a reference cycle without evidence ends", () => {
    const a = write(store, accepted([draft({ factId: "01A", justification: "" })]), T0).factIds[0];
    const b = write(
      store,
      accepted([draft({ factId: "01B", header: "B", content: "b", justification: "", references: [a] })]),
      T0 + 1,
    ).factIds[0];
    write(store, accepted([draft({ factId: a, justification: "", references: [b] })]), T0 + 2);
    expect(conf(a, T0 + 3)).toBe(0);
  });

  it("getFact returns the same confidence", () => {
    const f = write(store, accepted([draft()]), T0).factIds[0];
    expect(must(getFact(store, f, { now: T0 })).confidence).toBeCloseTo(0.5, 12);
  });

  it("takes weights from the config", () => {
    const s = openStore(":memory:", { embeddingModel: "m", weights: { wUpdate: 2, halfLifeConf: DAY } });
    const reqId = enqueueRequest(s, { change: "c", justification: "j" }, T0);
    const r = applyChangeSync(s, reqId, accepted([draft()]), { now: T0 });
    expect(S(confidence(s, r.factIds[0], T0))).toBeCloseTo(2, 10);
    expect(S(confidence(s, r.factIds[0], T0 + DAY))).toBeCloseTo(1, 10);
    closeStore(s);
  });
});

describe('usefulness (technical/lookup.md, "Usefulness")', () => {
  it("sums reads and confirms over all fact versions, decayed", () => {
    const f = write(store, accepted([draft()]), T0).factIds[0];
    recordRetrieval(store, f, { now: T0 });
    write(store, accepted([draft({ factId: f, content: "v2", justification: "saw v2" })]), T0 + 10 * DAY);
    recordRetrieval(store, f, { now: T0 + 20 * DAY });
    write(
      store,
      { outcome: ChangeOutcome.Duplicate, duplicateOf: f, summary: "dup", changeReasoning: "r", facts: [] },
      T0 + 30 * DAY,
    );
    const now = T0 + 30 * DAY;
    const u = must(usefulness(store, [f], now).get(f));
    expect(u).toBeCloseTo(decay(T0, now, 30 * DAY) + decay(T0 + 20 * DAY, now, 30 * DAY) + 1, 10);
  });

  it("is 0 for a fact with no retrievals", () => {
    const f = write(store, accepted([draft()]), T0).factIds[0];
    expect(usefulness(store, [f], T0).get(f)).toBe(0);
  });
});

describe('confidences, the bulk form (technical/lookup.md, "Confidence")', () => {
  it("gives every fact the same value as the single-fact form", () => {
    const a = write(store, accepted([draft({ header: "A", content: "a" })]), T0).factIds[0];
    const b = write(store, accepted([draft({ header: "B", content: "b" })]), T0 + 2 * DAY).factIds[0];
    const eq = write(
      store,
      accepted([draft({ header: "Eq", content: "A is B.", justification: "", references: [a, b] })]),
      T0 + 3 * DAY,
    ).factIds[0];
    const gone = write(store, accepted([draft({ header: "Gone", content: "g" })]), T0).factIds[0];
    write(store, accepted([draft({ factId: gone, header: "Gone", content: "g", isDeleted: true })]), T0 + 4 * DAY);
    recordRetrieval(store, a, { now: T0 + 5 * DAY });
    write(
      store,
      { outcome: ChangeOutcome.Duplicate, duplicateOf: b, summary: "dup", changeReasoning: "r", facts: [] },
      T0 + 6 * DAY,
    );
    const now = T0 + 10 * DAY;
    const bulk = confidences(store, [a, b, eq, gone, "01UNKNOWN", a], now);
    for (const id of [a, b, eq, gone]) expect(bulk.get(id)).toBeCloseTo(confidence(store, id, now), 12);
    expect(bulk.get(gone)).toBe(0);
    expect(bulk.get("01UNKNOWN")).toBe(0);
    expect(bulk.size).toBe(5);
    expect(confidences(store, [], now).size).toBe(0);
  });
});
