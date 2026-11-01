// `npm run eval:all [-- --only <name>] [--skip <name>]... [--continue] [--questions "<args>"] [--replay "<args>"]
//                  [--relevance "<args>"] [--corrections "<args>"] [--speed "<args>"]
//                  [--benefit "--db <copy> | --wiki <name> [--env <name>] --repo <path> --commit <sha>"] [--out <file>]`
//
// The one entry point of the tests of technical/evaluation.md, "Test plan". It runs them in the order questions, relevance, replay,
// corrections, speed (speed beside the questions), then the benefit test when its flags name a wiki, each as a child process of its own npm script, so that the result files and the flags of every test stay as they are.
// It stops at the first failed child unless --continue is set, and writes eval/results/<ISO timestamp>.json with the
// tests that ran, their exit codes, their times and the result file that each one wrote.
//
// Tests replace the npm scripts with the `fakeCommand` option: the child is then `node <script.js> <name> <args...>`.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { enumValues, isMember } from "../src/domain/index.js";
import { errorMessage } from "../src/must.js";
import { parseCommandLine, type ParsedArgs } from "./lib/args.js";
import { EvalTestName, TestStatus } from "./lib/enums.js";
import { isMain, lowerPriority } from "./lib/main.js";
import { relativeToRoot } from "./lib/relative-path.js";
import { required } from "./lib/required-value.js";
import { resultStamp } from "./lib/stamp.js";
import { JSON_INDENT, ARGV_USER_OFFSET, EXIT_USAGE } from "../src/constants.js";

/** The tests in the order they run. */
const TESTS = enumValues(EvalTestName);

const here = dirname(fileURLToPath(import.meta.url));

/** The options of the command line that take a value; each is joined to its value, which may start with `--`. */
const VALUE_OPTIONS = ["only", "skip", "out", ...TESTS];

/** The window before a test started in which a result file still counts as its own, in ms (file time resolution). */
const FILE_TIME_SLACK_MS = 1000;

/** Where each test writes its result files. */
const RESULT_DIRS: Record<EvalTestName, string> = {
  [EvalTestName.Questions]: join("eval", "questions", "results"),
  [EvalTestName.Relevance]: join("eval", "relevance-results"),
  [EvalTestName.Replay]: join("eval", "replay-results"),
  [EvalTestName.Corrections]: join("eval", "corrections", "results"),
  [EvalTestName.Speed]: join("eval", "speed-results"),
  [EvalTestName.Benefit]: join("eval", "benefit-results"),
};

/** Matches a flag string that names a wiki with `--db` or `--wiki`, the condition to run the benefit test. */
const NAMES_A_WIKI = /(^|\s)--(db|wiki)(\s|=)/;

/** The usage line of `npm run eval:all`. */
export const USAGE =
  'npm run eval:all [-- --only <name>] [--skip <name>]... [--continue] [--questions "<args>"] [--relevance "<args>"] [--replay "<args>"] [--corrections "<args>"] [--speed "<args>"] [--benefit "--db <copy> | --wiki <name> [--env <name>] --repo <path> --commit <sha>"] [--out <file>]   (names: questions, relevance, replay, corrections, speed, benefit; benefit runs last and is skipped without --db or --wiki)';

/** The parsed command line of `npm run eval:all`. */
export interface EvalArgs {
  only?: EvalTestName;
  skip: EvalTestName[];
  continueOnFailure: boolean;
  /** The flag string that each test receives. */
  pass: Record<EvalTestName, string>;
  out?: string;
}

/** The start of the name of a command line option. */
const OPTION_PREFIX = "--";

const asName = (v: string | undefined, flag: string): EvalTestName => {
  if (!isMember(EvalTestName, v)) throw new Error(`${flag} takes one of ${TESTS.join(", ")}, not ${v ?? "nothing"}`);
  return v;
};

/**
 * Parses the command line of `npm run eval:all`.
 *
 * @param argv - the arguments after the script name
 * @returns the selection, the pass-through flags of each test and the index file path
 * @throws {Error} with the usage line for an unknown option, a missing value or a bad test name
 * @sideEffects none
 */
export function parseEvalArgs(argv: string[]): EvalArgs {
  // A pass-through value such as "--stub" starts with dashes, so it is joined to its option as `--name=value`.
  const joined: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = required(argv[i], "argv index out of range");
    const next = argv[i + 1];
    if (
      token.startsWith(OPTION_PREFIX) &&
      VALUE_OPTIONS.includes(token.slice(OPTION_PREFIX.length)) &&
      next !== undefined
    ) {
      joined.push(`${token}=${next}`);
      i++;
    } else joined.push(token);
  }
  let parsed: ParsedArgs;
  try {
    parsed = parseCommandLine(joined, {
      flags: ["continue"],
      options: ["only", "out", ...TESTS],
      repeatable: ["skip"],
    });
  } catch (e) {
    throw new Error(`${errorMessage(e)}\nusage: ${USAGE}`, { cause: e });
  }
  const only = parsed.options.get("only");
  const a: EvalArgs = {
    skip: (parsed.lists.get("skip") ?? []).map((v) => asName(v, "--skip")),
    continueOnFailure: parsed.flags.has("continue"),
    pass: Object.fromEntries(TESTS.map((name) => [name, parsed.options.get(name) ?? ""])) as Record<
      EvalTestName,
      string
    >,
    out: parsed.options.get("out"),
  };
  if (only !== undefined) a.only = asName(only, "--only");
  if (parsed.positionals.length > 0) throw new Error(`unknown argument ${parsed.positionals[0]}\nusage: ${USAGE}`);
  return a;
}

