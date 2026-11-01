import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { countResults, readResults, runQuietStep, type QuietStepOptions } from "../quiet-step.js";

/**
 * Builds the options of `runQuietStep` with a fixed outcome and a fixed clock.
 *
 * @param exitCode - the exit code of the step
 * @param resultsDir - the results folder
 * @returns the options
 * @sideEffects none
 */
function optionsOf(exitCode: number, resultsDir: string): QuietStepOptions {
  return { launch: () => Promise.resolve({ output: "", exitCode }), write: () => undefined, now: () => 0, resultsDir };
}

describe("runQuietStep result file", () => {
  it("writes 1 result file with pass for a passing step", async () => {
    const dir = mkdtempSync(join(tmpdir(), "quiet-step-"));
    await runQuietStep("lint", optionsOf(0, dir));
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(readFileSync(join(dir, files[0] ?? ""), "utf8").trim()).toBe("pass");
  });

  it("writes 1 result file with FAIL for a failing step", async () => {
    const dir = mkdtempSync(join(tmpdir(), "quiet-step-"));
    await runQuietStep("lint", optionsOf(2, dir));
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(readFileSync(join(dir, files[0] ?? ""), "utf8").trim()).toBe("FAIL");
  });
});

describe("readResults", () => {
  it("returns the results of 2 result files, so that countResults counts 2 steps", () => {
    const dir = mkdtempSync(join(tmpdir(), "quiet-step-"));
    writeFileSync(join(dir, "1.txt"), "pass\n");
    writeFileSync(join(dir, "2.txt"), "FAIL\n");
    expect(countResults(readResults(dir), 2)).toEqual({ passed: 1, failed: 1, notFinished: 0 });
  });

  it("returns no result for an empty folder", () => {
    const dir = mkdtempSync(join(tmpdir(), "quiet-step-"));
    const results = readResults(dir);
    expect(results).toBe("");
    expect(countResults(results, 3)).toEqual({ passed: 0, failed: 0, notFinished: 3 });
  });
});
