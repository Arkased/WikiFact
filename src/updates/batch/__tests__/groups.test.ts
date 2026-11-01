import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setEmbedder } from "../../../embed/index.js";
import { fakeEmbed } from "../../../../fakes/fake-embedder.js";
import { groupRequests } from "../groups.js";

const requests = [
  { id: "a", change: "Zombies burn in daylight" },
  { id: "b", change: "Zombies burn in daylight" },
  { id: "c", change: "Villagers trade emeralds for bread" },
];

describe("groupRequests", () => {
  beforeEach(() => setEmbedder(fakeEmbed));
  afterEach(() => setEmbedder(null));

  it("returns no group for no request", async () => {
    expect(await groupRequests([], 0.5)).toEqual([]);
  });

  it("makes a group of each request at cut 0", async () => {
    expect(await groupRequests(requests, 0)).toEqual([["a"], ["b"], ["c"]]);
  });

  it("links every request at cut 2, in queue order", async () => {
    expect(await groupRequests(requests, 2)).toEqual([["a", "b", "c"]]);
  });

  it("links equal texts and leaves a distant one alone", async () => {
    expect(await groupRequests(requests, 0.01)).toEqual([["a", "b"], ["c"]]);
  });

  it("orders the groups by their first request", async () => {
    const [a, b, c] = requests;
    const out = await groupRequests(
      [c, a, b].flatMap((r) => (r ? [r] : [])),
      0.01,
    );
    expect(out).toEqual([["c"], ["a", "b"]]);
  });
});
