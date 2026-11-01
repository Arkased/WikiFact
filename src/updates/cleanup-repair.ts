// A `cleanupRepair` request (technical/updates.md, "Queue and worker", technical/cleanup.md, "Cleanup"): one candidate of the duplicate fact check. The handler loads the pair again,
// asks Q1, and merges the facts through the merge of step 3, or writes a verdict, or nothing.
import { LogEvent, LogLevel, ProcessOutcome, RequestKind, CleanupRepairResult } from "../domain/enums.js";
import { errorMessage } from "../must.js";
import { getFactMaterial, parseCleanupRepair, writeVerdicts, type CleanupRepair } from "../store/index.js";
import type { AgentContext, ProcessResult } from "./agent/types.js";
import { rejectRequest } from "./operator-edit.js";
import { repairFacts } from "./cleanup-repair-fact.js";
import type { Request } from "./types.js";

/**
 * A cleanupRepair request (technical/cleanup.md, "Cleanup"): loads the pair again and repairs it. A pair that no longer fits
 * (a fact gone or deleted, already merged) finishes with no write. A document that is invalid, names a finder that does
 * not exist, or names a fact that exists nowhere ends as rejected `unsupported`, on the
 * first attempt, with no write other than the rejection.
 *
 * @param ctx - the agent context: the write store, the questions, the logger and the clock
 * @param req - the running request; `change` holds the candidate as JSON text
 * @returns `Accepted` with the seq of the merge; `Rejected` for a refused document; `Skipped` (no change written)
 *   for a verdict and for a stale pair, with no `error`
 * @throws {Error} when a question call fails or the merge fails
 * @throws {LintError} when the merged fact fails the lint twice or a dependent cannot be pointed at the kept fact
 * @throws {InvariantError} when `merge` finds no live fact or a dependent without material. Nothing is written and
 *   the caller counts the attempt.
 * @sideEffects reads the store; Q1; when it returns the older fact, the merge of step 3 runs: Q2 for each other fact,
 *   then Q3, its own `applyChange` and embedder run, the maintenance versions of the dependents, and its own change
 *   line (so the request logs none itself); else one transaction of `cleanup_verdicts` rows; logs one
 *   `LogEvent.CleanupRepair` line when nothing is written; reads the clock
 */
export async function cleanupRepair(ctx: AgentContext, req: Request): Promise<ProcessResult> {
  let repair: CleanupRepair;
  try {
    repair = parseCleanupRepair(req.change);
  } catch (e) {
    return rejectRequest(ctx, req, RequestKind.CleanupRepair, errorMessage(e));
  }
  const gone = repair.factIds.find((id) => getFactMaterial(ctx.store, id) === null);
  if (gone !== undefined) return rejectRequest(ctx, req, RequestKind.CleanupRepair, `fact ${gone} does not exist`);

  const result = await repairFacts(ctx, req, repair.factIds);
  // A request that writes nothing ends as a lookupRepair does: skipped, no error text, one log line.
  const skipped = (outcome: CleanupRepairResult, reason: string): ProcessResult => {
    ctx.log({
      event: LogEvent.CleanupRepair,
      level: LogLevel.Info,
      request_id: req.id,
      finder: repair.finder,
      result: outcome,
      reason,
    });
    return { outcome: ProcessOutcome.Skipped, mergeSeqs: [], passes: 0, rejudged: 0 };
  };
  if ("stale" in result) return skipped(CleanupRepairResult.Stale, result.stale);
  // The merge of step 3 wrote and logged its own change.
  if ("merged" in result) {
    return { outcome: ProcessOutcome.Accepted, seq: result.merged.seq, mergeSeqs: [], passes: 0, rejudged: 0 };
  }
  writeVerdicts(ctx.store, result.verdict.finder, result.verdict.subjects, ctx.now());
  return skipped(CleanupRepairResult.NoChange, result.note);
}
