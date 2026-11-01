import { ChangeOutcome, LogEvent, LogLevel } from "../../domain/enums.js";
import { stderrLogger } from "../../log/index.js";
import type { ChangeRequestRow, Store } from "../../store/index.js";
import type { QuestionContext, Questions, Request } from "../types.js";
import type { AgentContext, AgentDeps, PipelineConfig } from "./types.js";

/** The change log line without the fields that the context adds. */
export interface ChangeLine {
  seq: number;
  outcome: ChangeOutcome;
  /** "merge" or "lookupRepair" when the change is not the claim's own. */
  kind?: string;
  passes: number;
  rejudged: number;
}

/**
 * Builds the context of one request.
 *
 * @param store - the open store with the write connection
 * @param q - the model questions Q1 to Q10 that the steps call
 * @param config - the pipeline settings (the wiki subject)
 * @param deps - the log and the clock in ms (absent members default to stderr and `Date.now`), the stale check flag
 *   (default off), and the id of the request, which the call log names
 * @returns the context, with the duration mark set to now
 * @sideEffects reads the clock; creates a stderr logger when `deps.log` is absent
 */
export function createContext(
  store: Store,
  q: Questions,
  config: PipelineConfig,
  deps: AgentDeps & { requestId: string },
): AgentContext {
  const { requestId } = deps;
  const now = deps.now ?? Date.now;
  return {
    store,
    q,
    config,
    log: deps.log ?? stderrLogger(),
    now,
    requestId,
    mark: now(),
    staleCheck: deps.staleCheck ?? false,
    inBatch: deps.inBatch ?? false,
    claimChecked: deps.claimChecked ?? false,
    group: deps.group ?? [],
  };
}

/**
 * Builds the second argument of every question.
 *
 * @param ctx - the agent context
 * @returns the subject sentence and the request id
 * @sideEffects none
 */
export function questionContext(ctx: AgentContext): QuestionContext {
  return { subject: ctx.config.subject, requestId: ctx.requestId };
}

/**
 * Turns a queue row into the request that the pipeline reads.
 *
 * @param row - the row as taken
 * @returns the request, with an empty text for a null `change` or `justification` and undefined for a null `searchId` or `parentId`
 * @sideEffects none
 */
export function requestOf(row: ChangeRequestRow): Request {
  return {
    id: row.id,
    change: row.change ?? "",
    targets: row.targets,
    justification: row.justification ?? "",
    searchId: row.searchId ?? undefined,
    parentId: row.parentId ?? undefined,
  };
}

/**
 * Writes the log line of one committed change and restarts the duration mark.
 *
 * @param ctx - the agent context; its `mark` is updated
 * @param req - the request that the change belongs to
 * @param line - the seq, outcome, kind and counters of the change
 * @sideEffects logs one line; reads the clock; drains the token usage of the questions
 */
export function logChange(ctx: AgentContext, req: Request, line: ChangeLine): void {
  const t = ctx.now();
  ctx.log({
    event: LogEvent.Change,
    level: LogLevel.Info,
    request_id: req.id,
    ...line,
    tokens: ctx.q.takeUsage?.() ?? { input: 0, output: 0 },
    duration_ms: t - ctx.mark,
  });
  ctx.mark = t;
}
