// Runs the sets through one pool and writes the result file as configurations complete.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { QuestionId } from "../../src/domain/index.js";
import type { Transport } from "../../src/updates/index.js";
import { CaseGroup, HardNegativeKind, ResultStage } from "../lib/enums.js";
import type { Score } from "./accuracy.js";
import { AdaptivePool, type PoolOptions } from "../lib/pool.js";
import { selectedConfigs, type ConfigSelection } from "./configs.js";
import { firstRunMean, makeConfigRun, resultOf, runStage, type ConfigRun, type GroupResult } from "./engine.js";
import { MODELS, takesEffort, type PassBar } from "./models.js";
import { currentPromptHash } from "./prompt-hash.js";
import {
  barOf,
  barText,
  describeQuestion,
  entryKey,
  intervalText,
  percentText,
  type Entry,
  type ResultFile,
} from "./results.js";
import { loadSet } from "./sets.js";
import { JSON_INDENT, COST_DECIMALS } from "../../src/constants.js";

/** The slack of the staging bar when models.json names none, in accuracy (0..1). */
const DEFAULT_STAGING_SLACK = 0.05;
/** The first lines of a failing configuration that are printed. */
const MISSES_PRINTED = 4;
/** The characters of a miss that are printed. */
const MISS_CHARS = 220;

/** What `runSets` needs from the command line. */
export interface RunSetsArgs extends ConfigSelection {
  qs: QuestionId[];
  runs: number;
  limit?: number;
  /** Model calls in flight at the start. */
  concurrency: number;
  /** No staging: every run of every configuration at once. */
  full?: boolean;
  /** Settings of the pool, for the tests. */
  pool?: Partial<PoolOptions>;
}

/** A result file to continue from. */
export interface ResumeFrom {
  file: ResultFile;
  path: string;
}

/** Where `runSets` sends its calls and its output. */
export interface RunTarget {
  transport: Transport;
  /** The name of the transport, written to the result file. */
  transportName: string;
  /** The result file to write. */
  outPath: string;
  /** Receives each line of the report. Default: `console.log`. */
  print?: (s: string) => void;
  resume?: ResumeFrom;
}

/**
 * Gives the first-run mean under which a configuration gets no more runs: the lowest bar of the question
 * (the pass bar or the economy bar of models.json) less the slack.
 *
 * @param q - the question id
 * @returns an accuracy, 0..1
 * @sideEffects none
 */
export function stageThreshold(q: string): number {
  const { economyBar, passBar } = MODELS;
  const floorBar: PassBar = { ...passBar, strict: economyBar.strict, mean: economyBar.mean, minRun: economyBar.minRun };
  return Math.min(barOf(q).mean, barOf(q, floorBar).mean) - (MODELS.staging?.slack ?? DEFAULT_STAGING_SLACK);
}

interface RunState {
  args: RunSetsArgs;
  target: RunTarget;
  print: (s: string) => void;
  staged: boolean;
  pool: AdaptivePool;
  file: ResultFile;
  done: Map<string, Entry>;
}

const caseCount = (q: QuestionId, limit: number | undefined): number => loadSet(q).cases.slice(0, limit).length;

/** The widths of the columns of the result table, in characters. */
const QUESTION_WIDTH = 9;
const MODEL_WIDTH = 21;
const EFFORT_WIDTH = 8;
const RUN_ACCURACY_WIDTH = 26;
const ERRORS_WIDTH = 6;
const UNSTABLE_WIDTH = 8;
const INTERVAL_WIDTH = 13;

const rowLabel = (c: { q: string; model: string; effort: string; effortSent: boolean }): string =>
  `${c.q.padEnd(QUESTION_WIDTH)} ${c.model.padEnd(MODEL_WIDTH)} ${(c.effortSent ? c.effort : `${c.effort}*`).padEnd(EFFORT_WIDTH)}`;

