// `summarize`: pool the runs of each configuration over the result files, name the cheapest passing one per question,
// and write the summary file and the presets file.
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { QUESTION_IDS } from "../../src/config/index.js";
import { Quality, QuestionId, enumValues } from "../../src/domain/index.js";
import { CaseGroup, HardNegativeKind } from "../lib/enums.js";
import { relativeToRoot } from "../lib/relative-path.js";
import { resultStamp } from "../lib/stamp.js";
import { mean, wilsonInterval } from "../lib/stats.js";
import { must } from "../lib/questions-guard.js";
import { byCost, MODELS, type PassBar } from "./models.js";
import { currentPromptHash } from "./prompt-hash.js";
import { DEFAULT_PRESETS_FILE, buildPresets, toPresetsFile, type PresetsProposal } from "./presets.js";
import {
  RESULTS_DIR,
  barText,
  describeQuestion,
  entryKey,
  passes,
  readResultFile,
  type Entry,
  type Stored,
  type ResultFile,
} from "./results.js";
import type { Halves, Score } from "./accuracy.js";
import type { GroupResult } from "./engine.js";
import { loadSet } from "./sets.js";
import { JSON_INDENT } from "../../src/constants.js";

/** The proposal of one question. */
interface QuestionProposal {
  passes: boolean;
  cheapestPassing: Entry | null;
  best: Entry | null;
  configurations: number;
}

/** How many entries of a question were pooled and how many were left out as another prompt. */
export interface PoolCount {
  pooled: number;
  leftOut: number;
}

/**
 * Keeps, per question, the entries of the current prompt. When a question has an entry with a `promptHash`, only the
 * entries whose hash equals the current one stay; the others, with another hash or none, are left out. A question with
 * no hashed entry keeps all its entries (files from before the hash).
 *
 * @param entries - the entries of any number of result files
 * @param hashOf - the current hash of a question; default: the hash of the code
 * @returns the entries to pool and the counts per question
 * @sideEffects none
 */
export function selectCurrent(
  entries: Entry[],
  hashOf: (q: QuestionId) => string = currentPromptHash,
): { kept: Entry[]; counts: Partial<Record<string, PoolCount>> } {
  const hashed = new Set(entries.filter((e) => e.promptHash !== undefined).map((e) => e.question));
  const kept: Entry[] = [];
  const counts: Partial<Record<string, PoolCount>> = {};
  for (const e of entries) {
    const count = (counts[e.question] ??= { pooled: 0, leftOut: 0 });
    if (!hashed.has(e.question) || e.promptHash === hashOf(e.question)) {
      kept.push(e);
      count.pooled++;
    } else count.leftOut++;
  }
  return { kept, counts };
}

/** The content of a summary file. */
export interface Proposal {
  generatedAt: string;
  /** The result files that were read, relative to the project root with forward slashes. */
  sources: string[];
  /** The pass bar, from models.json, in words and in numbers. */
  barText: string;
  bar: PassBar;
  /** One line per question: the O6 proposal. */
  lines: string[];
  /** `cheapestPassing` is the proposal. When none passes it is null and `best` is the best mean ("no configuration passes"). */
  proposal: Partial<Record<string, QuestionProposal>>;
  /** Per question: the entries pooled (the current prompt) and the entries left out as another prompt. */
  pooling: Partial<Record<string, PoolCount>>;
  /** The 3 preset tables with the mean and cost of each pick, the pick rules and the source files (technical/questions.md, "Quality presets"). The presets file holds the picks without them. */
  presets: PresetsProposal;
  /** Every configuration with all its runs pooled across the result files. */
  configurations: Entry[];
}

// One score pooled over entries: the mean weighted by the runs of each entry and the Wilson interval over all answers of
// the pooled runs (cases times runs; the successes are the rounded mean times the answers).
function poolScore(parts: { x: Stored<Score>; runs: number }[]): Score {
  const first = must(parts[0], "a pool of scores is never empty");
  const runs = parts.reduce((a, p) => a + p.runs, 0);
  const pooledMean = parts.reduce((a, p) => a + p.x.mean * p.runs, 0) / runs;
  const answers = first.x.cases * runs;
  return { cases: first.x.cases, mean: pooledMean, ci: wilsonInterval(Math.round(pooledMean * answers), answers) };
}

// The held-out and the tuning half of pooled entries, each pooled as a score. An entry without halves adds nothing, so
// the result carries `runs`, the runs of the entries that hold the split; none with halves gives undefined.
function poolHalves(entries: Entry[]): Entry["halves"] {
  const half = (h: keyof Halves): Score | undefined => {
    const parts = entries.flatMap((e) => (e.halves ? [{ x: e.halves[h], runs: e.runs }] : []));
    return parts.length ? poolScore(parts) : undefined;
  };
  const heldOut = half("heldOut");
  const tuning = half("tuning");
  const runs = entries.reduce((a, e) => a + (e.halves ? e.runs : 0), 0);
  return heldOut && tuning ? { heldOut, tuning, runs } : undefined;
}

