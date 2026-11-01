import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ChangeOutcome, SearchHitKind } from "../../../domain/enums.js";
import { setEmbedder } from "../../../embed/index.js";
import { fakeEmbed, fakeVector } from "../../../../fakes/fake-embedder.js";
import { T0, draft, makeStore } from "../../../../__tests__/helpers/store.js";
import {
  applyChange,
  closeStore,
  enqueueRequest,
  ftsQuery,
  recordRetrieval,
  search,
  type ChangeSet,
  type Store,
} from "../../index.js";
import { useMultiplier } from "../boost.js";
import { queryTokens } from "../candidates.js";
import { applyRelevanceFloor, type FusedFact } from "../fuse.js";
import { DEFAULT_WEIGHTS } from "../../types/index.js";

beforeAll(() => setEmbedder(fakeEmbed));

const accepted = (facts: ChangeSet["facts"]): ChangeSet => ({
  outcome: ChangeOutcome.Accepted,
  summary: "s",
  changeReasoning: "r",
  facts,
});

// Applies a change through the async path, which embeds the facts and fills the vector tables.
const write = (s: Store, change: ChangeSet, now: number): ReturnType<typeof applyChange> =>
  applyChange(s, enqueueRequest(s, { change: "c", justification: "j" }, now), change, { now });

let store: Store | undefined;
afterEach(() => {
  if (store) closeStore(store);
  store = undefined;
});

const open = (): Store => (store = makeStore());

describe("ftsQuery", () => {
  it("quotes each token and joins them with OR", () => {
    expect(ftsQuery("attempts before failure")).toBe('"attempts" OR "failure"');
    expect(ftsQuery('say "hi" -x')).toBe('"say" OR """hi""" OR "-x"');
    expect(ftsQuery("   ")).toBe("");
  });

  it("drops English stopwords, with their punctuation, and keeps the rest", () => {
    expect(ftsQuery("how are facts deduplicated?")).toBe('"facts" OR "deduplicated?"');
    expect(ftsQuery("Where do the logs go")).toBe('"logs" OR "go"');
  });

  it("is empty when every token is a stopword", () => {
    expect(ftsQuery("what is the")).toBe("");
    expect(queryTokens("what is the")).toEqual([]);
  });
});

describe("the relevance floor", () => {
  const fused = (distance: number | undefined, ftsTerms: number): FusedFact => ({
    rrf: 0.01,
    bestTerm: 0.01,
    ftsTerms,
    distance,
  });
  const keptIds = (facts: Map<string, FusedFact>, queryTerms: number): string[] => [
    ...applyRelevanceFloor(facts, { floor: 0.31, queryTerms }).keys(),
  ];

  it("keeps a fact within the floor, drops one beyond it with fewer than 2 matched terms", () => {
    const facts = new Map([
      ["far", fused(0.32, 0)],
      ["near", fused(0.3, 0)],
      ["at", fused(0.31, 0)],
      ["far-one-term", fused(0.9, 1)],
    ]);
    expect(keptIds(facts, 3)).toEqual(["near", "at"]);
  });

  it("keeps a far fact that matches 2 distinct terms", () => {
    expect(keptIds(new Map([["two", fused(0.9, 2)]]), 3)).toEqual(["two"]);
  });

  it("keeps a far fact that matches the one term of a 1-term query", () => {
    expect(keptIds(new Map([["one", fused(0.9, 1)]]), 1)).toEqual(["one"]);
    expect(keptIds(new Map([["none", fused(0.9, 0)]]), 1)).toEqual([]);
  });

  it("is the floor of the store config in search: below the distance keeps the fact, above drops it", async () => {
    const s = open();
    const d = draft({ header: "Creeper fuse", content: "The fuse lasts 1.5 seconds." });
    await write(s, accepted([d]), T0);
    // No token of the query is in the fact, so only the vector list holds it.
    const query = "zebra stripes";
    const dot = fakeVector(query).reduce((acc, x, i) => acc + x * (fakeVector(`${d.header}. ${d.content}`)[i] ?? 0), 0);
    const distance = 1 - dot;
    s.config.relevanceFloor = distance + 0.01;
    expect((await search(s, query, { now: T0 })).filter((h) => h.kind === SearchHitKind.Fact)).toHaveLength(1);
    s.config.relevanceFloor = distance - 0.01;
    expect((await search(s, query, { now: T0 })).filter((h) => h.kind === SearchHitKind.Fact)).toHaveLength(0);
  });
});

describe("the usefulness multiplier", () => {
  const w = { wUse: DEFAULT_WEIGHTS.wUse, useBound: DEFAULT_WEIGHTS.useBound };

  it("is 1 at the mean, moves by wUse per unit and stays inside the bound", () => {
    expect(useMultiplier(2, 2, w)).toBe(1);
    expect(useMultiplier(3, 2, w)).toBeCloseTo(1.01);
    expect(useMultiplier(1000, 2, w)).toBeCloseTo(1.1);
    expect(useMultiplier(0, 1000, w)).toBeCloseTo(0.9);
  });

  it("takes the mean over the result list: equal usefulness changes no score", async () => {
    const s = open();
    await write(s, accepted([draft({ header: "Alpha scope", content: "Alpha thing happens." })]), T0);
    await write(s, accepted([draft({ header: "Alpha scope two", content: "Alpha thing happens again." })]), T0 + 1);
    const now = T0 + 1000;
    const before = await search(s, "alpha thing", { now });
    for (const h of before) if (h.kind === SearchHitKind.Fact) recordRetrieval(s, h.id, { now: now - 10 });
    const after = await search(s, "alpha thing", { now });
    expect(after.map((h) => h.score)).toEqual(before.map((h) => h.score));
  });

  it("cannot lift a fact over one that ranks far above it", async () => {
    const s = open();
    s.config.relevanceFloor = 2; // keep the vector-only fact, so that the order is the test
    const a = await write(s, accepted([draft({ header: "Alpha beta", content: "Alpha beta gamma delta." })]), T0);
    const b = await write(s, accepted([draft({ header: "Alpha only", content: "Alpha epsilon." })]), T0 + 1);
    const c = await write(s, accepted([draft({ header: "Zebra stripes", content: "Zebras have stripes." })]), T0 + 2);
    const [idA, idB, idC] = [a, b, c].map((r) => r.factIds[0]);
    const now = T0 + 1000;
    const query = "alpha beta gamma delta";
    const order = async (): Promise<string[]> =>
      (await search(s, query, { now })).flatMap((h) => (h.kind === SearchHitKind.Fact ? [h.id] : []));
    expect(await order()).toEqual([idA, idB, idC]);
    for (let i = 0; i < 100; i++) recordRetrieval(s, idC ?? "", { now: now - 10 });
    expect(await order()).toEqual([idA, idB, idC]);
  });
});
