import { ChangeOutcome, ProcessOutcome, RejectReason, SupportKind } from "../../domain/enums.js";
import { MIN_CLAIMS_TO_SPLIT, applyChange, getChangeForRequest } from "../../store/index.js";
import type { ChangeSet, Q7Output, Request } from "../types.js";
import { logChange, questionContext } from "./context.js";
import type { AgentContext, ProcessResult } from "./types.js";

/**
 * Step 1, the submission check. Q7 reads the change and the justification before any other step runs. A compound
 * submission with 2 claims or more and a justification that is not a belief is split into one child submission per
 * claim and ends as `split`. A child is never split again. Any other change that is not one claim ends as rejected
 * `compound`; a justification that is a belief ends as rejected `unsupported`. Q7's reason is the request's `error` on
 * a rejection. A request that already has a `split` change (a crash between the split commit and the `done` write) is
 * not split again: it ends as `split` with its existing children, with no Q7 call and no write.
 *
 * @param ctx - the agent context
 * @param req - the submission request; `parentId` is set on a child
 * @returns the result of the finished request when Q7 splits or rejects it, or undefined when the pipeline goes on
 * @sideEffects one Q7 call (none when the request is already split); reads the store; on a split or a rejection writes
 *   one change with no facts through `applyChange` (one embedder run; a split also inserts the child requests in the same transaction) and logs one
 *   change line
 */
export async function claimCheck(ctx: AgentContext, req: Request): Promise<ProcessResult | undefined> {
  const existing = getChangeForRequest(ctx.store, req.id);
  if (existing?.outcome === ChangeOutcome.Split) {
    const row = ctx.store.db.prepare("SELECT MAX(seq) AS seq FROM changes WHERE request_id = ?").get(req.id) as {
      seq: number;
    };
    return {
      outcome: ProcessOutcome.Split,
      seq: row.seq,
      mergeSeqs: [],
      passes: 0,
      rejudged: 0,
      childIds: existing.childIds,
    };
  }
  const q7 = await ctx.q.q7({ change: req.change, justification: req.justification }, questionContext(ctx));
  return settleCheck(ctx, req, q7);
}

/**
 * Acts on the answer of the submission check: splits, rejects, or lets the pipeline go on.
 *
 * @param ctx - the agent context
 * @param req - the submission request; `parentId` is set on a child
 * @param q7 - the answer of Q7
 * @returns the result of the finished request when the answer splits or rejects it, or undefined when it goes on
 * @sideEffects on a split or a rejection writes one change with no facts through `applyChange` (one embedder run; a
 *   split also inserts the child requests in the same transaction) and logs one change line
 */
async function settleCheck(ctx: AgentContext, req: Request, q7: Q7Output): Promise<ProcessResult | undefined> {
  const claims = q7.claims.map((c) => c.trim()).filter((c) => c !== "");
  if (
    !q7.oneClaim &&
    claims.length >= MIN_CLAIMS_TO_SPLIT &&
    q7.support !== SupportKind.Belief &&
    req.parentId === undefined
  ) {
    const cs: ChangeSet = {
      outcome: ChangeOutcome.Split,
      summary: `Split into ${claims.length} claims.`,
      changeReasoning: q7.reason,
      claims,
      facts: [],
    };
    const { seq, childIds } = await applyChange(ctx.store, req.id, cs);
    logChange(ctx, req, { seq, outcome: ChangeOutcome.Split, passes: 0, rejudged: 0 });
    return { outcome: ProcessOutcome.Split, seq, mergeSeqs: [], passes: 0, rejudged: 0, childIds };
  }
  let rejectReason: RejectReason;
  if (q7.support === SupportKind.Belief) rejectReason = RejectReason.Unsupported;
  else if (!q7.oneClaim) rejectReason = RejectReason.Compound;
  else return undefined;
  const cs: ChangeSet = {
    outcome: ChangeOutcome.Rejected,
    rejectReason,
    summary: `Rejected as ${rejectReason}.`,
    changeReasoning: q7.reason,
    facts: [],
  };
  const { seq } = await applyChange(ctx.store, req.id, cs);
  logChange(ctx, req, { seq, outcome: ChangeOutcome.Rejected, passes: 0, rejudged: 0 });
  return { outcome: ProcessOutcome.Rejected, seq, mergeSeqs: [], passes: 0, rejudged: 0, error: q7.reason };
}
