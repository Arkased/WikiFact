// The duplicate fact repair of the cleanup (technical/cleanup.md, "Duplicate fact"): Q1 on the newer fact of the pair, then the merge of step 3.
import { CleanupFinder } from "../domain/enums.js";
import {
  DUPLICATE_FACT_NEIGHBORS,
  getFactMaterial,
  nearestLiveFacts,
  verdictSubject,
  versionText,
} from "../store/index.js";
import { questionContext } from "./agent/context.js";
import { currentVersion } from "./agent/draft-utils.js";
import { merge } from "./agent/merge.js";
import type { AgentContext } from "./agent/types.js";
import type { RepairResult } from "./cleanup-repair-shared.js";
import type { Request } from "./types.js";

/**
 * Repairs a duplicate fact pair. Loads both facts again (a fact that is gone or deleted makes the request stale). Q1
 * gets the newer fact as the claim, and as candidates the older fact and the other nearest live facts of the newer
 * fact. When Q1 returns the older fact, the merge of step 3 runs on the 2 facts, which writes 1 change and repoints the
 * dependents of the merged-away fact; else the pair gets a verdict. When Q2 of the merge calls the 2 facts unrelated, the merge
 * writes nothing and the pair gets a verdict too.
 *
 * @param ctx - the agent context: the write store, the questions, the logger and the clock
 * @param req - the running request; the merge writes its change under this request
 * @param ids - the 2 fact ids of the candidate, the older first
 * @returns `merged` with the seq of the merge, the fact that stays and the fact that the merge deleted, `verdict` for the pair when Q1 does not match or Q2 calls the facts unrelated, or `stale`
 * @throws {Error} when a question call fails, or the merge fails (a `LintError` when the merged fact fails the lint twice)
 * @sideEffects reads the store; one Q1 call; on a match, the effects of `merge` (a Q2 call; the rest only for related facts)
 */
export async function repairFacts(ctx: AgentContext, req: Request, ids: [string, string]): Promise<RepairResult> {
  const [olderId, newerId] = ids;
  const older = getFactMaterial(ctx.store, olderId);
  const newer = getFactMaterial(ctx.store, newerId);
  if (older === null || newer === null || older.isDeleted || newer.isDeleted) {
    return { stale: "one fact of the pair is gone or deleted: already merged" };
  }
  const claim = currentVersion(newer);
  const near = nearestLiveFacts(ctx.store, newerId, DUPLICATE_FACT_NEIGHBORS, ctx.store.config.neighborDistance);
  const candidates = [older];
  for (const n of near) {
    if (n.factId === olderId) continue;
    const m = getFactMaterial(ctx.store, n.factId);
    if (m !== null && !m.isDeleted) candidates.push(m);
  }
  const out = await ctx.q.q1(
    {
      change: versionText(claim.header, claim.content),
      candidates: candidates.map((f) => ({ factId: f.factId, header: currentVersion(f).header })),
    },
    questionContext(ctx),
  );
  if (!out.matches.includes(olderId)) {
    return {
      verdict: { finder: CleanupFinder.DuplicateFact, subjects: [verdictSubject(ids)] },
      note: "Q1: the older fact is not in the scope of the newer fact",
    };
  }
  const result = await merge(ctx, req, { subject: ctx.config.subject, targetFacts: [], candidates: [] }, [
    older,
    newer,
  ]);
  if (result.seq === null) {
    return {
      verdict: { finder: CleanupFinder.DuplicateFact, subjects: [verdictSubject(ids)] },
      note: "Q2: the 2 facts are in different scopes",
    };
  }
  const keptId = result.kept.factId;
  return { merged: { seq: result.seq, keptId, removedId: keptId === olderId ? newerId : olderId } };
}
