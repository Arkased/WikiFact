// The preload of the benefit test (technical/evaluation.md, "The benefit test", "The preload"): rounds of the held and
// stale questions on a copy of the wiki, and the worker step on the copy after each round, so that the measured runs read a
// mature wiki.
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../../src/config/index.js";
import { loadConfig } from "../../src/config/index.js";
import { BatchRunStatus, LogLevel, RunOnceStatus } from "../../src/domain/index.js";
import { errorMessage } from "../../src/must.js";
import { WIKI_CONFIG_FILE } from "../../src/paths.js";
import {
  clearQueuePause,
  closeStore,
  countWritesSince,
  highestChangeSeq,
  openStoreFor,
  writeBatchNow,
  type Store,
} from "../../src/store/index.js";
import { batchStep, runOnce, type Questions } from "../../src/updates/index.js";
import { Arm, BenefitCopy, PreloadStop } from "../lib/enums.js";
import { pool } from "../lib/pool.js";
import type { AgentRunner } from "./agent.js";
import { askQuestion } from "./ask.js";
import type { QuestionCase } from "./cases.js";
import type { PreloadMeta } from "./result-file.js";
import type { ResultRow } from "./rows.js";
import { LOG_ERROR_CHARS, stopReasonOf } from "./stop.js";
import { copyDatabase } from "./wiki-copy.js";
import type { GitRepo } from "./worktree.js";

/** The worker steps that one round may take per question before the harness gives up (a queue that never idles). */
const MAX_STEPS_PER_QUESTION = 20;
/** The extra worker steps allowed over the per-question bound, for the follow-up requests of a split. */
const SPARE_STEPS = 100;

/** What a preload needs. */
export interface PreloadInput {
  repo: GitRepo;
  commit: string;
  agent: AgentRunner;
  /** Makes the questions of the worker step on the preload copy; the store is the copy. */
  makeQuestions: (store: Store, config: Config) => Questions;
  log: (line: string) => void;
  model: string;
  isolateConfig: boolean;
  concurrency: number;
  runDir: string;
  /** The copy as it was filled: the preload copy starts from it. */
  source: string;
  /** The questions of the groups "held" and "stale". */
  questions: QuestionCase[];
  /** The most rounds (`--preload-rounds`, 1 or more). */
  mostRounds: number;
  /** The preload of the file being resumed; a complete one whose copy is still in the run folder is reused. */
  earlier?: PreloadMeta;
  /** Set by the first rate limit or failed login of the run. */
  stop: { reason?: string };
  /** Called with the head of the preload after each round, to write the result file. */
  onRound: (meta: PreloadMeta) => void;
}

/** What the preload made. */
export interface PreloadOutcome {
  /** The preload copy; the file is complete only when `meta.stoppedBy` is set. */
  path: string;
  meta: PreloadMeta;
}

/** The file name of the preload copy in the run folder. */
export const PRELOAD_FILE = "preloaded.sqlite";

/**
 * Tells whether a resume cannot go on because the preload copy is gone: the earlier preload is complete (`stoppedBy` is
 * set), `preloaded.sqlite` is missing from the run folder, and the file already holds a row that read the preloaded copy,
 * so a new preload would mix 2 preloaded copies in one file.
 *
 * @param runDir - the run folder of the resumed run
 * @param earlier - the preload of the file being resumed
 * @param rows - the rows of the file being resumed
 * @returns the usage error text; undefined when the resume can go on (a preload that is not complete, or that no row read, is made again)
 * @sideEffects reads the file system
 */
export function preloadGoneMessage(
  runDir: string,
  earlier: PreloadMeta | undefined,
  rows: ResultRow[],
): string | undefined {
  if (earlier?.stoppedBy === undefined || existsSync(join(runDir, PRELOAD_FILE))) return undefined;
  if (!rows.some((r) => r.copy === BenefitCopy.Preloaded)) return undefined;
  return `--resume cannot go on: the preloaded copy (${PRELOAD_FILE} in ${runDir}) is gone and the file holds rows that read it; start the run again`;
}

const safe = (text: string): string => text.replace(/[^a-zA-Z0-9_-]/g, "_");

/**
 * Runs the worker step on the preload copy until its queue is idle, as the service worker takes its steps: a batch when
 * the front of the queue holds submissions, else one request. The queue pause is cleared and each batch starts at once (the key `batch_now`).
 *
 * @param p - the preload input
 * @param path - the preload copy
 * @param steps - the most steps to take
 * @returns the stop reason when a rate limit or a failed login ended the drain; undefined when the queue went idle
 * @sideEffects opens the copy; writes it (the pipeline, the `batch_now` key, the queue pause key); model calls; embedder runs
 */
