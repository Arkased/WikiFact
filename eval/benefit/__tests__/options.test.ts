import { describe, expect, it } from "vitest";
import { parseOptions } from "../../benefit.js";

describe("the options of the benefit test", () => {
  it("runs each case at least once and preloads at least 1 round, and defaults to more runs than 3", () => {
    const base = ["--db", "x.sqlite"];
    expect(parseOptions(base).runs).toBe(10);
    expect(parseOptions(base).preloadRounds).toBe(3);
    expect(() => parseOptions([...base, "--preload-rounds", "0"])).toThrow(/--preload-rounds/);
    expect(parseOptions([...base, "--preload-rounds", "1"]).preloadRounds).toBe(1);
  });
});
