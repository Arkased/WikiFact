import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readProjectName } from "../project-name.js";

function withFile(content: string, run: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "project-name-"));
  try {
    const path = join(dir, "setup.config.json");
    writeFileSync(path, content);
    run(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("readProjectName", () => {
  it("reads projectName", () => {
    withFile('{"projectName":"WikiFact"}', (path) => expect(readProjectName(path)).toBe("WikiFact"));
  });

  it("reads the real config of the repo", () => {
    expect(readProjectName()).not.toBe("");
  });

  it("throws on a missing key", () => {
    withFile("{}", (path) => expect(() => readProjectName(path)).toThrow(/projectName/));
  });

  it("throws on a file that is not JSON", () => {
    withFile("nope", (path) => expect(() => readProjectName(path)).toThrow(/cannot read/));
  });

  it("throws on a missing file", () => {
    expect(() => readProjectName(join(tmpdir(), "no-such-dir-xyz", "c.json"))).toThrow(/cannot read/);
  });
});
