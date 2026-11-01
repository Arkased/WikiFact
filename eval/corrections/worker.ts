import { RunOnceStatus } from "../../src/domain/index.js";
import { runOnce, type Questions } from "../../src/updates/index.js";
import type { Seeded } from "./seed.js";

/** The most requests that `drainQueue` runs by default; the queue of a run holds a few dozen. */
const DEFAULT_DRAIN_LIMIT = 500;

/** The options of `drainQueue`. */
export interface DrainOptions {
  /** The subject of the wiki. */
  subject: string;
  /** The most runs. Default `DEFAULT_DRAIN_LIMIT`. */
  limit?: number;
}

/**
 * Runs the queued requests with the given questions until the queue is empty or the limit of runs is reached.
 *
 * @param seeded - the seeded wiki
 * @param questions - the model questions of the update agent (the stub or the real ones)
 * @param opts - the subject and the run limit
 * @returns how many requests finished and how many failed
 * @sideEffects takes requests from the queue and writes their changes to the store; calls the questions
 */
export async function drainQueue(
  seeded: Seeded,
  questions: Questions,
  opts: DrainOptions,
): Promise<{ done: number; failed: number }> {
  let done = 0;
  let failed = 0;
  for (let i = 0; i < (opts.limit ?? DEFAULT_DRAIN_LIMIT); i++) {
    const r = await runOnce(seeded.store, questions, { subject: opts.subject }, { log: () => undefined });
    if (r.status === RunOnceStatus.Idle) break;
    if (r.status === RunOnceStatus.Done) done++;
    else if (r.status === RunOnceStatus.Failed) failed++;
  }
  return { done, failed };
}
