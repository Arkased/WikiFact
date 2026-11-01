import { beforeEach, describe, expect, it, vi } from "vitest";

const files = vi.hoisted(() => ({ text: "" }));
vi.mock("node:fs", () => ({ readFileSync: () => files.text }));

import { loadRelevance } from "../cases.js";

const fileWith = (extra: Record<string, unknown>): string =>
  JSON.stringify({
    facts: [],
    reads: [],
    cases: [{ id: "c", query: "q", note: "n", ...extra }],
  });

describe("loadRelevance allowNear", () => {
  beforeEach(() => {
    files.text = "";
  });

  it("refuses allowNear on a case that is not an expectNone case", () => {
    files.text = fileWith({ expectHeader: "A", allowNear: ["B"] });
    expect(() => loadRelevance()).toThrow();
  });

  it("loads an expectNone case with allowNear", () => {
    files.text = fileWith({ expectNone: true, allowNear: ["B"] });
    expect(loadRelevance().cases[0]?.allowNear).toEqual(["B"]);
  });
});
