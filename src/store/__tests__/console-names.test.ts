import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeStore, namesOf, seedChange, type Store } from "../index.js";
import { T0, accepted, draft, makeStore } from "../../../__tests__/helpers/store.js";

let store: Store;
beforeEach(() => {
  store = makeStore();
});
afterEach(() => closeStore(store));

describe("namesOf", () => {
  it("names facts from a list, and leaves unknown ids out", async () => {
    const r = await seedChange(store, accepted([draft({ header: "Alpha", content: "Alpha here." })]), { now: T0 });
    const factId = r.factIds[0] ?? "";
    const names = namesOf(store, [factId, factId, "01NOPE"]);
    expect(names.facts).toEqual(new Map([[factId, "Alpha"]]));
  });

  it("reads nothing for no ids", () => {
    const names = namesOf(store, []);
    expect(names.facts.size).toBe(0);
  });
});
