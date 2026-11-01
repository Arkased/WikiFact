// technical/updates.md, "Queue and worker": one step of the worker. Takes the first queued request outside `skip` and runs the update agent on it.
import { RunOnceStatus } from "../domain/enums.js";
import { stderrLogger } from "../log/index.js";
import { finishRequest, takeNextRequest, takeRequest, type Store } from "../store/index.js";
import { processRequest, type AgentDeps, type PipelineConfig, type ProcessResult } from "./agent/index.js";
import type { ProcessRequestOptions } from "./agent/process.js";
import { settleFailure } from "./settle-failure.js";
import type { Questions } from "./types.js";

/**
 * What one worker step did: nothing to do, a request done, a request that failed and is queued again or failed
 * for good, or a request put back unchanged because the model is rate limited.
 */
export type RunOnceResult =
  | { status: RunOnceStatus.Idle }
  | { status: RunOnceStatus.Done; requestId: string; result: ProcessResult }
  | {
      status: RunOnceStatus.Queued | RunOnceStatus.Failed | RunOnceStatus.RateLimited;
      requestId: string;
      error: string;
    };

/**
 * Takes the first queued row in queue order whose id is not in `skip`, and runs it. technical/updates.md, "Queue and worker":
 * on an error the attempt count goes up and the row goes back to `queued`,
 * and after 3 attempts the row is `failed` with the error text; a broken invariant (`InvariantError`) fails the row at
 * its first attempt.
 *
 * @param store - the open store with the write connection
 * @param questions - the model questions of the pipeline
 * @param config - the pipeline settings
 * @param deps - the injection points of the agent: the logger and the clock; `skip` holds the ids of queued requests to
 *   pass over (they wait out their retry delay), default none
 * @returns `Idle` when no queued row is outside `skip`, `Done` with the result, `RateLimited` with the error text when the model is
 *   rate limited (the row is `queued` with its attempt count unchanged), or `Queued` or `Failed` with the error text
 *   when another failure threw (it does not rethrow the agent's error)
 * @sideEffects one immediate transaction that sets the first queued row in queue order outside `skip` to `running`; then the agent writes
 *   (`processRequest`: changes, question calls, logs) and the row is set to `done`, back to `queued` unchanged on a
 *   rate limit, or its attempt count is raised;
 *   logs one `LogEvent.AttemptFailed` line per failed attempt (none for a rate limit); creates a stderr logger when `deps.log` is absent
 */
export async function runOnce(
  store: Store,
  questions: Questions,
  config: PipelineConfig,
  deps: AgentDeps & { skip?: ReadonlySet<string> } = {},
): Promise<RunOnceResult> {
  const row = takeNextRequest(store, Date.now(), deps.skip);
  if (!row) return { status: RunOnceStatus.Idle };
  return runTaken({ store, questions, config, row, deps });
}

/**
 * Takes one named request and runs it, as `runOnce` runs the first queued one (the cleanup step runs its repairs this way, in the
 * order it chose).
 *
 * @param store - the open store with the write connection
 * @param id - the id of the request
 * @param run - what the agent needs
 * @param run.questions - the model questions of the pipeline
 * @param run.config - the pipeline settings
 * @param run.deps - the injection points of the agent: the logger and the clock
 * @returns `Idle` when the request is not `queued` (another step took it), else as `runOnce`
 * @sideEffects as `runOnce` for the named row
 */
export async function runRequest(
  store: Store,
  id: string,
  run: { questions: Questions; config: PipelineConfig; deps?: AgentDeps },
): Promise<RunOnceResult> {
  const row = takeRequest(store, id);
  if (!row) return { status: RunOnceStatus.Idle };
  return runTaken({ store, row, ...run });
}

/**
 * Runs a request that is already taken (`running`) to its end: the agent, then `done`, or the settlement of the failure.
 *
 * @param opts - the store, the questions, the config, the row as taken and the injection points of the agent
 * @returns `Done` with the result, or the settlement of the failure (`Queued`, `Failed` or `RateLimited`) with the error text
 * @sideEffects as `runOnce` after it took the row
 */
async function runTaken(opts: ProcessRequestOptions): Promise<Exclude<RunOnceResult, { status: RunOnceStatus.Idle }>> {
  const { store, row, deps = {} } = opts;
  const log = deps.log ?? stderrLogger();
  try {
    const result = await processRequest(opts);
    finishRequest(store, row.id, (deps.now ?? Date.now)(), result.error);
    return { status: RunOnceStatus.Done, requestId: row.id, result };
  } catch (e) {
    const settled = settleFailure(store, log, row, e);
    return { ...settled, requestId: row.id };
  }
}
