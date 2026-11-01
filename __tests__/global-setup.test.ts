// The global setup (docs/code-standard.md, section 8): the run folder that it makes, or reuses when
// `scripts/run-vitest.ts` made it, and the cleanup of the real Temp folder at the start of a run.
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { REAL_TEMP_ENV, RUN_FOLDER_PREFIX, testRunsRoot } from "../scripts/clean-temp.js";
import setup from "./global-setup.js";

afterEach(() => vi.unstubAllEnvs());

/** Points the cleanup to a fake real Temp folder, so that no test of the setup cleans the Temp folder of the user. */
function fakeRealTemp(): void {
  vi.stubEnv(REAL_TEMP_ENV, mkdtempSync(join(tmpdir(), "fakeclaude-")));
}

describe("global setup", () => {
  it("makes a run folder under .cache/test-runs when Vitest was started by hand, and deletes it at the end", () => {
    fakeRealTemp();
    const handTemp = mkdtempSync(join(tmpdir(), "fakeclaude-"));
    vi.stubEnv("TEMP", handTemp);
    const teardown = setup();
    const made = process.env.TEMP ?? "";
    expect(made).not.toBe(handTemp);
    expect(dirname(made)).toBe(testRunsRoot());
    expect(basename(made).startsWith(RUN_FOLDER_PREFIX)).toBe(true);
    expect(existsSync(made)).toBe(true);
    teardown();
    expect(existsSync(made)).toBe(false);
    expect(process.env.TEMP).toBe(handTemp);
  });

  it("reuses the run folder that scripts/run-vitest.ts made, and still deletes it at the end", () => {
    fakeRealTemp();
    mkdirSync(testRunsRoot(), { recursive: true });
    const launcherFolder = mkdtempSync(join(testRunsRoot(), RUN_FOLDER_PREFIX));
    vi.stubEnv("TEMP", launcherFolder);
    const teardown = setup();
    for (const name of ["TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE"]) expect(process.env[name]).toBe(launcherFolder);
    expect(existsSync(launcherFolder)).toBe(true);
    teardown();
    expect(existsSync(launcherFolder)).toBe(false);
  });

  it("cleans the real Temp folder named by WIKIFACT_REAL_TEMP and logs 1 line with the counts", () => {
    fakeRealTemp();
    // Not a folder of .cache/test-runs: the setup would take the run folder of this very run for its own and delete it.
    vi.stubEnv("TEMP", mkdtempSync(join(tmpdir(), "fakeclaude-")));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const teardown = setup();
    teardown();
    const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("clean-temp:"));
    log.mockRestore();
    expect(lines).toHaveLength(1);
  });
});
