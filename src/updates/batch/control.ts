// technical/updates.md, "High volume mode", "The worker loop": the checks between 2 requests of a batch, and the pool that runs its requests in parallel.
import pLimit from "p-limit";
import { BatchStopReason, CallFailureKind } from "../../domain/enums.js";
import { errorMessage } from "../../must.js";
import { classifyCallFailure } from "../questions/index.js";

/**
 * The stop state of one batch run. Once a reason is set it stays, so that a run that stopped half way is never read as
 * finished, even when the pause ends a moment later.
 */
export interface Control {
  /** Asks the worker whether to stop now; undefined: go on. */
  probe: () => BatchStopReason | undefined;
  /** The first reason that was seen. */
  stop?: BatchStopReason;
  /** The error text of the first rate-limited call; the worker waits for the end of the pause. */
  rateLimit?: string;
}

/**
 * Creates the control of a batch run.
 *
 * @param probe - the worker's check of the stop signal and the queue pause
 * @returns a control with nothing set
 * @sideEffects none
 */
export function createControl(probe: () => BatchStopReason | undefined): Control {
  return { probe };
}

/**
 * Tells whether the batch must stop now: a rate limit was seen, a stop reason was seen, or the probe says so.
 *
 * @param c - the control; the first reason found is kept on it
 * @returns true when no new request or pair may start
 * @sideEffects calls the probe (reads the store and the signal)
 */
export function halted(c: Control): boolean {
  if (c.rateLimit !== undefined || c.stop !== undefined) return true;
  const r = c.probe();
  if (r === undefined) return false;
  c.stop = r;
  return true;
}

/**
 * Tells whether a thrown value is a rate limit of the model.
 *
 * @param e - whatever was thrown
 * @returns true for a rate limit
 * @sideEffects none
 */
export function isRateLimit(e: unknown): boolean {
  return classifyCallFailure(errorMessage(e)) === CallFailureKind.RateLimit;
}

/**
 * Runs the tasks through `p-limit` with at most `limit` at a time. A task does not start once the control is halted. A
 * task must not throw for a fault of its request (it settles the request itself); a throw that reaches the pool is
 * rethrown after the running tasks end.
 *
 * @param c - the control, checked before each task starts
 * @param limit - the most tasks at the same time (`highVolume.concurrency`)
 * @param tasks - the tasks, started in order
 * @throws {Error} the first error a task threw
 * @sideEffects whatever the tasks do
 */
export async function runParallel(c: Control, limit: number, tasks: (() => Promise<void>)[]): Promise<void> {
  const run = pLimit(limit);
  const settled = await Promise.allSettled(
    tasks.map((task) =>
      run(async () => {
        if (halted(c)) return;
        await task();
      }),
    ),
  );
  for (const s of settled) if (s.status === "rejected") throw s.reason as Error;
}
