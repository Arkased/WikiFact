// A test run uses 1 temp folder of its own, under `.cache/test-runs/` in the repo (docs/code-standard.md, section 8).
// `TEMP`, `TMP`, `TMPDIR`, `HOME` and `USERPROFILE` point to it, so every `mkdtempSync(join(tmpdir(), ...))` of a test lands in it, and the
// end of the run deletes it whole.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { cleanRealTemp, cleanStaleRuns, realTempDir, RUN_FOLDER_PREFIX, testRunsRoot } from "../scripts/clean-temp.js";
import { RM_RETRIES, RM_RETRY_DELAY_MS } from "../src/constants.js";
import { errorMessage } from "../src/must.js";

/**
 * The variables that `os.tmpdir()` and `os.homedir()` read, on Windows and on POSIX. The home folder points to the run
 * folder too, so that code which finds a deployment from the home folder finds none (a predeploy test touches no
 * deployed environment, docs/code-standard.md, section 8).
 */
const TEMP_VARS = ["TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE"] as const;

/**
 * Points the temp folder of the run to a new empty folder.
 *
 * @returns the teardown: restores the variables and deletes the folder
 * @sideEffects reads the clock and `TEMP`, plus `WIKIFACT_REAL_TEMP` or `tmpdir()` for the real Temp folder; first
 *   deletes the run folders in `.cache/test-runs/` that are older than 1 hour (stopped runs); `cleanRealTemp` deletes
 *   the old leftovers in the real Temp folder, and writes 1 line with the counts to stdout and a warning line to
 *   stderr for each folder it fails to delete and for each Vitest-named folder it cannot read; makes a folder under `.cache/test-runs/` in the repo, or reuses the one
 *   that `scripts/run-vitest.ts` made (`TEMP` points into `.cache/test-runs/`); sets `TEMP`, `TMP`, `TMPDIR`, `HOME` and
 *   `USERPROFILE` in `process.env`, which the test workers inherit; the teardown restores them and deletes the folder
 */
export default function setup(): () => void {
  const saved = TEMP_VARS.map((name) => [name, process.env[name]] as const);
  const rmOptions = { recursive: true, force: true, maxRetries: RM_RETRIES, retryDelay: RM_RETRY_DELAY_MS };
  cleanStaleRuns(testRunsRoot(), Date.now());
  // The real Temp folder, read before `TEMP` is redirected below (or by `scripts/run-vitest.ts`, which passes it on).
  cleanRealTemp(realTempDir(), Date.now());
  // `scripts/run-vitest.ts` already points `TEMP` to a run folder and deletes it when Vitest ends (#74).
  const given = process.env.TEMP;
  const startedByLauncher = given !== undefined && dirname(given) === testRunsRoot();
  mkdirSync(testRunsRoot(), { recursive: true });
  const root = startedByLauncher ? given : mkdtempSync(join(testRunsRoot(), RUN_FOLDER_PREFIX));
  for (const name of TEMP_VARS) process.env[name] = root;
  return () => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    try {
      rmSync(root, rmOptions);
    } catch (e) {
      // A file in the run folder can still be locked when the run ends (an EPERM was seen once in `npm run check`).
      // The run does not fail for it; `npm run clean-temp` deletes the folder later.
      console.warn(`the run temp folder ${root} is not deleted: ${errorMessage(e)}`);
    }
  };
}
