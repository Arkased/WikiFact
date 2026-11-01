// The result files: their types, how they are read, and the pass bar that judges their entries.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { REMOVED_QUESTION_IDS } from "../../src/constants.js";
import { Effort, QuestionId, isMember } from "../../src/domain/index.js";
import { CaseGroup, HardNegativeKind, ResultStage } from "../lib/enums.js";
import { resultStamp } from "../lib/stamp.js";
import type { Halves, Score } from "./accuracy.js";
import type { GroupResult, Latency } from "./engine.js";
import { MODELS, byCost, type PassBar } from "./models.js";

/** The folder of the result files. */
export const RESULTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "results");

/** The tolerance of a comparison between two accuracies. */
const EPSILON = 1e-9;
const PERCENT = 100;
/** A bar prints in percent with one decimal: the accuracy times 1000 is rounded, then divided by 10. */
const PERMILLE = 1000;
const PERMILLE_PER_PERCENT = 10;

/** A score as a result file holds it: the interval is absent in files from before it. */
export type Stored<T extends { ci: [number, number] }> = Omit<T, "ci"> & { ci?: [number, number] };

/** The result of one configuration (question, model, effort) over its runs. */
export interface Entry {
  question: QuestionId;
  model: string;
  effort: Effort;
  /** False for Haiku 4.5: effort is in the config but not sent. */
  effortSent: boolean;
  cases: number;
  /** The runs that actually happened. */
  runs: number;
  /** One: only the first stage ran. Two: the second stage added the other runs. Full: no staging. */
  stage?: ResultStage;
  /** Accuracy per run: the share of cases right. */
  runAccuracy: number[];
  mean: number;
  /** The 95% Wilson interval of the mean over all answers of the runs. Absent in files from before it (so are the `ci` of the scores below). */
  ci?: [number, number];
  /** The share of runs in which each case was right, by case id. Absent in files from before it. */
  casePassRate?: Record<string, number>;
  allRunsPass: boolean;
  unstable: string[];
  failing: string[];
  /** Per group of cases: the cases, the mean over the runs and the ids missed. Absent in files from before the groups. */
  groups?: Partial<Record<CaseGroup, Stored<GroupResult>>>;
  /** Per kind of hard negative: the same as a group. Absent for a set that names no kind. */
  kinds?: Partial<Record<HardNegativeKind, Stored<GroupResult>>>;
  /** The score of the held-out half and of the tuning half. Absent for a set with no held-out case. `runs` is set by the pool: the runs of the entries that hold the split. */
  halves?: { [K in keyof Halves]: Stored<Score> } & { runs?: number };
  errors: number;
  usage: { input: number; output: number };
  /** The cache tokens inside `usage.input`, summed over the calls. Absent in files from before it. */
  cache?: { read: number; write: number };
  costEstimateUsd: number;
  /** Queue wait, child wall time, API time and the overhead (wall minus API): p50 and p95, over all runs and per run. */
  latency?: Latency;
  startedAt: string;
  finishedAt: string;
  /** Hash of the question's system prompt and output schema when it ran (`promptHashOf`). Absent in files from before it. */
  promptHash?: string;
}

/** The state of the adaptive pool at the end of a run. */
interface PoolRecord {
  start: number;
  /** The limit over time; `t` in ms. */
  limitHistory: { t: number; limit: number }[];
  rateLimitRetries: number;
  firstRateLimitText?: string;
  transientRetries?: number;
  firstTransientText?: string;
}

/** A result file: one run of the runner. */
export interface ResultFile {
  startedAt: string;
  finishedAt?: string;
  /** False until the run ends; a file from a run that was stopped early stays false. */
  complete: boolean;
  transport: string;
  /** The runs requested. Each entry says how many happened. */
  runs: number;
  staged?: boolean;
  limit?: number;
  /** The adaptive pool: the start value, the limit over time ({t} in ms), and the rate-limit retries. */
  pool: PoolRecord;
  /** The file this run resumed from. */
  resumedFrom?: string;
  /** The pass bar of the run, from models.json. */
  bar: PassBar;
  results: Entry[];
  summary: string[];
}

const stat = z.object({ p50: z.number().nullable(), p95: z.number().nullable() });
const latencyShape = { calls: z.number(), queueMs: stat, wallMs: stat, apiMs: stat, overheadMs: stat };
const latency = z.object({ ...latencyShape, perRun: z.array(z.object({ run: z.number(), ...latencyShape })) });

