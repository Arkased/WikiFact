// `tsx scripts/run-vitest.ts <vitest arguments>`: runs Vitest with `TEMP`, `TMP` and `TMPDIR` pointing to a folder of
// `.cache/test-runs/`. Vitest makes its own temp folder in `tmpdir()` when it starts and deletes it only when the run
// closes, so a stopped run leaves it in the Temp folder of the user (#74, docs/code-standard.md, section 8).
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";
import { isMain } from "../eval/lib/main.js";
import { ARGV_USER_OFFSET, RM_RETRIES, RM_RETRY_DELAY_MS } from "../src/constants.js";
import { readEnv, withTempFolder } from "../src/env.js";
import { errorMessage } from "../src/must.js";
import { projectRoot } from "../src/paths.js";
import { cleanStaleRuns, REAL_TEMP_ENV, realTempDir, RUN_FOLDER_PREFIX, testRunsRoot } from "./clean-temp.js";

/**
 * Runs Vitest in a run folder and deletes the folder when Vitest ends.
 *
 * @param args - the arguments for Vitest, such as `run --config vitest.ui.config.ts`
 * @returns the exit code of Vitest
 * @sideEffects reads the clock and the environment (`WIKIFACT_REAL_TEMP`, `TEMP`, and the environment that Vitest
 *   inherits); deletes the stale run folders; makes and deletes a folder under `.cache/test-runs/`; runs Vitest with
 *   the terminal of this process; a folder that fails to delete writes 1 warning line
 */
async function main(args: string[]): Promise<number> {
  cleanStaleRuns(testRunsRoot(), Date.now());
  mkdirSync(testRunsRoot(), { recursive: true });
  const runFolder = mkdtempSync(join(testRunsRoot(), RUN_FOLDER_PREFIX));
  try {
    const bin = join(projectRoot(), "node_modules", "vitest", "vitest.mjs");
    const r = await execa(process.execPath, [bin, ...args], {
      env: { ...withTempFolder(readEnv().raw, runFolder), [REAL_TEMP_ENV]: realTempDir() },
      extendEnv: false,
      stdio: "inherit",
      reject: false,
    });
    return r.exitCode ?? 1;
  } finally {
    try {
      rmSync(runFolder, { recursive: true, force: true, maxRetries: RM_RETRIES, retryDelay: RM_RETRY_DELAY_MS });
    } catch (e) {
      console.warn(`the run temp folder ${runFolder} is not deleted: ${errorMessage(e)}`);
    }
  }
}

if (isMain(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(ARGV_USER_OFFSET));
}