async function drainQueue(p: PreloadInput, path: string, steps: number): Promise<string | undefined> {
  const config = loadConfig(path);
  const store = openStoreFor(config, path);
  try {
    clearQueuePause(store);
    const questions = p.makeQuestions(store, config);
    const log = (l: { level?: LogLevel }): void => {
      if (l.level === LogLevel.Warn || l.level === LogLevel.Error) p.log(`preload worker: ${JSON.stringify(l)}`);
    };
    for (let step = 0; step < steps; step++) {
      // The batch starts at once, with the submissions that are queued; the key is deleted by the step.
      writeBatchNow(store, Date.now());
      const b = await batchStep({ store, questions, config, log });
      if (b.ran) {
        if (b.result.status === BatchRunStatus.RateLimited) return stopReasonOf(b.result.error) ?? b.result.error;
        continue;
      }
      const r = await runOnce(store, questions, config, { log });
      if (r.status === RunOnceStatus.Idle) return undefined;
      if (r.status === RunOnceStatus.RateLimited) return stopReasonOf(r.error) ?? r.error;
    }
    throw new Error(`the queue of the preload copy did not go idle in ${steps} steps`);
  } finally {
    closeStore(store);
  }
}

/**
 * Runs each question once as an agent run of the arm "with" on the preload copy. A rate limit or a failed login sets `p.stop`.
 *
 * @param p - the preload input
 * @param path - the preload copy
 * @param round - the number of the round, for the names of the runs
 * @returns once every run ended or was skipped after a stop
 * @sideEffects per question: a worktree, an agent process with a wiki server on the copy; writes the copy
 */
async function askRound(p: PreloadInput, path: string, round: number): Promise<void> {
  await pool(
    p.concurrency,
    p.questions.map((c) => async () => {
      if (p.stop.reason) return;
      const key = `preload-${round}-${safe(c.id)}`;
      const worktree = join(p.runDir, "wt", key);
      await p.repo.addWorktree(p.commit, worktree);
      try {
        const out = await askQuestion({ ...p, arm: Arm.With, c, key, worktree, dbPath: path });
        const stop = stopReasonOf(out.error);
        if (stop) p.stop.reason ??= stop;
        else if (out.error) p.log(`preload round ${round} ${c.id}: ${out.error.slice(0, LOG_ERROR_CHARS)}`);
      } finally {
        await p.repo.removeWorktree(worktree);
      }
    }),
  );
}

/**
 * Makes the preload copy and runs its rounds: each round asks the questions, the worker step processes the queue, and the
 * accepted changes of the round are counted from the store. The preload stops after a round with 0 accepted changes or
 * after the most rounds. A complete preload of an earlier file whose copy is still in the run folder is reused; any other is
 * made again from the start.
 *
 * @param p - the repo, the agent, the worker questions, the folders, the questions and the resume state
 * @returns the path of the preload copy and the head of the preload; `meta.stoppedBy` is absent when a rate limit or a
 *   failed login stopped it (`p.stop.reason` is set then)
 * @throws {Error} when an agent run or a worker step fails for a fault of the harness or the machine
 * @sideEffects writes `<runDir>/preloaded.sqlite` and the config next to it; per round: worktrees, agent processes with a
 *   wiki server on the copy, model calls of the worker, embedder runs; calls `onRound` after each round
 */
export async function runPreload(p: PreloadInput): Promise<PreloadOutcome> {
  const path = join(p.runDir, PRELOAD_FILE);
  if (p.earlier?.stoppedBy !== undefined && p.earlier.mostRounds === p.mostRounds && existsSync(path)) {
    p.log(`preload: reused, ${p.earlier.rounds.length} rounds`);
    return { path, meta: p.earlier };
  }
  for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
  rmSync(join(p.runDir, WIKI_CONFIG_FILE), { force: true });
  copyDatabase(p.source, path);
  const meta: PreloadMeta = { mostRounds: p.mostRounds, rounds: [] };
  p.onRound(meta);
  const steps = p.questions.length * MAX_STEPS_PER_QUESTION + SPARE_STEPS;
  for (let round = 1; round <= p.mostRounds; round++) {
    const startSeq = readSeq(path);
    await askRound(p, path, round);
    if (p.stop.reason) break;
    let drained: string | undefined;
    try {
      drained = await drainQueue(p, path, steps);
    } catch (e) {
      throw new Error(`preload round ${round}: ${errorMessage(e)}`, { cause: e });
    }
    if (drained !== undefined) {
      p.stop.reason ??= drained;
      break;
    }
    const accepted = acceptedSince(path, startSeq);
    meta.rounds.push({ accepted });
    p.log(`preload round ${round}: ${accepted} accepted changes`);
    if (accepted === 0) meta.stoppedBy = PreloadStop.NoChange;
    else if (round === p.mostRounds) meta.stoppedBy = PreloadStop.MostRounds;
    p.onRound(meta);
    if (meta.stoppedBy !== undefined) break;
  }
  return { path, meta };
}

function readSeq(path: string): number {
  const store = openStoreFor(loadConfig(path), path);
  try {
    return highestChangeSeq(store);
  } finally {
    closeStore(store);
  }
}

function acceptedSince(path: string, seq: number): number {
  const store = openStoreFor(loadConfig(path), path);
  try {
    return countWritesSince(store, seq);
  } finally {
    closeStore(store);
  }
}
