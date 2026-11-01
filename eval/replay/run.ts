import { RequestStatus, RunOnceStatus } from "../../src/domain/index.js";
import {
  closeStore,
  enqueueRequest,
  listCurrentFacts,
  openStore,
  searchAndLog,
  type Store,
} from "../../src/store/index.js";
import { runOnce } from "../../src/updates/index.js";
import { DEFAULT_CONCURRENCY, pool } from "../lib/pool.js";
import { checkCase } from "./check.js";
import { loadReplay } from "./load.js";
import { seedReplayStore } from "./seed.js";
import type { CaseResult, FactSnapshot, ReplayCase, ReplayFile, ReplayOptions, ReplayReport } from "./types.js";

/**
 * The most `runOnce` calls for one case. A case queues 1 request, and each request may queue follow-ups (a repair
 * or a dependent update), so the loop ends at the first idle step; this bound only stops a pipeline that never idles.
 */
const MAX_RUN_ONCE_STEPS = 12;

/**
 * Reads the current version of every fact.
 *
 * @param store - the open store
 * @returns the current version of each fact by fact id, the deleted ones included
 * @sideEffects none (reads)
 */
function readCurrentFacts(store: Store): FactSnapshot {
  return new Map(listCurrentFacts(store).map((r) => [r.fact_id, r]));
}

/**
 * Runs the cases of replay.json through the pipeline, up to `concurrency` at a time.
 *
 * @param opts - the questions per case, the config, an optional case filter, the log and the concurrency
 * @returns the results in the order of the case file, and whether no duplicate and no compound failure happened
 * @sideEffects opens one in-memory store per case; runs the pipeline and the questions (model calls in a real run)
 */
export async function runReplay(opts: ReplayOptions): Promise<ReplayReport> {
  const file = loadReplay();
  const jobs = file.cases
    .filter((c) => !opts.only || c.id === opts.only)
    .map((c) => async (): Promise<CaseResult> => {
      const r = await runCase(opts, file, c);
      opts.onResult?.(r);
      return r;
    });
  const results = await pool(opts.concurrency ?? DEFAULT_CONCURRENCY, jobs);
  const pass = results.every((r) => r.criticalMisses.length === 0);
  return { results, pass };
}

async function runCase(opts: ReplayOptions, file: ReplayFile, c: ReplayCase): Promise<CaseResult> {
  const startedAt = new Date().toISOString();
  const store = openStore(":memory:", {
    embeddingModel: opts.config.embeddingModel,
    weights: opts.config.weights,
    searchCap: opts.config.searchCap,
    relevanceFloor: opts.config.relevanceFloor,
    agentSearchCap: opts.config.agentSearchCap,
  });
  try {
    const ids = await seedReplayStore(store, file);
    const questions = opts.makeQuestions(c, ids);
    const before = readCurrentFacts(store);
    // The case ran a search before it sent the change: a real search of the seed wiki, whose id the request carries.
    const { priorQuery, ...fields } = c.request;
    const searchId =
      priorQuery === undefined ? undefined : (await searchAndLog(store, priorQuery, { strict: true })).searchId;
    const request = enqueueRequest(store, { ...fields, targets: fields.targets ?? [], searchId });
    let outcome: string = RequestStatus.Failed;
    const errors: string[] = [];
    for (let i = 0; i < MAX_RUN_ONCE_STEPS; i++) {
      const r = await runOnce(store, questions, { subject: file.subject }, { log: opts.log ?? (() => undefined) });
      if (r.status === RunOnceStatus.Idle) break;
      if (r.status === RunOnceStatus.Done && r.requestId === request) outcome = r.result.outcome;
      if (r.status !== RunOnceStatus.Done) errors.push(r.error);
    }
    const after = readCurrentFacts(store);
    return {
      ...checkCase({
        c,
        file,
        ids,
        before,
        after,
        outcome,
        errors,
        questions,
      }),
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  } finally {
    closeStore(store);
  }
}
