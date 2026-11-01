import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SearchStep } from "../../../domain/enums.js";
import { RRF_CANDIDATES, VEC_CANDIDATES, closeStore, profileSearch, type Store } from "../../index.js";
import { T0, accepted, draft, makeStore, write } from "../../../../__tests__/helpers/store.js";

let store: Store;
beforeEach(() => {
  store = makeStore();
});
afterEach(() => closeStore(store));

describe("profileSearch", () => {
  it("times every step once, in ms", async () => {
    write(store, accepted([draft({ header: "Creeper fuse", content: "The fuse lasts 1.5 seconds." })]), T0);
    const timings = await profileSearch(store, "creeper fuse");
    expect(Object.keys(timings).sort()).toEqual(Object.values(SearchStep).sort());
    for (const ms of Object.values(timings)) expect(ms).toBeGreaterThanOrEqual(0);
  });

  it("runs on a blank query, which has no FTS match", async () => {
    const timings = await profileSearch(store, "   ");
    expect(timings[SearchStep.Total]).toBeGreaterThanOrEqual(0);
  });
});

describe("candidate counts", () => {
  it("keeps the KNN pool larger than the fusion list", () => {
    expect(RRF_CANDIDATES).toBe(50);
    expect(VEC_CANDIDATES).toBeGreaterThan(RRF_CANDIDATES);
  });
});
