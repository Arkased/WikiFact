// One step of `npm run check` with its output captured (#52; docs/code-standard.md, section 6, the bullet of `npm run check`). `run-p` starts each step through scripts/quiet-step.ts, which
// calls `runQuietStep`: a passing step prints 1 line, a failing step prints its whole output and 1 line. `run-p` runs with
// `--aggregate-output`, so the block of a step is written when the step ends and no 2 blocks interleave. Each step also
// writes its result to a file of its own in the folder that `CHECK_RESULTS_ENV` names, and scripts/check.ts reads the folder for
// the summary line.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";

/** The environment variable that names the folder where each step writes its result file. */
export const CHECK_RESULTS_ENV = "WIKIFACT_CHECK_RESULTS";

/** The result of one step. */
export interface StepOutcome {
  /** The output of the step, stdout and stderr in the order they arrived. */
  output: string;
  /** The exit code of the step; 1 when it has none. */
  exitCode: number;
}

/** The inputs of `runQuietStep`; the launch, the write, the clock and the results folder are injected so that a test needs no process and no wall clock. */
export interface QuietStepOptions {
  /** Runs the step with its output captured. */
  launch: (step: string) => Promise<StepOutcome>;
  /** Writes text to the output. */
  write: (text: string) => void;
  /** Gives the time in milliseconds. */
  now: () => number;
  /** The folder where the step writes its result file; none when undefined. */
  resultsDir?: string | undefined;
}

const MS_PER_SECOND = 1000;

/**
 * Formats a span with 1 decimal.
 *
 * @param ms - the span in milliseconds
 * @returns the seconds, such as `12.3`
 * @sideEffects none
 */
function seconds(ms: number): string {
  return (ms / MS_PER_SECOND).toFixed(1);
}

/**
 * Gives the name of a step for the output: the npm script, without the arguments that follow ` -- `.
 *
 * @param step - the step, such as `test:related -- a.ts b.ts`
 * @returns the script name, such as `test:related`
 * @sideEffects none
 */
function stepName(step: string): string {
  return step.split(" -- ")[0] ?? step;
}

/**
 * Runs one step and prints its result: 1 line when it passes, its output and 1 line when it fails.
 *
 * @param step - the step, an npm script with its arguments after ` -- `
 * @param options - the launch, the write, the clock and the results folder
 * @returns the exit code of the step
 * @sideEffects calls `launch`; calls `write` once; writes 1 result file (named by the pid of this process) to the results folder when given
 */
export async function runQuietStep(step: string, options: QuietStepOptions): Promise<number> {
  const { launch, write, now, resultsDir } = options;
  const start = now();
  const { output, exitCode } = await launch(step);
  const took = seconds(now() - start);
  const name = stepName(step);
  if (exitCode === 0) {
    write(`pass ${name} (${took} s)\n`);
  } else {
    const body = output === "" || output.endsWith("\n") ? output : `${output}\n`;
    write(`${body}FAIL ${name} (${took} s, exit ${exitCode})\n`);
  }
  if (resultsDir !== undefined)
    writeFileSync(join(resultsDir, `${process.pid}.txt`), `${exitCode === 0 ? "pass" : "FAIL"}\n`);
  return exitCode;
}

/**
 * Runs one step as `npm run <script> [-- <arguments>]` and captures stdout and stderr into 1 buffer.
 *
 * @param step - the step
 * @returns the output and the exit code
 * @sideEffects spawns npm
 */
export async function launchStep(step: string): Promise<StepOutcome> {
  const [script = "", ...rest] = step.split(" ");
  const result = await execa("npm", ["run", "--silent", script, ...rest], { all: true, reject: false });
  return { output: result.all, exitCode: result.exitCode ?? 1 };
}

/** The count of the steps by result. */
export interface ResultCounts {
  passed: number;
  failed: number;
  /** The steps of the scope that wrote no result: run-p stopped them, their wrapper died, or Ctrl+C stopped the check. */
  notFinished: number;
}

/**
 * Reads the result files of the steps.
 *
 * @param resultsDir - the results folder
 * @returns the content of all result files joined: 1 line per step that ended, `pass` or `FAIL`
 * @sideEffects reads the folder
 */
export function readResults(resultsDir: string): string {
  return readdirSync(resultsDir)
    .map((name) => readFileSync(join(resultsDir, name), "utf8"))
    .join("");
}

/**
 * Counts the steps by result.
 *
 * @param results - the content of the result files from `readResults`: 1 line per step that ended, `pass` or `FAIL`
 * @param total - the number of steps of the scope
 * @returns the passed, failed and not finished steps
 * @sideEffects none
 */
export function countResults(results: string, total: number): ResultCounts {
  const lines = results.split("\n").filter((line) => line !== "");
  const passed = lines.filter((line) => line === "pass").length;
  return { passed, failed: lines.length - passed, notFinished: Math.max(0, total - lines.length) };
}

/**
 * Builds the summary line from the counts.
 *
 * @param counts - from `countResults`
 * @param ms - the time of the whole check in milliseconds
 * @returns `check: <n> passed, <m> failed[, <k> not finished] (<seconds> s)`; the part on `k` shows only when `k` is more than 0
 * @sideEffects none
 */
export function summaryLine(counts: ResultCounts, ms: number): string {
  const { passed, failed, notFinished } = counts;
  const unfinished = notFinished > 0 ? `, ${notFinished} not finished` : "";
  return `check: ${passed} passed, ${failed} failed${unfinished} (${seconds(ms)} s)`;
}