// Writes the result file as it stands: the pool counters, the summary lines, then the JSON.
function flush(s: RunState): void {
  const { file, pool, args } = s;
  file.pool.rateLimitRetries = pool.rateLimitRetries;
  file.pool.transientRetries = pool.transientRetries;
  file.pool.firstTransientText = pool.firstTransientText;
  file.pool.firstRateLimitText = pool.firstRateLimitText;
  file.summary = args.qs.flatMap((q) => {
    const es = file.results.filter((e) => e.question === q && e.cases === caseCount(q, args.limit));
    return es.length ? describeQuestion(q, es) : [];
  });
  mkdirSync(dirname(s.target.outPath), { recursive: true });
  writeFileSync(s.target.outPath, JSON.stringify(file, null, JSON_INDENT) + "\n");
}

// Chooses the configurations to run, and prints one line for each that the resumed file already holds.
function planConfigs(s: RunState, transport: Transport): ConfigRun[] {
  const { args, print } = s;
  const cfgs: ConfigRun[] = [];
  print(
    "question  model                 effort   mean    95% interval  per run                    errors  unstable  cost    wall p50/p95 (api p50)",
  );
  for (const q of args.qs) {
    const nCases = caseCount(q, args.limit);
    for (const settings of selectedConfigs(q, args)) {
      const effortSent = takesEffort(settings.model);
      const old = s.done.get(entryKey({ question: q, model: settings.model, effort: settings.effort, effortSent }));
      const label = rowLabel({ q, model: settings.model, effort: settings.effort, effortSent });
      if (old?.cases === nCases && old.runs >= args.runs) {
        print(`${label} skipped: already in the resumed file (${percentText(old.mean).trim()})`);
        continue;
      }
      if (old?.cases === nCases && s.staged && old.mean < stageThreshold(q)) {
        print(
          `${label} skipped: the resumed file has ${old.runs} run(s) at ${percentText(old.mean).trim()}, below the staging bar`,
        );
        continue;
      }
      cfgs.push(makeConfigRun(q, settings, transport, { limit: args.limit }));
    }
  }
  return cfgs;
}

// A score as the report prints it: the cases, the mean and its 95% interval.
const scoreText = (x: Score): string => `${x.cases} cases, ${percentText(x.mean).trim()} ${intervalText(x.ci)}`;
const missedText = (x: GroupResult): string => (x.missed.length ? `, missed ${x.missed.join(", ")}` : "");

const ms = (n: number | null): string => (n === null ? "-" : String(Math.round(n)));

// Adds the entry of a configuration to the file, writes the file and prints the line of the configuration.
function record(s: RunState, c: ConfigRun, stage: ResultStage): void {
  const r = resultOf(c);
  const effortSent = takesEffort(c.settings.model);
  const entry: Entry = {
    question: c.q,
    model: c.settings.model,
    effort: c.settings.effort,
    effortSent,
    cases: c.cases.length,
    runs: c.runsDone,
    stage,
    runAccuracy: r.runAccuracy,
    mean: r.mean,
    ci: r.ci,
    casePassRate: r.casePassRate,
    allRunsPass: r.allRunsPass,
    unstable: r.unstable,
    failing: r.failing,
    groups: r.groups,
    ...(r.kinds ? { kinds: r.kinds } : {}),
    ...(r.halves ? { halves: r.halves } : {}),
    errors: r.errors,
    usage: r.tokens,
    cache: r.cache,
    costEstimateUsd: r.cost,
    latency: r.latency,
    startedAt: c.startedAt,
    finishedAt: new Date().toISOString(),
    promptHash: currentPromptHash(c.q),
  };
  const key = entryKey(entry);
  s.file.results = s.file.results.filter((e) => entryKey(e) !== key);
  s.file.results.push(entry);
  s.done.set(key, entry);
  flush(s);
  const { print } = s;
  print(
    `${rowLabel({ q: c.q, model: c.settings.model, effort: c.settings.effort, effortSent })} ${percentText(r.mean)}  ${intervalText(r.ci).padEnd(INTERVAL_WIDTH)} ${r.runAccuracy.map(percentText).join(" ").padEnd(RUN_ACCURACY_WIDTH)} ${String(r.errors).padStart(ERRORS_WIDTH)}  ${String(r.unstable.length).padStart(UNSTABLE_WIDTH)}  ${r.cost.toFixed(COST_DECIMALS)}  ${ms(r.latency.wallMs.p50)}/${ms(r.latency.wallMs.p95)} (${ms(r.latency.apiMs.p50)}) ms, stage ${stage}, ${c.runsDone} run(s)`,
  );
  // The groups print only when the set has more than the designed one.
  const groups = Object.entries(r.groups) as [CaseGroup, GroupResult][];
  if (groups.some(([g]) => g !== CaseGroup.Designed)) {
    for (const [g, x] of groups) print(`    group ${g}: ${scoreText(x)}${missedText(x)}`);
  }
  // The kinds of hard negatives print under the groups, only when the set names a kind.
  for (const [k, x] of Object.entries(r.kinds ?? {}) as [HardNegativeKind, GroupResult][])
    print(`    kind ${k}: ${scoreText(x)}${missedText(x)}`);
  if (r.halves) print(`    held-out half: ${scoreText(r.halves.heldOut)}; tuning half: ${scoreText(r.halves.tuning)}`);
  for (const f of r.failing.slice(0, MISSES_PRINTED)) print(`    miss ${f.slice(0, MISS_CHARS)}`);
  if (r.unstable.length) print(`    unstable (F23): ${r.unstable.join(", ")}`);
}

