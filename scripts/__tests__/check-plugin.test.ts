import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findProblems } from "../check-plugin.js";

/**
 * Makes a folder that holds the given files.
 *
 * @param files - the file names and their text
 * @returns the folder
 * @sideEffects makes a folder under the temp folder
 */
function folderWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "wikifact-check-plugin-"));
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

const tracked = (...names: string[]): Set<string> => new Set(names.map((n) => `plugin/dist/${n}`));

describe("findProblems", () => {
  it("passes when the folders are equal and tracked, line ends aside", () => {
    const actual = folderWith({ "a.js": "x\r\ny\r\n" });
    const fresh = folderWith({ "a.js": "x\ny\n" });
    expect(findProblems(actual, fresh, tracked("a.js"))).toEqual([]);
  });

  it("fails when a bundle is missing", () => {
    const problems = findProblems(folderWith({}), folderWith({ "a.js": "x" }), tracked("a.js"));
    expect(problems).toEqual([expect.stringContaining("a.js is missing")]);
  });

  it("fails when a bundle has no source entry", () => {
    const problems = findProblems(folderWith({ "a.js": "x" }), folderWith({}), tracked("a.js"));
    expect(problems).toEqual([expect.stringContaining("a.js has no source entry")]);
  });

  it("fails when a bundle differs", () => {
    const problems = findProblems(folderWith({ "a.js": "x" }), folderWith({ "a.js": "y" }), tracked("a.js"));
    expect(problems).toEqual([expect.stringContaining("a.js differs")]);
  });

  it("fails when git does not track a bundle", () => {
    const problems = findProblems(folderWith({ "a.js": "x" }), folderWith({ "a.js": "x" }), tracked());
    expect(problems).toEqual([expect.stringContaining("a.js is not tracked")]);
  });
});
