// Helpers shared by `deploy.ts` and `ship.ts`: run a command and stop with a message.
import { execaSync } from "execa";
import { errorMessage } from "../../src/must.js";

/** The result of a finished command. */
export interface RunResult {
  /** The exit code; 1 when the process could not start. */
  code: number;
  stdout: string;
}

/** Thrown by `must` when a command fails; the scripts print the message and exit with code 1. */
export class ScriptError extends Error {}

/**
 * Runs a command and waits for it.
 *
 * @param file - the program, e.g. `git` or `npm`
 * @param args - its arguments
 * @param inherit - true to show its output (stdout and stderr go to this process), false to capture stdout
 * @returns the exit code and the captured stdout (empty when `inherit` is true)
 * @sideEffects runs a child process
 */
export function run(file: string, args: string[], inherit = false): RunResult {
  const r = execaSync(file, args, {
    reject: false,
    stdin: "ignore",
    stdout: inherit ? "inherit" : "pipe",
    stderr: "inherit",
  });
  return { code: r.exitCode ?? 1, stdout: typeof r.stdout === "string" ? r.stdout : "" };
}

/**
 * Runs a command and waits for it, capturing both output streams.
 *
 * @param file - the program
 * @param args - its arguments
 * @returns the exit code, stdout and stderr
 * @sideEffects runs a child process
 */
export function runCaptured(file: string, args: string[]): RunResult & { stderr: string } {
  const r = execaSync(file, args, { reject: false, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  return {
    code: r.exitCode ?? 1,
    stdout: typeof r.stdout === "string" ? r.stdout : "",
    stderr: typeof r.stderr === "string" ? r.stderr : "",
  };
}

/**
 * Runs a command and throws when it fails.
 *
 * @param file - the program
 * @param args - its arguments
 * @param inherit - true to show its output
 * @returns the captured stdout
 * @throws {ScriptError} when the exit code is not 0
 * @sideEffects runs a child process
 */
export function must(file: string, args: string[], inherit = false): string {
  const r = run(file, args, inherit);
  if (r.code !== 0) throw new ScriptError(`${file} ${args.join(" ")} failed with exit code ${r.code}`);
  return r.stdout;
}

/**
 * Stops with an error when the git working tree has uncommitted changes.
 *
 * @throws {ScriptError} when `git status --porcelain` lists anything
 * @sideEffects runs git
 */
export function requireCleanTree(): void {
  if (must("git", ["status", "--porcelain"]).trim() !== "") {
    throw new ScriptError("the working tree is not clean: commit or stash your changes first");
  }
}

/**
 * Runs an async script body and turns a `ScriptError` into a message and exit code 1.
 *
 * @param body - the work of the script
 * @returns a promise that settles once the body has finished or failed
 * @sideEffects whatever `body` does; prints the error message and sets `process.exitCode`
 */
export async function runAsyncScript(body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } catch (e) {
    console.error(errorMessage(e));
    process.exitCode = 1;
  }
}
