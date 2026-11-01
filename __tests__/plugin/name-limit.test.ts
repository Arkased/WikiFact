import { describe, expect, it } from "vitest";
import { MAX_NAME_LENGTH } from "../../plugin/src/setup.js";
import { WIKI_NAME_PATTERN } from "../../src/service/names.js";

describe("the wiki name limit of the plugin", () => {
  it("is the longest name that WIKI_NAME_PATTERN accepts", () => {
    expect(WIKI_NAME_PATTERN.test("a".repeat(MAX_NAME_LENGTH))).toBe(true);
    expect(WIKI_NAME_PATTERN.test("a".repeat(MAX_NAME_LENGTH + 1))).toBe(false);
  });
});
