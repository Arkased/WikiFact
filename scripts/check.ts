// `npm run check [-- --full] [--verbose]`: takes the check lock, runs the steps for the scope of the change (scripts/lib/check-scope.ts)
// with `run-p`, and frees the lock. Only 1 check runs at a time over all worktrees of the repo
// (docs/code-standard.md#6-tools).
// No library for the lock: the single-instance and lock-file packages on npm are unmaintained (last release 2022) or
// lock with a file and a stale timeout; the lock here is a listening server that the OS frees when the process dies,
// in about 30 lines, so it has no stale state. A separate record of the steps (pid and start time) lets the next
// check kill the tree that a hard-killed wrapper left running. A hard kill in the first second of the steps, before
// the start time is read and the record is written, leaves an orphan that the next check does not find.
// The project runs only on Windows today (docs/requirements/deployment.md), so this script does too.
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:net";
import { join } from "node:path";
import { execa } from "execa";
import fkill from "fkill";
import { z } from "zod";
import { isMain, lowerPriority } from "../eval/lib/main.js";
import { ARGV_USER_OFFSET, EXIT_USAGE } from "../src/constants.js";
import { errnoCode, errorMessage } from "../src/must.js";
import { projectRoot } from "../src/paths.js";
import { describeScope, readScope, stepsOf, type CheckScope } from "./lib/check-scope.js";
import { pipeName, takePipeLock } from "./lib/pipe-lock.js";
import { readProjectName } from "./lib/project-name.js";
import { CHECK_RESULTS_ENV, countResults, readResults, summaryLine, type ResultCounts } from "./lib/quiet-step.js";

/** The flag that runs every test. */
const FULL_FLAG = "--full";

/** The flag that lets each step print all its output as it runs, with no wrapper that captures it. */
const VERBOSE_FLAG = "--verbose";

/** The wait between two looks at a held lock, in milliseconds. */
export const POLL_MS = 3000;

/** The exit code of a check that a signal or a fault in the wrapper stopped. */
const FAILURE_EXIT_CODE = 1;

/** The inputs of `takeLock`; the wait and the log are injected so that a test needs no real wait. */
export interface TakeLockOptions {
  /** The name to listen on, from `lockName`. */
  name: string;
  /** Waits the given milliseconds. */
  sleep: (ms: number) => Promise<void>;
  /** Prints one line. */
  log: (line: string) => void;
}

/**
 * Derives the lock name from the common git folder, so that all worktrees of a repo share one name.
 *
 * @param commonDir - the absolute path of the common git folder
 * @param projectName - the name of the project from `.claude/setup.config.json`
 * @returns the named pipe `\\.\pipe\<project name>-check-<16 hex of the sha256 of the folder>`
 * @sideEffects none
 */
export function lockName(commonDir: string, projectName: string): string {
  return pipeName("check", commonDir, projectName);
}

/**
 * Fails at once off Windows: the project runs on Windows only.
 *
 * @param platform - the platform to test; the platform of this process by default
 * @throws {Error} when the platform is not win32
 * @sideEffects reads the platform of this process
 */
export function assertWindows(platform: string = process.platform): void {
  if (platform !== "win32") throw new Error(`npm run check runs on Windows only (this platform is ${platform})`);
}

/**
 * Takes the check lock by listening on its name, waiting while a live check holds it.
 *
 * @param options - the name, and the injected wait and log
 * @returns the listening server; closing it, or the end of the process, frees the lock
 * @throws {Error} when the server cannot listen for a reason other than that the name is in use
 * @sideEffects listens on a named pipe; waits without a limit, `POLL_MS` between looks; prints one line when it waits
 */
export function takeLock(options: TakeLockOptions): Promise<Server> {
  const { name, sleep, log } = options;
  return takePipeLock({
    name,
    sleep,
    retryMs: POLL_MS,
    onWait: () => log("waiting for the check of another worktree"),
  });
}

// The text that fkill gives for a pid that is already gone.
const GONE_MESSAGE = "Process doesn't exist";

// Tells whether a fault of fkill says only that the processes are already gone.
function isGoneFault(error: unknown): boolean {
  if (!(error instanceof AggregateError)) return false;
  return (error.errors as unknown[]).every((part) => String(part).includes(GONE_MESSAGE));
}

/**
 * Tells whether a process with this pid is alive.
 *
 * @param pid - the process id
 * @returns true when a signal 0 reaches the process
 * @sideEffects none (signal 0 sends nothing)
 */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return errnoCode(error) === "EPERM";
  }
}

/**
 * Stops the tree of a pid. On Ctrl+C Windows sends the signal to the whole console group, so children end while the
 * tree is walked and taskkill fails for some of them; a fault is a fault only when the root is still alive after.
 *
 * @param pid - the root of the tree
 * @param alive - tells whether the root is alive; `isAlive` by default, injected so that a test needs no dead pid
 * @sideEffects kills the tree (`fkill` with `tree`, `taskkill /T /F`); prints to stderr when the root is still alive after
 */
