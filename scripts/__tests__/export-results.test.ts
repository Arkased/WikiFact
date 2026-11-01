import { describe, expect, it } from "vitest";
import { resultFilesToDrop } from "../lib/export-results.js";

const A = "2026-01-01T00-00-00.000Z.json";
const B = "2026-02-01T00-00-00.000Z.json";
const C = "2026-03-01T00-00-00.000Z.json";

describe("resultFilesToDrop", () => {
  it("keeps the newest stamped file and each named file, and drops the rest", () => {
    const paths = [A, B, C, "summary-x.json", "notes.md", ".gitkeep"].map((n) => `res/${n}`);
    expect(resultFilesToDrop(paths, ["res"], [`see ${A}`])).toEqual([
      "res/2026-02-01T00-00-00.000Z.json",
      "res/summary-x.json",
    ]);
  });

  it("keeps the newest summary file of the folder besides the newest result file", () => {
    const paths = [A, B, C, `summary-${A}`, `summary-${B}`, `summary-${C}`, "summary-old.json"].map((n) => `res/${n}`);
    expect(resultFilesToDrop(paths, ["res"], [])).toEqual([
      `res/${A}`,
      `res/${B}`,
      `res/summary-${A}`,
      `res/summary-${B}`,
      "res/summary-old.json",
    ]);
  });

  it("does not take a name inside a longer name as a mention", () => {
    const paths = [`res/${A}`, `res/${B}`, "res/summary-" + A];
    expect(resultFilesToDrop(paths, ["res"], [`only summary-${A}`])).toEqual([`res/${A}`]);
  });

  it("works per folder and leaves other paths alone", () => {
    const paths = [`one/${A}`, `one/${B}`, `two/${A}`, `src/${A}`];
    expect(resultFilesToDrop(paths, ["one", "two"], [])).toEqual([`one/${A}`]);
  });
});
