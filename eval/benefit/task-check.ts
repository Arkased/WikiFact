// The check of a task run (technical/evaluation.md, "One task run"): copy the hidden tests in, run them and the type
// check, and call the task done when both pass.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { HIDDEN_FOLDER, HIDDEN_SUFFIX } from "./cases.js";
import { exitCodeOf } from "./worktree.js";

/** The time the hidden tests, and the type check, may take each, in ms (10 minutes). */
const CHECK_TIMEOUT_MS = 10 * 60 * 1000;

/** What the check found. */
export interface CheckResult {
  /** The hidden tests passed. */
  testsPass: boolean;
  /** The type check passed. */
  typecheckPass: boolean;
  /** The tail of the output of the failing command, for the log. */
  output: string;
  /** The exit code of `npx vitest run`; null when it did not end with a code. Absent in a stub. */
  testsExit?: number | null;
  /** The exit code of `npm run typecheck`. Absent in a stub. */
  typecheckExit?: number | null;
}

/** Runs the hidden tests and the type check in a worktree. A test injects a fake. */
export type TaskChecker = (dir: string, hiddenTests: string[]) => Promise<CheckResult>;

/**
 * Copies the hidden tests of a task into the worktree. A file the agent wrote at the same path is replaced, so a run
 * that changed a test that a hidden test replaces is judged on the hidden test alone.
 *
 * @param taskDir - the folder of the task files
 * @param dir - the worktree
 * @param hiddenTests - the paths in the repo, relative to its root
 * @throws {Error} when a hidden test file is missing from the task folder
 * @sideEffects writes the files into the worktree
 */
export function copyHiddenTests(taskDir: string, dir: string, hiddenTests: string[]): void {
  for (const path of hiddenTests) {
    const from = join(taskDir, HIDDEN_FOLDER, path + HIDDEN_SUFFIX);
    if (!existsSync(from)) throw new Error(`the hidden test ${path} has no file ${from}`);
    const to = join(dir, path);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
  }
}

/**
 * The real checker: `npx vitest run <hiddenTests>` and `npm run typecheck`, both always run.
 *
 * @returns the checker
 * @sideEffects per call: 2 child processes in the worktree
 */
export function commandChecker(): TaskChecker {
  return async (dir, hiddenTests) => {
    const tests = await exitCodeOf(dir, "npx", ["vitest", "run", ...hiddenTests], CHECK_TIMEOUT_MS);
    const types = await exitCodeOf(dir, "npm", ["run", "typecheck"], CHECK_TIMEOUT_MS);
    const failed = tests.code !== 0 ? tests : types;
    return {
      testsPass: tests.code === 0,
      typecheckPass: types.code === 0,
      output: failed.output,
      testsExit: tests.code,
      typecheckExit: types.code,
    };
  };
}
