// technical/console.md, "The `operatorEdit` request" and technical/updates.md, "Queue and worker": an `operatorEdit` request. No model question runs. The kinds are the reindex and the
// cleanup run.
import {
  ChangeOutcome,
  LogEvent,
  LogLevel,
  OperatorEditKind,
  ProcessOutcome,
  RejectReason,
  RequestKind,
} from "../domain/enums.js";
import { errorMessage } from "../must.js";
import { CLEANUP_FINDERS, applyChange, parseOperatorEdit, reindex, type OperatorEdit } from "../store/index.js";
import { logChange } from "./agent/context.js";
import { runCleanup } from "./cleanup-run.js";
import type { AgentContext, ProcessResult } from "./agent/types.js";
import type { ChangeSet, Request } from "./types.js";

/**
 * Ends a request of a kind that runs no question as a rejection with the reason `unsupported`, as the submission check
 * does for a compound claim.
 *
 * @param ctx - the agent context
 * @param req - the running request
 * @param kind - the kind of the request, for the change log line
 * @param message - why the request is refused; kept as `changeReasoning` and as the row's `error`
 * @returns `Rejected` with the seq of the rejection and the message as `error`
 * @throws {Error} when the write fails
 * @sideEffects one `applyChange` (a `changes` row); logs one change line
 */
export async function rejectRequest(
  ctx: AgentContext,
  req: Request,
  kind: RequestKind,
  message: string,
): Promise<ProcessResult> {
  const cs: ChangeSet = {
    outcome: ChangeOutcome.Rejected,
    rejectReason: RejectReason.Unsupported,
    summary: "Rejected as unsupported.",
    changeReasoning: message,
    facts: [],
  };
  const { seq } = await applyChange(ctx.store, req.id, cs);
  logChange(ctx, req, { seq, outcome: ChangeOutcome.Rejected, kind, passes: 0, rejudged: 0 });
  return { outcome: ProcessOutcome.Rejected, seq, mergeSeqs: [], passes: 0, rejudged: 0, error: message };
}

const rejected = (ctx: AgentContext, req: Request, message: string): Promise<ProcessResult> =>
  rejectRequest(ctx, req, RequestKind.OperatorEdit, message);

// A cleanup run (technical/updates.md, "Queue and worker", technical/cleanup.md, "Cleanup"): it runs the duplicate fact check now.
// It writes no change.
function runCleanupEdit(ctx: AgentContext): ProcessResult {
  runCleanup(ctx.store, ctx.now(), ctx.log, CLEANUP_FINDERS);
  return { outcome: ProcessOutcome.Skipped, mergeSeqs: [], passes: 0, rejudged: 0 };
}

async function runReindex(ctx: AgentContext, req: Request): Promise<ProcessResult> {
  const { versions } = await reindex(ctx.store);
  ctx.log({ event: LogEvent.OperatorReindex, level: LogLevel.Info, request_id: req.id, versions });
  return { outcome: ProcessOutcome.Skipped, mergeSeqs: [], passes: 0, rejudged: 0 };
}

/**
 * An operatorEdit request (technical/console.md, "The `operatorEdit` request"): a cleanup run or a reindex, run with no
 * model question. A document that is invalid or of an unknown kind ends as rejected `unsupported` with the message as `error`, on the first attempt.
 *
 * @param ctx - the agent context: the write store, the embedder, the logger and the clock
 * @param req - the running request; `change` holds the edit document as JSON text, `targets` is not read
 * @returns `Rejected` with the seq of the rejection and the message as `error`; `Skipped` (no change written) for a
 *   reindex and a cleanup run
 * @throws {Error} when the write of a rejection fails (nothing is written; the caller counts the attempt)
 * @sideEffects a reindex runs the embedder over the whole wiki and rewrites the index tables; a cleanup run writes
 *   `meta.cleanup_seq` and queues `cleanupRepair` rows of the duplicate fact check; a rejection is one `applyChange`; logs
 *   one change line, or one `LogEvent.OperatorReindex` line; reads the clock
 */
export async function operatorEdit(ctx: AgentContext, req: Request): Promise<ProcessResult> {
  let edit: OperatorEdit;
  try {
    edit = parseOperatorEdit(req.change);
  } catch (e) {
    return rejected(ctx, req, errorMessage(e));
  }
  switch (edit.edit) {
    case OperatorEditKind.Reindex:
      return runReindex(ctx, req);
    case OperatorEditKind.Cleanup:
      return runCleanupEdit(ctx);
  }
}