export async function killTree(pid: number, alive: (pid: number) => boolean = isAlive): Promise<void> {
  try {
    await fkill(pid, { tree: true, force: true });
  } catch (error) {
    if (isGoneFault(error) || !alive(pid)) return;
    const detail =
      error instanceof AggregateError
        ? (error.errors as unknown[]).map((part) => errorMessage(part)).join("; ")
        : errorMessage(error);
    console.error(`check: could not stop the steps: ${detail}`);
  }
}

// The record of a running steps process: its pid, and its start time that tells it from a later process of that pid.
// The start is digits only, so a record never carries text into the PowerShell command.
const stepsRecordSchema = z.object({ pid: z.number().int().positive(), start: z.string().regex(/^\d+$/) });

/**
 * Reads the start time of a process, as a string that is the same for the same process.
 *
 * @param pid - the process id
 * @returns the start time (Windows file time, UTC), or undefined when no process has this pid
 * @sideEffects runs PowerShell (`Get-Process`), which takes about a second
 */
export async function readStartTime(pid: number): Promise<string | undefined> {
  const result = await execa(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid}).StartTime.ToFileTimeUtc()`],
    { reject: false },
  );
  const text = result.stdout.trim();
  return result.failed || !/^\d+$/.test(text) ? undefined : text;
}

/**
 * Gives the path of the record file of the steps process, in the common git folder.
 *
 * @param commonDir - the absolute path of the common git folder
 * @returns the path of `wikifact-check-steps.json`
 * @sideEffects none
 */
export function recordPath(commonDir: string): string {
  return join(commonDir, "wikifact-check-steps.json");
}

/**
 * Kills the steps tree that an earlier check left running when its wrapper was killed hard, then deletes the record.
 * A pid whose start time differs from the record is another process and is not killed.
 *
 * @param file - the record file from `recordPath`
 * @param log - prints one line
 * @sideEffects reads and deletes the file; runs PowerShell; kills a process tree (`fkill`); prints one line when it kills
 */
export async function killOrphan(file: string, log: (line: string) => void): Promise<void> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return;
    // A record that cannot be read names no process; it is deleted.
    console.error(`check: could not read the record of the steps, deleting it: ${errorMessage(error)}`);
    await rm(file, { force: true });
    return;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    console.error(`check: the record of the steps is not JSON, deleting it: ${errorMessage(error)}`);
    await rm(file, { force: true });
    return;
  }
  const parsed = stepsRecordSchema.safeParse(json);
  if (!parsed.success) {
    console.error(`check: the record of the steps is not valid, deleting it: ${parsed.error.message}`);
    await rm(file, { force: true });
    return;
  }
  const record = parsed.data;
  if ((await readStartTime(record.pid)) === record.start) {
    log(`killing the steps of an earlier check that are still running (pid ${record.pid})`);
    await killTree(record.pid);
  }
  await rm(file, { force: true });
}

/**
 * Gives the path of the results folder of the steps, in the common git folder.
 *
 * @param commonDir - the absolute path of the common git folder
 * @returns the path of `wikifact-check-results`
 * @sideEffects none
 */
export function resultsPath(commonDir: string): string {
  return join(commonDir, "wikifact-check-results");
}

/**
 * Empties the results folder of the steps, making it when it is missing, so that no result of an earlier check stays.
 * In verbose mode the steps write no result: it makes no folder and returns none.
 *
 * @param commonDir - the absolute path of the common git folder
 * @param verbose - true for the verbose mode
 * @returns the path of the emptied folder, or undefined in verbose mode
 * @sideEffects makes the folder; deletes its files
 */
export async function prepareResults(commonDir: string, verbose: boolean): Promise<string | undefined> {
  if (verbose) return undefined;
  const dir = resultsPath(commonDir);
  await mkdir(dir, { recursive: true });
  await Promise.all((await readdir(dir)).map((name) => rm(join(dir, name), { recursive: true, force: true })));
  return dir;
}

/** The options of `runSteps`. */
export interface RunStepsOptions {
  /** Aborts to stop the steps; `main` aborts it on SIGINT. */
  stop?: AbortSignal;
  /** Where to write the pid and the start time of the steps while they run; deleted when they end. */
  recordFile?: string;
  /** Kills the tree of a pid; `killTree` by default. */
  kill?: (pid: number) => Promise<void>;
  /** Called once, as soon as the steps have exited. */
  onExit?: () => void;
  /** Environment variables to add for the steps. */
  env?: Record<string, string>;
}

/**
 * Runs the steps and waits for them; when the stop signal aborts, the whole tree of the steps is killed first.
 *
 * @param file - the program to run
 * @param args - its arguments
 * @param options - the stop signal, the record file, and the kill function (`killTree` by default) and a callback on exit
 * @returns 1 when a stop came while the steps ran, otherwise the exit code of the steps (1 when it has none); a stop
 *   that comes after the steps exited changes nothing
 * @sideEffects spawns the program with the stdio of this process; writes and deletes the record file; kills the tree of
 *   the program on a stop (`fkill` with `tree`, which runs `taskkill /T /F`); prints to stderr when the root of the
 *   tree is still alive after the kill
 */
export async function runSteps(file: string, args: string[], options: RunStepsOptions = {}): Promise<number> {
  const { stop, recordFile, kill = killTree, onExit, env } = options;
  const child = execa(file, args, { stdio: "inherit", reject: false, ...(env === undefined ? {} : { env }) });
  let stopped = false;
  let killing: Promise<void> = Promise.resolve();
  let exited = false;
  void child.then(() => {
    exited = true;
    onExit?.();
  });
  const onStop = (): void => {
    if (exited) return;
    stopped = true;
    if (child.pid !== undefined) killing = kill(child.pid);
  };
  // A fault of the record is logged and the steps go on; the handler is on the promise at once, so no rejection is unhandled.
  const recording =
    recordFile === undefined || child.pid === undefined
      ? undefined
      : record(recordFile, child.pid).catch((error: unknown) => {
          console.error(`check: could not write the record of the steps: ${errorMessage(error)}`);
        });
  if (stop?.aborted === true) onStop();
  stop?.addEventListener("abort", onStop, { once: true });
  try {
    const result = await child;
    await killing;
    return stopped ? FAILURE_EXIT_CODE : (result.exitCode ?? FAILURE_EXIT_CODE);
  } finally {
    stop?.removeEventListener("abort", onStop);
    await recording;
    if (recordFile !== undefined) await rm(recordFile, { force: true });
  }
}

// Writes the record of a running process; a process that is already gone gets none.
async function record(file: string, pid: number): Promise<void> {
  const start = await readStartTime(pid);
  if (start !== undefined) await writeFile(file, JSON.stringify({ pid, start }));
}

/**
 * Builds the arguments of the `npm` command that runs the steps of a scope at the same time.
 *
 * @param scope - the scope of the change
 * @param verbose - true for the line where each step inherits stdio and prints all its output as it runs
 * @returns when verbose, `exec -- run-p --print-label <step>...`; otherwise `exec -- run-p --aggregate-output
 *   check:step -- <step>...` for each step, where `check:step` (scripts/quiet-step.ts) captures the output of the step
 * @sideEffects none
 */
export function stepsArgs(scope: CheckScope, verbose = false): string[] {
  if (verbose) return ["exec", "--", "run-p", "--print-label", ...stepsOf(scope)];
  return [
    "exec",
    "--",
    "run-p",
    "--silent",
    "--aggregate-output",
    ...stepsOf(scope).map((step) => `check:step -- ${step}`),
  ];
}

/**
 * Chooses the exit code of a quiet check.
 *
 * @param runPExit - the exit code of run-p
 * @param counts - the steps by result
 * @returns the exit code of run-p when it is not 0; else 1 when a step is not finished; else 0
 * @sideEffects none
 */
export function exitCodeOf(runPExit: number, counts: ResultCounts): number {
  if (runPExit !== 0) return runPExit;
  return counts.notFinished > 0 ? FAILURE_EXIT_CODE : 0;
}

async function main(): Promise<void> {
  assertWindows();
  const args = process.argv.slice(ARGV_USER_OFFSET);
  const unknown = args.filter((a) => a !== FULL_FLAG && a !== VERBOSE_FLAG);
  if (unknown.length > 0) {
    console.error(
      `check: unknown argument ${unknown.join(" ")}\nusage: npm run check [-- ${FULL_FLAG}] [${VERBOSE_FLAG}]\n` +
        `  ${FULL_FLAG}: run every test; ${VERBOSE_FLAG}: each step prints all its output as it runs`,
    );
    process.exitCode = EXIT_USAGE;
    return;
  }
  const { stdout } = await execa("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const commonDir = stdout.trim();
  const server = await takeLock({
    name: lockName(commonDir, readProjectName()),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: (line) => console.log(line),
  });
  const stop = new AbortController();
  const abort = (): void => stop.abort();
  // Node on Windows emits no SIGTERM; a hard kill of this process leaves the tree, and the next check kills it.
  process.on("SIGINT", abort);
  try {
    const file = recordPath(commonDir);
    await killOrphan(file, (line) => console.log(line));
    // Read after the wait for the lock: the change may have grown while the check waited.
    const scope = await readScope(args.includes(FULL_FLAG), projectRoot());
    console.log(`check: ${describeScope(scope)}`);
    const verbose = args.includes(VERBOSE_FLAG);
    const resultsDir = await prepareResults(commonDir, verbose);
    const began = performance.now();
    const runPExit = await runSteps("npm", stepsArgs(scope, verbose), {
      stop: stop.signal,
      recordFile: file,
      ...(resultsDir === undefined ? {} : { env: { [CHECK_RESULTS_ENV]: resultsDir } }),
    });
    process.exitCode = runPExit;
    if (resultsDir !== undefined) {
      const counts = countResults(readResults(resultsDir), stepsOf(scope).length);
      console.log(summaryLine(counts, performance.now() - began));
      process.exitCode = exitCodeOf(runPExit, counts);
    }
  } finally {
    process.off("SIGINT", abort);
    server.close();
  }
}

if (isMain(import.meta.url)) {
  lowerPriority();
  main().catch((error: unknown) => {
    console.error(`check: ${errorMessage(error)}`);
    process.exitCode = FAILURE_EXIT_CODE;
  });
}