/**
 * Splits a flag string like a shell would, with single and double quotes.
 *
 * @param s - the flag string
 * @returns the words, quotes removed
 * @sideEffects none
 */
export function splitArgs(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (let m = re.exec(s); m; m = re.exec(s)) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  return out;
}

/** What happened to one test. */
export interface TestRun {
  name: EvalTestName;
  /** "ran", or "skipped" (by --skip or --only), or "not run" (an earlier test failed). */
  status: TestStatus;
  command?: string;
  exitCode?: number | null;
  startedAt?: string;
  finishedAt?: string;
  /** The result file that the test wrote, from its output or from the newest file of its folder; relative to the project root, with forward slashes. */
  resultFile?: string | null;
}

/** The index file of a run: the tests, in order. */
export interface EvalIndex {
  startedAt: string;
  finishedAt?: string;
  complete: boolean;
  /** True when every test that ran exited 0. */
  ok?: boolean;
  args: { only?: string; skip: string[]; continueOnFailure: boolean; pass: Record<string, string> };
  tests: TestRun[];
}

/**
 * Finds the path in the last "results written to X" or "results: X" line of a test's output.
 *
 * @param out - the output of a child
 * @returns the path, or null when no line names one
 * @sideEffects none
 */
export function resultFileFromOutput(out: string): string | null {
  let found: string | null = null;
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s*results(?: written to|:)\s+(.+?)\s*$/.exec(line);
    if (m) found = m[1] ?? found;
  }
  return found;
}

/**
 * Finds the newest .json file of a folder that is not older than `since`.
 *
 * @param dir - the folder
 * @param since - a time in ms since the epoch; a file may be up to one second older
 * @returns the path, or null when the folder is missing or has no such file
 * @sideEffects reads the file system
 */
export function newestResult(dir: string, since: number): string | null {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((n) => n.endsWith(".json") && !n.startsWith("summary-"))
    .map((n) => ({ p: join(dir, n), t: statSync(join(dir, n)).mtimeMs }))
    .filter((f) => f.t >= since - FILE_TIME_SLACK_MS)
    .sort((a, b) => b.t - a.t);
  return files[0]?.p ?? null;
}

/** The options of `runEvals`. */
export interface RunOptions {
  args: EvalArgs;
  /** The project root: where the npm scripts run and the result folders are. */
  root?: string;
  /** Where the index file goes. Default: <root>/eval/results/<ISO timestamp>.json. */
  outPath?: string;
  /** Replaces the npm scripts: the child is `node <script> <name> <args...>`. Default: the npm scripts. */
  fakeCommand?: string;
  print?: (s: string) => void;
}

/** The inputs of `runChild`. */
interface ChildJob {
  name: EvalTestName;
  /** The flags of the test. */
  extra: string[];
  /** The run options, for `fakeCommand` and `print`. */
  options: RunOptions;
  root: string;
  /** Put before every line of output, so that tests running in parallel can be told apart. */
  prefix?: string;
}

/** What a child left behind. */
interface ChildResult {
  code: number | null;
  out: string;
  command: string;
}

// Quotes an argument for the shell of `npm run`, when it holds a space or a quote.
const shellQuote = (a: string): string => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);

/**
 * Builds the arguments of `npm` that run the script of one test.
 *
 * @param name - the test
 * @param extra - the flags for the test
 * @returns the arguments after `npm`
 * @sideEffects none
 */
export function npmArgs(name: EvalTestName, extra: string[]): string[] {
  return ["run", `eval:${name}`, "--", ...extra.map(shellQuote)];
}

/**
 * Runs one test as a child process and collects its output.
 *
 * @param job - the test, its flags, the run options, the project root and the output prefix
 * @returns the exit code (null when the child could not start), the combined output and the command line
 * @sideEffects starts a child process; writes the child's output through `print`
 */