// The interval is absent in files from before it.
const interval = z.tuple([z.number(), z.number()]).optional();
const groupResult = z.object({ cases: z.number(), mean: z.number(), ci: interval, missed: z.array(z.string()) });
const halfScore = z.object({ cases: z.number(), mean: z.number(), ci: interval });

// The files hold the stage as 1, 2 or "full" (older files) or as the enum value, so it is parsed apart from the rest.
// An entry keeps the keys that this schema does not name, so that a resumed run writes them back.
const entrySchema = z.looseObject({
  question: z.enum(QuestionId),
  model: z.string(),
  effort: z.enum(Effort),
  effortSent: z.boolean(),
  cases: z.number(),
  runs: z.number(),
  stage: z.unknown().optional(),
  runAccuracy: z.array(z.number()),
  mean: z.number(),
  casePassRate: z.record(z.string(), z.number()).optional(),
  allRunsPass: z.boolean(),
  unstable: z.array(z.string()),
  failing: z.array(z.string()),
  ci: interval,
  groups: z.partialRecord(z.enum(CaseGroup), groupResult).optional(),
  kinds: z.partialRecord(z.enum(HardNegativeKind), groupResult).optional(),
  halves: z.object({ heldOut: halfScore, tuning: halfScore, runs: z.number().optional() }).optional(),
  errors: z.number(),
  usage: z.object({ input: z.number(), output: z.number() }),
  cache: z.object({ read: z.number(), write: z.number() }).optional(),
  costEstimateUsd: z.number(),
  latency: latency.optional(),
  startedAt: z.string(),
  finishedAt: z.string(),
  promptHash: z.string().optional(),
});
const resultsSchema = z.looseObject({ results: z.array(entrySchema) });

/**
 * Names the result file of a new run.
 *
 * @returns the path `<results folder>/<ISO timestamp>.json`
 * @sideEffects reads the clock
 */
export function defaultOut(): string {
  return join(RESULTS_DIR, `${resultStamp()}.json`);
}

/**
 * Names a configuration within a result file.
 *
 * @param e - the question, the model, the effort and whether the effort was sent
 * @returns a key that is equal for the same configuration
 * @sideEffects none
 */
export function entryKey(e: Pick<Entry, "question" | "model" | "effort" | "effortSent">): string {
  return `${e.question}|${e.model}|${e.effortSent ? e.effort : "-"}`;
}

/**
 * Reads the stage of a result entry. The files on disk hold the number 1 or 2 or the string "full"
 * (older files) or the enum value as a string (new files).
 *
 * @param v - the stage as it stands in the file
 * @returns the stage, or undefined when the file has none or an unknown one
 * @sideEffects none
 */
export function parseStage(v: unknown): ResultStage | undefined {
  const text = typeof v === "number" ? String(v) : v;
  return isMember(ResultStage, text) ? text : undefined;
}

// The file as it is, less the entries of the questions that were removed (Q7B, Q5B, and the other questions that were removed): the files
// of those measurements stay on disk as the record, and the readers skip their entries.
function withoutRemovedQuestions(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || !("results" in raw) || !Array.isArray(raw.results)) return raw;
  const results: unknown[] = raw.results;
  const removed = (e: unknown): boolean =>
    typeof e === "object" && e !== null && "question" in e && REMOVED_QUESTION_IDS.has(String(e.question));
  const kept = results.filter((e) => !removed(e));
  return { ...raw, results: kept };
}

/**
 * Reads a result file.
 *
 * @param path - the file
 * @returns the file, with the stage of each entry parsed
 * @throws {SyntaxError} when the file is not JSON
 * @throws {Error} when the file holds no valid `results` list
 * @sideEffects reads the file
 */
export function readResultFile(path: string): ResultFile {
  const read: unknown = JSON.parse(readFileSync(path, "utf8"));
  const raw = withoutRemovedQuestions(read);
  const parsed = resultsSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`${path} is not a result file`, { cause: parsed.error });
  // Typed at the read site: the other keys of the file are written by `runSets` and read back as they are.
  const file = raw as ResultFile;
  return { ...file, results: parsed.data.results.map((e) => ({ ...e, stage: parseStage(e.stage) })) };
}

/**
 * Lists the result files of a folder, oldest first. Summary files are left out.
 *
 * @param dir - the folder; default: the results folder
 * @returns the paths; empty when the folder does not exist
 * @sideEffects reads the file system
 */
