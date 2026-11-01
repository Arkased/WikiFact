import { describe, expect, it } from "vitest";
import { DiffOp } from "../../domain/enums.js";
import { diffHtml, wordDiff } from "../diff.js";
import { parse } from "./helpers/dom.js";

describe('wordDiff (technical/console.md, "Fact")', () => {
  it("keeps equal texts as one run", () => {
    expect(wordDiff("a b c", "a b c")).toEqual([{ op: DiffOp.Keep, text: "a b c" }]);
  });

  it("marks a changed word as a delete and an insert", () => {
    expect(wordDiff("Creepers do 7 damage", "Creepers do 10 damage")).toEqual([
      { op: DiffOp.Keep, text: "Creepers do" },
      { op: DiffOp.Delete, text: "7" },
      { op: DiffOp.Insert, text: "10" },
      { op: DiffOp.Keep, text: "damage" },
    ]);
  });

  it("handles an empty side and extra whitespace", () => {
    expect(wordDiff("", "new text")).toEqual([{ op: DiffOp.Insert, text: "new text" }]);
    expect(wordDiff("old  text ", "")).toEqual([{ op: DiffOp.Delete, text: "old text" }]);
    expect(wordDiff("", "")).toEqual([]);
  });

  it("renders inserts and deletes as marked-up, escaped text", () => {
    const page = parse(diffHtml("a <b>", "a <c>"));
    expect(page.removed()).toEqual(["<b>"]);
    expect(page.inserted()).toEqual(["<c>"]);
    expect(page.text).toContain("a");
    expect(page.$("b")).toBeNull();
    expect(page.$("c")).toBeNull();
  });
});
