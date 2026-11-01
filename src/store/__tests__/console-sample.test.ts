import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeStore, sampleFacts, seedChange, type Store } from "../index.js";
import { DAY, T0, accepted, draft, makeStore } from "../../../__tests__/helpers/store.js";

let store: Store;
beforeEach(() => {
  store = makeStore();
});
afterEach(() => closeStore(store));

describe("sampleFacts", () => {
  it("is empty on an empty wiki", () => {
    expect(sampleFacts(store, 10, T0)).toEqual([]);
  });

  it("returns the live facts with content and confidence, and never a deleted one", async () => {
    const seed = await seedChange(
      store,
      accepted([
        draft({ header: "A", content: "A." }),
        draft({ header: "B", content: "B." }),
        draft({ header: "C", content: "C." }),
        draft({ header: "Gone", content: "Gone." }),
      ]),
      { now: T0 },
    );
    const gone = seed.factIds[3] ?? "";
    await seedChange(
      store,
      accepted([{ factId: gone, header: "", content: "", justification: "gone", references: [], isDeleted: true }]),
      { now: T0 + DAY },
    );
    const sample = sampleFacts(store, 10, T0 + 2 * DAY);
    expect(sample.map((f) => f.header).sort()).toEqual(["A", "B", "C"]);
    const a = sample.find((f) => f.header === "A");
    expect(a).toMatchObject({ content: "A." });
    expect(a?.confidence).toBeGreaterThan(0);
    expect(sampleFacts(store, 2, T0)).toHaveLength(2);
  });
});