const range = (a: number, b: number): number[] => Array.from({ length: Math.max(0, b - a) }, (_, i) => a + i);

function startState(args: RunSetsArgs, target: RunTarget): RunState {
  const print = target.print ?? console.log;
  const staged = !args.full && args.runs > 1;
  print(
    `transport: ${target.transportName}, concurrency ${args.concurrency}, ${staged ? `staged: 1 run for every configuration, then ${args.runs - 1} more for those near or above the bar` : `${args.runs} run(s) each, no staging`}`,
  );
  const pool = new AdaptivePool({
    ...args.pool,
    start: args.concurrency,
    onFirstRateLimit: (text) =>
      print(`rate limit: the first one said ${JSON.stringify(text)}; halving the limit and retrying`),
  });
  const file: ResultFile = {
    startedAt: new Date().toISOString(),
    complete: false,
    transport: target.transportName,
    runs: args.runs,
    staged,
    limit: args.limit,
    resumedFrom: target.resume?.path,
    bar: MODELS.passBar,
    pool: { start: args.concurrency, limitHistory: pool.history, rateLimitRetries: 0 },
    results: target.resume ? [...target.resume.file.results] : [],
    summary: [],
  };
  return { args, target, print, staged, pool, file, done: new Map(file.results.map((e) => [entryKey(e), e])) };
}

/**
 * Runs the sets through one pool, prints a line per configuration, and writes the JSON file as configurations complete.
 * With more than one run and no `full`, the first stage makes 1 run of every configuration and the second stage the
 * other runs of those whose first-run mean is at the staging bar or above.
 *
 * @param args - the questions, the models and efforts, the runs, the limit and the concurrency
 * @param target - the transport, the output file, the print function and the file to resume from
 * @returns the result file, complete
 * @sideEffects model calls through the transport; writes the result file `target.outPath` after each configuration; prints through `target.print`
 */
export async function runSets(args: RunSetsArgs, target: RunTarget): Promise<ResultFile> {
  const s = startState(args, target);
  flush(s);
  const cfgs = planConfigs(s, target.transport);
  await runStage(cfgs, s.staged ? [0] : range(0, args.runs), s.pool, (c) =>
    record(s, c, s.staged ? ResultStage.One : ResultStage.Full),
  );
  if (s.staged) {
    const more = cfgs.filter((c) => firstRunMean(c) >= stageThreshold(c.q));
    s.print(
      `\nstage 2: ${more.length} configurations get ${args.runs - 1} more run(s); ${cfgs.length - more.length} stay at 1 run (first-run mean under the staging bar)`,
    );
    await runStage(more, range(1, args.runs), s.pool, (c) => record(s, c, ResultStage.Two));
  }
  s.print("\nSummary (* means the effort was not sent)");
  s.print(barText());
  for (const line of s.file.summary) s.print(line);
  s.print(
    `pool: start ${s.pool.start}, ${s.pool.history.length - 1} limit change(s), ${s.pool.rateLimitRetries} rate-limit retries, ${s.pool.transientRetries} transient retries`,
  );
  s.file.complete = true;
  s.file.finishedAt = new Date().toISOString();
  flush(s);
  s.print(`\nresults written to ${target.outPath}`);
  return s.file;
}
