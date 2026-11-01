import { mkdirSync, writeFileSync } from "node:fs";
import { cpus as osCpus, platform, release } from "node:os";
import { dirname, join } from "node:path";
import { P50, P95, percentile } from "../lib/stats.js";
import { resultStamp } from "../lib/stamp.js";
import { required } from "../lib/required-value.js";
import type { Profile } from "./profile.js";
import { JSON_INDENT } from "../../src/constants.js";

/** The decimals of the milliseconds in the summary. */
const MS_DECIMALS = 2;

/** The decimals of the mean result count. */
const MEAN_DECIMALS = 1;

/** The pass bar of the speed eval: the p95 of a search, with the query embedding, must stay under this (ms). */
export const SPEED_BAR_MS = 100;

/**
 * Applies the pass bar to a p95.
 *
 * @param p95Ms - the 95th percentile of the search times, in ms
 * @returns true when the p95 is under `SPEED_BAR_MS`
 * @sideEffects none
 */
export function speedPasses(p95Ms: number): boolean {
  return p95Ms < SPEED_BAR_MS;
}

/** The numbers that the run prints. */
export interface SpeedSummary {
  facts: number;
  queries: number;
  embedder: string;
  p50_ms: number;
  p95_ms: number;
  max_ms: number;
  meanResults: number;
}

/** The results file of a speed run. */
export interface SpeedResultFile {
  /** The fact count of the database that was measured; with `wiki`, the count of the copy. */
  n: number;
  /** The environment of the wiki; absent for a synthetic database. */
  env?: string;
  /** The wiki of that environment that was copied; absent for a synthetic database. */
  wiki?: string;
  queryCount: number;
  embedder: string;
  seedFake: boolean;
  reusedDatabase: boolean;
  p50_ms: number;
  p95_ms: number;
  max_ms: number;
  meanResults: number;
  /** The bar that the p95 was judged against, in ms. */
  barMs: number;
  /** True when `p95_ms` is under `barMs`. */
  pass: boolean;
  profile: Profile | null;
  machine: { os: string; cpu: string; logicalCores: number; node: string };
  startedAt: string;
  finishedAt: string;
}

/**
 * Names the results file of a run that has no `--out`.
 *
 * @param finishedAt - the end of the run
 * @returns `eval/speed-results/<stamp>.json`, relative to the working directory
 * @sideEffects none
 */
export function defaultSpeedOut(finishedAt: Date): string {
  return join("eval", "speed-results", `${resultStamp(finishedAt)}.json`);
}

/**
 * Reduces the timings of the queries to p50, p95 and max.
 *
 * @param input - the facts, the embedder name, the search times in ms and the total hits
 * @param input.facts - the fact count of the run
 * @param input.embedder - `fake` or the model name
 * @param input.times - the time of each query in ms
 * @param input.hits - the total result count over all queries
 * @returns the summary; throws when `times` is empty
 * @sideEffects none
 */
export function summarizeTimes(input: {
  facts: number;
  embedder: string;
  times: number[];
  hits: number;
}): SpeedSummary {
  const times = [...input.times].sort((a, b) => a - b);
  return {
    facts: input.facts,
    queries: times.length,
    embedder: input.embedder,
    p50_ms: Number(percentile(times, P50).toFixed(MS_DECIMALS)),
    p95_ms: Number(percentile(times, P95).toFixed(MS_DECIMALS)),
    max_ms: Number(required(times.at(-1), "no query was timed").toFixed(MS_DECIMALS)),
    meanResults: Number((input.hits / times.length).toFixed(MEAN_DECIMALS)),
  };
}

/**
 * Describes this machine for the results file.
 *
 * @returns the OS, the CPU model, the core count and the Node version
 * @sideEffects reads the OS
 */
export function describeMachine(): SpeedResultFile["machine"] {
  const cpus = osCpus();
  return {
    os: `${platform()} ${release()}`,
    cpu: cpus[0]?.model ?? "unknown",
    logicalCores: cpus.length,
    node: process.version,
  };
}

/**
 * Writes the results file.
 *
 * @param outPath - the file; its folder is made when it is missing
 * @param result - the content
 * @sideEffects writes `outPath`
 */
export function writeSpeedResults(outPath: string, result: SpeedResultFile): void {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(result, null, JSON_INDENT) + "\n");
}