// The cache tokens summed over the pooled entries like `usage`, which holds them. An entry without `cache` adds
// nothing; none with it gives undefined.
function poolCache(entries: Entry[]): Entry["cache"] {
  const caches = entries.flatMap((e) => (e.cache ? [e.cache] : []));
  return caches.length
    ? { read: caches.reduce((a, c) => a + c.read, 0), write: caches.reduce((a, c) => a + c.write, 0) }
    : undefined;
}

// The pass rate of each case over the pooled runs: the rate of each entry weighted by its runs, over the entries that
// hold the case. An entry without rates adds nothing; none with rates gives undefined.
function poolCasePassRate(entries: Entry[]): Entry["casePassRate"] {
  const sums = new Map<string, { passed: number; runs: number }>();
  for (const e of entries) {
    for (const [id, rate] of Object.entries(e.casePassRate ?? {})) {
      const s = sums.get(id) ?? { passed: 0, runs: 0 };
      sums.set(id, { passed: s.passed + rate * e.runs, runs: s.runs + e.runs });
    }
  }
  return sums.size ? Object.fromEntries([...sums].map(([id, s]) => [id, s.passed / s.runs])) : undefined;
}

// The scores of pooled entries, by group or by kind: the mean of each weighted by the runs of each entry, the union of
// the missed ids, and the Wilson interval over all answers of the pooled runs. An entry holds no counts, so the answers
// are cases times runs and the successes the rounded mean times the answers; the interval of one entry covers only its
// own runs and would sit next to a mean over all of them. An entry without the score adds nothing; none with it gives
// undefined. The bar never reads this.
function poolScores<K extends string>(
  entries: Entry[],
  keys: readonly K[],
  of: (e: Entry) => Partial<Record<K, Stored<GroupResult>>> | undefined,
): Partial<Record<K, Stored<GroupResult>>> | undefined {
  const out: Partial<Record<K, Stored<GroupResult>>> = {};
  for (const k of keys) {
    const parts = entries.flatMap((e) => {
      const x = of(e)?.[k];
      return x ? [{ x, runs: e.runs }] : [];
    });
    const first = parts[0];
    if (!first) continue;
    out[k] = { ...poolScore(parts), missed: [...new Set(parts.flatMap((p) => p.x.missed))] };
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Pools all runs of each configuration (question, model, effort) over the given entries: `runAccuracy` is the
 * concatenation, `runs` the count, `mean` the mean over all runs, and `costEstimateUsd`, `errors` and `usage` are sums.
 * An entry that appears twice with the same start and finish time (a resumed file copies the old entries) counts once.
 * `halves` (with its `runs`), `casePassRate` and `cache` are pooled over the runs like the mean and `usage`
 * (technical/questions.md, "Quality presets"). Two fields still come from the latest entry, as no
 * pooling rule is defined for them: `latency` (percentiles cannot be merged from the percentiles of the parts) and
 * `stage` (the stage of the last file).
 *
 * @param entries - the entries of any number of result files
 * @returns one entry per configuration
 * @sideEffects none
 */
export function poolEntries(entries: Entry[]): Entry[] {
  const groups = new Map<string, Entry[]>();
  const seen = new Set<string>();
  for (const e of entries) {
    const id = `${entryKey(e)}|${e.startedAt}|${e.finishedAt}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const g = groups.get(entryKey(e));
    if (g) g.push(e);
    else groups.set(entryKey(e), [e]);
  }
  return [...groups.values()].map((g) => {
    const sorted = [...g].sort((a, b) => (a.finishedAt < b.finishedAt ? -1 : a.finishedAt > b.finishedAt ? 1 : 0));
    const last = must(sorted.at(-1), "a group of entries is never empty");
    const runAccuracy = sorted.flatMap((e) => e.runAccuracy);
    return {
      ...last,
      runs: runAccuracy.length,
      runAccuracy,
      mean: mean(runAccuracy),
      allRunsPass: runAccuracy.every((x) => x === 1),
      unstable: [...new Set(sorted.flatMap((e) => e.unstable))],
      failing: [...new Set(sorted.flatMap((e) => e.failing))],
      ci: wilsonInterval(
        Math.round(mean(runAccuracy) * last.cases * runAccuracy.length),
        last.cases * runAccuracy.length,
      ),
      groups: poolScores(sorted, enumValues(CaseGroup), (e) => e.groups),
      kinds: poolScores(sorted, enumValues(HardNegativeKind), (e) => e.kinds),
      halves: poolHalves(sorted),
      casePassRate: poolCasePassRate(sorted),
      cache: poolCache(sorted),
      errors: sorted.reduce((a, e) => a + e.errors, 0),
      usage: {
        input: sorted.reduce((a, e) => a + e.usage.input, 0),
        output: sorted.reduce((a, e) => a + e.usage.output, 0),
      },
      costEstimateUsd: sorted.reduce((a, e) => a + e.costEstimateUsd, 0),
      startedAt: must(sorted.map((e) => e.startedAt).sort()[0], "a group of entries is never empty"),
    };
  });
}

// The entries of the result files that count, and the files that were read. A smoke run (`--limit`) holds fewer cases than the set and does not count.
function collect(files: string[]): { all: Entry[]; sources: string[]; skipped: number } {
  const all: Entry[] = [];
  const sources: string[] = [];
  let skipped = 0;
  for (const f of files) {
    let rf: ResultFile;
    try {
      rf = readResultFile(f);
    } catch {
      continue; // not a result file (for example an earlier summary)
    }
    sources.push(relativeToRoot(f));
    for (const e of rf.results) {
      if (e.cases < loadSet(e.question).cases.length) skipped++;
      else all.push(e);
    }
  }
  return { all, sources, skipped };
}

// The lines and the proposal per question.
function propose(configurations: Entry[]): { lines: string[]; proposal: Proposal["proposal"] } {
  const lines: string[] = [];
  const proposal: Proposal["proposal"] = {};
  for (const q of QUESTION_IDS) {
    const es = configurations.filter((e) => e.question === q);
    if (es.length === 0) continue;
    lines.push(...describeQuestion(q, es));
    const cheapest = es.filter((e) => passes(e)).sort(byCost)[0] ?? null;
    proposal[q] = {
      passes: cheapest !== null,
      cheapestPassing: cheapest,
      best: [...es].sort((a, b) => b.mean - a.mean || byCost(a, b))[0] ?? null,
      configurations: es.length,
    };
  }
  return { lines, proposal };
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, JSON_INDENT) + "\n");
}

/**
 * Merges the result files, pools all runs of each configuration, and names the cheapest passing one per question.
 * Writes the summary file, with the measured preset tables, and the presets file, with the picks and the name of the
 * summary file (technical/questions.md, "Quality presets").
 *
 * @param files - the result files; a file that is not a result file is skipped
 * @param outPath - the summary file; default: `summary-<timestamp>.json` in the results folder
 * @param print - receives each line of the report; default: `console.log`
 * @param presetsPath - the presets file; default: next to an explicit `outPath`, else `config/presets.json`
 * @returns the content of the summary file
 * @sideEffects reads the result files and the sets; writes the summary file `outPath` and the presets file `presetsPath`; prints through `print`
 */
export function summarize(
  files: string[],
  outPath?: string,
  print: (s: string) => void = console.log,
  presetsPath?: string,
): Proposal {
  const { all, sources, skipped } = collect(files);
  const { kept, counts } = selectCurrent(all);
  const configurations = poolEntries(kept);
  const { lines, proposal } = propose(configurations);
  const presets = buildPresets(configurations, sources);
  const result: Proposal = {
    generatedAt: new Date().toISOString(),
    sources,
    barText: barText(),
    bar: MODELS.passBar,
    lines,
    proposal,
    pooling: counts,
    presets,
    configurations,
  };
  print(
    `merged ${sources.length} result files, ${kept.length} entries pooled into ${configurations.length} configurations${skipped ? `, ${skipped} partial-set entries ignored` : ""}`,
  );
  for (const [q, c] of Object.entries(counts)) {
    if (c?.leftOut) print(`${q}: ${c.pooled} entries pooled, ${c.leftOut} left out as another prompt`);
  }
  print(barText());
  print("O6 proposal (cheapest configuration that passes):");
  for (const l of lines) print(l);
  const path = outPath ?? join(RESULTS_DIR, `summary-${resultStamp()}.json`);
  writeJson(path, result);
  print(`\nsummary written to ${path}`);
  // The presets of technical/questions.md, "Quality presets" go to the given path, else next to an explicit summary, else to config/presets.json.
  const presetsFile = presetsPath ?? (outPath ? join(dirname(outPath), "presets.json") : DEFAULT_PRESETS_FILE);
  writeJson(presetsFile, toPresetsFile(presets, basename(path)));
  print(`presets written to ${presetsFile}`);
  for (const name of [Quality.Budget, Quality.Standard, Quality.Premium]) {
    const table = Object.entries(presets.presets[name]);
    const flagged = table.filter(([, p]) => p.flagged === true).map(([q]) => q);
    const single = table.filter(([, p]) => p.singleConfiguration === true).map(([q]) => q);
    print(
      `  ${name}: ${table.length} questions${flagged.length ? `, no configuration passes for ${flagged.join(", ")} (flagged)` : ""}${single.length ? `, 1 configuration measured for ${single.join(", ")}` : ""}`,
    );
  }
  return result;
}