function runChild(job: ChildJob): Promise<ChildResult> {
  const { name, extra, options, root, prefix = "" } = job;
  const fake = options.fakeCommand;
  const cmd = fake ? process.execPath : "npm";
  const argv = fake ? [fake, name, ...extra] : npmArgs(name, extra);
  const command = `${cmd} ${argv.join(" ")}`;
  const print = options.print ?? ((s: string) => process.stdout.write(s));
  return new Promise((resolveP) => {
    const child = spawn(cmd, argv, { cwd: root, shell: !fake, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    const tee = (d: Buffer): void => {
      out += String(d);
      print(prefix ? String(d).replace(/^(?=.)/gm, prefix) : String(d));
    };
    child.stdout.on("data", tee);
    child.stderr.on("data", tee);
    child.on("error", (e) => resolveP({ code: null, out: out + String(e), command }));
    child.on("close", (code) => resolveP({ code, out, command }));
  });
}

/**
 * Runs the tests in order, writes the index file after each one, and returns it.
 *
 * @param o - the arguments, the root, the index path, the fake command and the output function
 * @returns the index as written to the file
 * @sideEffects starts child processes (the npm scripts of the tests); writes the index file after every test; prints
 */
export async function runEvals(o: RunOptions): Promise<EvalIndex> {
  const root = o.root ?? resolve(here, "..");
  const { args } = o;
  const startedAt = new Date().toISOString();
  const outPath = o.outPath ?? args.out ?? join(root, "eval", "results", `${resultStamp(new Date(startedAt))}.json`);
  const log = o.print ?? ((s: string) => process.stdout.write(s));
  const index: EvalIndex = {
    startedAt,
    complete: false,
    args: { only: args.only, skip: args.skip, continueOnFailure: args.continueOnFailure, pass: args.pass },
    tests: TESTS.map((name) => ({ name, status: TestStatus.NotRun })),
  };
  const flush = (): void => {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(index, null, JSON_INDENT) + "\n");
  };
  flush();

  let stopped = false;
  const selected = (name: EvalTestName): boolean =>
    !((args.only !== undefined && args.only !== name) || args.skip.includes(name));
  for (const [i, name] of TESTS.entries()) if (!selected(name)) index.tests[i] = { name, status: TestStatus.Skipped };

  const runOne = async (i: number, parallel: boolean): Promise<void> => {
    const name = required(TESTS[i], "test index out of range");
    log(`\n=== ${name}${parallel ? " (in parallel)" : ""} ===\n`);
    const t0 = Date.now();
    const started = new Date(t0).toISOString();
    const r = await runChild({
      name,
      extra: splitArgs(args.pass[name]),
      options: o,
      root,
      prefix: parallel ? `[${name}] ` : "",
    });
    const found = resultFileFromOutput(r.out) ?? newestResult(join(root, RESULT_DIRS[name]), t0);
    const resultFile = found === null ? null : relativeToRoot(resolve(root, found), root);
    index.tests[i] = {
      name,
      status: TestStatus.Ran,
      command: r.command,
      exitCode: r.code,
      startedAt: started,
      finishedAt: new Date().toISOString(),
      resultFile,
    };
    flush();
    if (r.code !== 0) {
      log(`\n${name} exited ${r.code}${args.continueOnFailure || parallel ? ", continuing" : ", stopping"}\n`);
      if (!args.continueOnFailure && !parallel) stopped = true;
    }
  };

  // The speed test makes no model call, so it runs beside the question sets. Relevance, replay and corrections wait
  // for the questions, in that order: relevance and replay both load the embedding model, so they do not overlap,
  // and replay and corrections read the model choice of the question sets.
  const speed = TESTS.indexOf(EvalTestName.Speed);
  const speedRun = selected(EvalTestName.Speed) ? runOne(speed, true) : Promise.resolve();
  for (const [i, name] of TESTS.slice(0, speed).entries()) {
    if (!selected(name) || stopped) continue; // stays "skipped" or "not run"
    await runOne(i, false);
  }
  await speedRun;
  // The speed test ran beside the others, so its failure could not stop them; it stops the tests that follow.
  const speedRan = index.tests[speed];
  if (!args.continueOnFailure && speedRan?.status === TestStatus.Ran && speedRan.exitCode !== 0) stopped = true;
  // The tests after the speed test run alone, in order. The benefit test needs the copy of a wiki and costs about 192
  // agent runs, so it is skipped when its flags give no `--db` and no `--wiki`.
  for (const [i, name] of TESTS.entries()) {
    if (i <= speed || !selected(name) || stopped) continue;
    if (name === EvalTestName.Benefit && args.only === undefined && !NAMES_A_WIKI.test(args.pass[name])) {
      index.tests[i] = { name, status: TestStatus.Skipped };
      continue;
    }
    await runOne(i, false);
  }
  index.ok = index.tests.filter((t) => t.status === TestStatus.Ran).every((t) => t.exitCode === 0);
  index.complete = true;
  index.finishedAt = new Date().toISOString();
  flush();
  log(`\nindex written to ${outPath}\n`);
  return index;
}

async function main(): Promise<void> {
  let args: EvalArgs;
  try {
    args = parseEvalArgs(process.argv.slice(ARGV_USER_OFFSET));
  } catch (e) {
    console.error(errorMessage(e));
    process.exitCode = EXIT_USAGE;
    return;
  }
  const idx = await runEvals({ args });
  process.exitCode = idx.ok ? 0 : 1;
}

if (isMain(import.meta.url)) {
  lowerPriority();
  main().catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  });
}
