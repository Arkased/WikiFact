import { describe, expect, it } from "vitest";
import { stamp, unstamp } from "../../time.js";
import { findTwin, normalForm } from "../names.js";

describe("normalForm", () => {
  it("lower-cases, removes hyphens and removes one final s", () => {
    expect(normalForm("creepers")).toBe("creeper");
    expect(normalForm("game-mechanics")).toBe("gamemechanic");
    expect(normalForm("Mobs")).toBe("mob");
    expect(normalForm("glass")).toBe("glas");
    expect(normalForm("bass-")).toBe("bas");
    expect(normalForm("s")).toBe("");
  });
});

describe("findTwin", () => {
  it("finds a twin for each pair", () => {
    const pairs: [string, string][] = [
      ["creepers", "creeper"],
      ["creeper", "creepers"],
      ["game-mechanics", "gamemechanics"],
      ["gamemechanics", "game-mechanics"],
      ["potion", "potions"],
      ["Mobs", "mobs"],
    ];
    for (const [name, existing] of pairs) expect(findTwin(name, [existing])).toBe(existing);
  });

  it("finds no twin for different names", () => {
    expect(findTwin("creeper", ["creepy"])).toBeUndefined();
    expect(findTwin("potion", ["notion", "lotions"])).toBeUndefined();
    expect(findTwin("a-b", ["a", "b"])).toBeUndefined();
  });

  it("does not count the same name as its own twin", () => {
    expect(findTwin("creeper", ["creeper"])).toBeUndefined();
    expect(findTwin("creeper", ["zombie", "creeper", "creepers"])).toBe("creepers");
  });
});

describe("stamp", () => {
  it("round-trips through unstamp and rejects other strings", () => {
    const date = new Date("2026-10-10T04:07:29.171Z");
    expect(stamp(date)).toBe("2026-10-10T04-07-29.171Z");
    expect(unstamp(stamp(date))).toBe(date.toISOString());
    expect(unstamp("2026-10-10")).toBeUndefined();
  });
});
