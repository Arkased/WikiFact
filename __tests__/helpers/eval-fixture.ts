// A fixture for the tests of eval/all.ts: a temp root, the fake eval child and the log of its calls.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";
import { parseEvalArgs, runEvals, type EvalArgs, type EvalIndex, type TestRun } from "../../eval/all.js";
import type { EvalTestName } from "../../eval/lib/enums.js";

const fake = join(import.meta.dirname, "fake-eval.mjs");

/** One line of the call log that fake-eval.mjs writes. */
interface CallLine {
  name: EvalTestName;
  args: string[];
  end?: boolean;
}

/** The accessors of `useEvalFixture`. */
export interface EvalFixture {
  /** The root folder of the current test. */
  root: () => string;
  /** The starts of the children, in the order they started. */
  calls: () => CallLine[];
  /** Reads an index file. */
  readIndex: (path: string) => EvalIndex;
  /** The test of the index with this name; throws when the run did not list it. */
  testOf: (idx: EvalIndex, name: EvalTestName) => TestRun;
  /** The names of the children that started, sorted. */
  started: () => EvalTestName[];
  /** The names, sorted. */
  sorted: (...names: EvalTestName[]) => EvalTestName[];
  /** The position of the start or the end line of a child in the call log: the order of events, not a time. */
  position: (name: EvalTestName, end: boolean) => number;
  /** Runs `eval/all.ts` with the fake children; `evals` is what the fake child does for each eval. */
  run: (argv: string[], evals?: object) => Promise<{ idx: EvalIndex; out: string }>;
  /** Forgets the calls so far. */
  reset: () => void;
}

/**
 * Registers the setup and the teardown of an eval/all.ts test and gives its accessors. Call it inside a `describe`
 * or at the top of a test file.
 *
 * @returns the root folder, the call log readers, the index reader and `run`
 * @sideEffects registers `beforeEach` and `afterEach` hooks; each test makes a temp folder and sets `FAKE_LOG`,
 *   `FAKE_ROOT` and `FAKE_EVALS` in `process.env`, and the teardown restores the environment
 */
export function useEvalFixture(): EvalFixture {
  const saved = { ...process.env };
  let root = "";
  let log = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "evals-"));
    log = join(root, "calls.jsonl");
    process.env.FAKE_LOG = log;
    process.env.FAKE_ROOT = root;
    delete process.env.FAKE_EVALS;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  const lines = (): CallLine[] =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as CallLine)
      : [];
  // The starts of the children, in the order they started.
  const calls = (): CallLine[] => lines().filter((c) => !c.end);
  const readIndex = (path: string): EvalIndex => JSON.parse(readFileSync(path, "utf8")) as EvalIndex;
  // The test of the index file with this name; throws when the run did not list it.
  const testOf = (idx: EvalIndex, name: EvalTestName): TestRun => {
    const t = idx.tests.find((x) => x.name === name);
    if (!t) throw new Error(`no test ${name}`);
    return t;
  };
  // The names of the children that started, sorted by name so that the start order does not matter.
  const started = (): EvalTestName[] =>
    calls()
      .map((c) => c.name)
      .sort();
  const sorted = (...names: EvalTestName[]): EvalTestName[] => [...names].sort();
  // The position of the start or the end line of a child in the call log: the order of events, not a time.
  const position = (name: EvalTestName, end: boolean): number => {
    const i = lines().findIndex((x) => x.name === name && !!x.end === end);
    if (i < 0) throw new Error(`no ${end ? "end" : "start"} line for ${name}`);
    return i;
  };
  const run = async (argv: string[], evals: object = {}): Promise<{ idx: EvalIndex; out: string }> => {
    process.env.FAKE_EVALS = JSON.stringify(evals);
    const args: EvalArgs = parseEvalArgs(argv);
    const out = join(root, "eval", "results", "index.json");
    const idx = await runEvals({ args, root, outPath: out, fakeCommand: fake, print: () => undefined });
    return { idx, out };
  };

  // Forgets the calls so far, so that one test can run the command more than once and read each run alone.
  const reset = (): void => rmSync(log, { force: true });

  return { root: () => root, calls, readIndex, testOf, started, sorted, position, run, reset };
}