export function resultFilesIn(dir: string = RESULTS_DIR): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith(".json") && !n.startsWith("summary-"))
    .sort()
    .map((n) => join(dir, n));
}

/**
 * Gives the bar of one question (technical/questions.md, "Test plan").
 *
 * @param q - the question id
 * @param bar - the pass bar; default: models.json
 * @returns the mean and the lowest run that the question needs
 * @sideEffects none
 */
export function barOf(q: string, bar: PassBar = MODELS.passBar): { mean: number; minRun: number } {
  return bar.strict.includes(q)
    ? { mean: bar.strictMean, minRun: bar.strictMinRun }
    : { mean: bar.mean, minRun: bar.minRun };
}

/**
 * Tells whether a configuration passes: a mean over the bar with no single run under the minimum.
 *
 * @param e - the question and the accuracy of the runs
 * @param bar - the pass bar; default: models.json
 * @returns true when the configuration passes
 * @sideEffects none
 */
export function passes(e: Pick<Entry, "question" | "mean" | "runAccuracy">, bar: PassBar = MODELS.passBar): boolean {
  const b = barOf(e.question, bar);
  return e.mean >= b.mean - EPSILON && e.runAccuracy.every((r) => r >= b.minRun - EPSILON);
}

/**
 * Words the pass bar for a report.
 *
 * @param bar - the pass bar; default: models.json
 * @returns one sentence
 * @sideEffects none
 */
export function barText(bar: PassBar = MODELS.passBar): string {
  const p = (x: number): string => `${Math.round(x * PERMILLE) / PERMILLE_PER_PERCENT}%`;
  if (bar.strict.length === 0)
    return `pass bar: every question at a mean of ${p(bar.mean)} or more with no run under ${p(bar.minRun)}`;
  return `pass bar: ${bar.strict.join(" and ")} at ${p(bar.strictMean)} on every run; every other question at a mean of ${p(bar.mean)} or more with no run under ${p(bar.minRun)}`;
}

/** The width of a percent text, in characters. */
const PERCENT_WIDTH = 6;

/**
 * Formats an accuracy as a percent with one decimal, right-aligned in 6 characters.
 *
 * @param x - the accuracy, 0..1
 * @returns for example ` 93.3%`
 * @sideEffects none
 */
export function percentText(x: number): string {
  return `${(x * PERCENT).toFixed(1)}%`.padStart(PERCENT_WIDTH);
}

/**
 * Formats an interval of accuracies as percents with one decimal.
 *
 * @param ci - the low and the high end, 0..1
 * @returns for example `[91.2–97.9]`
 * @sideEffects none
 */
export function intervalText(ci: [number, number]): string {
  const [low, high] = ci;
  return `[${(low * PERCENT).toFixed(1)}–${(high * PERCENT).toFixed(1)}]`;
}

/**
 * Names the cheapest passing configuration of a question, or the best one when none passes: the O6 proposal.
 *
 * @param q - the question
 * @param entries - the configurations of that question
 * @returns one line
 * @sideEffects none
 */
export function describeQuestion(q: QuestionId, entries: Entry[]): string[] {
  const label = (e: Entry): string => `${e.model}${e.effortSent ? ` at ${e.effort}` : " (effort not sent)"}`;
  const lowest = (e: Entry): string => percentText(Math.min(...e.runAccuracy)).trim();
  // The held-out score comes with the runs that hold the split, as they can be fewer than the runs of the mean.
  const heldOut = (e: Entry): string =>
    e.halves
      ? `, held-out ${percentText(e.halves.heldOut.mean).trim()} over ${e.halves.runs ?? e.runs} of ${e.runs} runs`
      : "";
  const [cheapest] = entries.filter((e) => passes(e)).sort(byCost);
  if (cheapest) {
    return [
      `${q}: ${label(cheapest)}, mean ${percentText(cheapest.mean).trim()}, lowest run ${lowest(cheapest)}${heldOut(cheapest)}`,
    ];
  }
  const [best] = [...entries].sort((a, b) => b.mean - a.mean || byCost(a, b));
  if (!best) return [`${q}: no results`];
  return [
    `${q}: no configuration passes. Best mean: ${label(best)}, ${percentText(best.mean).trim()}, lowest run ${lowest(best)}${heldOut(best)}`,
  ];
}
