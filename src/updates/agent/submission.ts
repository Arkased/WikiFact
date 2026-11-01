import { ChangeOutcome, ProcessOutcome, RequestKind } from "../../domain/enums.js";
import {
  StaleChangeError,
  applyChange,
  getFactMaterial,
  highestChangeSeq,
  type FreshCheck,
} from "../../store/index.js";
import type { ChangeSet, FactMaterial, Gathered, ModelDraft, Request } from "../types.js";
import { claimCheck } from "./claim-check.js";
import { logChange } from "./context.js";
import { dependents } from "./dependents.js";
import { draft } from "./draft.js";
import { gather } from "./gather.js";
import { judge, type JudgeResult } from "./judge.js";
import { priorQueryCheck } from "./lookup-repair.js";
import { merge } from "./merge.js";
import { must } from "../../must.js";
import { scopeMatch } from "./scope.js";
import { summaryAccepted, summaryNoWrite } from "./summaries.js";
import type { AgentContext, ProcessResult } from "./types.js";

/** Step 3 runs when at least this many live facts match the change. */
export const MIN_FACTS_TO_MERGE = 2;

/** What steps 1 and 2 hand to step 3 when the request goes on. */
export interface MatchedSubmission {
  gathered: Gathered;
  /** The facts that Q1 matched. */
  scope: FactMaterial[];
  /** The highest seq at the gather; 0 without a stale check. */
  gatherSeq: number;
}

/**
 * The live facts of a scope.
 *
 * @param scope - the facts that step 2 matched
 * @returns the facts that are not deleted
 * @sideEffects none
 */
export function liveFacts(scope: FactMaterial[]): FactMaterial[] {
  return scope.filter((m) => !m.isDeleted);
}

/**
 * Steps 1 and 2 of a submission: the submission check (Q7), the gather and the scope match (Q1). `submission` runs them, and so
 * does the group path of the bulk test before its group call.
 *
 * @param ctx - the agent context
 * @param req - the submission request
 * @returns `ended` with the result when Q7 split or rejected the request, else `matched` with the material of step 3
 * @throws {Error} when a model call fails; nothing of the failed step is written
 * @sideEffects as steps 1 and 2 of `submission`
 */
export async function submissionHead(
  ctx: AgentContext,
  req: Request,
): Promise<{ ended: ProcessResult } | { matched: MatchedSubmission }> {
  // Step 1: the submission check, then gather.
  if (!ctx.claimChecked) {
    const rejected = await claimCheck(ctx, req);
    if (rejected) return { ended: rejected };
  }
  const gatherSeq = ctx.staleCheck ? highestChangeSeq(ctx.store) : 0;
  const gathered = await gather(ctx, req, true);
  // Step 2.
  const scope = await scopeMatch(ctx, req, gathered);
  return { matched: { gathered, scope, gatherSeq } };
}

/**
 * Builds the stale check of the write of a request of a batch.
 *
 * @param ctx - the agent context
 * @param at - the gather of the request
 * @param at.seq - the highest seq when the request gathered
 * @param at.scope - the facts that Q1 matched, and the target facts
 * @param cs - the change set about to be written
 * @returns the check; undefined when the context has no stale check
 * @sideEffects none
 */
function freshCheck(
  ctx: AgentContext,
  at: { seq: number; scope: { factId: string }[] },
  cs: ChangeSet,
): FreshCheck | undefined {
  if (!ctx.staleCheck) return undefined;
  const ids = new Set<string>(at.scope.map((f) => f.factId));
  for (const d of cs.facts) if (d.factId !== undefined) ids.add(d.factId);
  if (cs.duplicateOf !== undefined) ids.add(cs.duplicateOf);
  return { afterSeq: at.seq, factIds: [...ids], ...(ctx.group.length > 0 ? { group: ctx.group } : {}) };
}

/**
 * Maps the outcome the store recorded to the outcome the pipeline reports.
 *
 * @param o - the change outcome
 * @returns the process outcome with the same meaning
 * @sideEffects none
 */
function toProcessOutcome(o: ChangeOutcome): ProcessOutcome {
  switch (o) {
    case ChangeOutcome.Accepted:
      return ProcessOutcome.Accepted;
    case ChangeOutcome.Duplicate:
      return ProcessOutcome.Duplicate;
    case ChangeOutcome.Rejected:
      return ProcessOutcome.Rejected;
    case ChangeOutcome.Split:
      return ProcessOutcome.Split;
  }
}

/**
 * A submission: steps 1 to 9 of technical/updates.md, "Pipeline".
 *
 * @param ctx - the agent context
 * @param req - the submission request
 * @returns the outcome, the seqs written, the counters of the dependents loop and the repair request, if any; a
 *   rejection (Q7 at step 1 or Q4 at step 4) or a duplicate writes one change with no facts. A request of a batch
 *   (`ctx.inBatch`) skips step 9: it returns `relevantFactId`, the fact that its prior query should find (absent for a
 *   rejection and for a duplicate of a deletion), and no `repairRequestId`
 * @throws {LintError} when a draft fails the lint twice
 * @throws {StaleChangeError} when `ctx.inBatch` is set and step 3 finds 2 or more live facts in the scope (nothing is written;
 *   the request runs again alone after the promotion), or when `ctx.staleCheck` is set and another writer changed a fact of the
 *   request after its gather (the write is refused)
 * @throws {Error} when a model answer is invalid (Q4 fields, a draft count) or an invariant breaks; nothing of the
 *   failed step is written, but earlier merge changes stay committed
 * @sideEffects reads the store; the question calls (Q1 to Q9); one embedder run per
 *   change written; writes one change per merge and one for the request through `applyChange` (to the staging tables
 *   when the store has `stageTo`); may insert one queued lookupRepair row (not for a request of a batch); logs change and
 *   drop lines; reads the clock
 */
export async function submission(ctx: AgentContext, req: Request): Promise<ProcessResult> {
  const mergeSeqs: number[] = [];

  // Steps 1 and 2.
  const head = await submissionHead(ctx, req);
  if ("ended" in head) return head.ended;
  const { gathered, gatherSeq } = head.matched;
  let { scope } = head.matched;

  // Step 3.
  const live = liveFacts(scope);
  if (live.length >= MIN_FACTS_TO_MERGE) {
    // A request of a batch reads the live wiki only and cannot read its own staged merge, so it waits and runs again alone
    // after the promotion (technical/updates.md, "High volume mode", "Stale check").
    if (ctx.inBatch) throw new StaleChangeError(live.map((m) => m.factId).sort());
    const { seq, kept } = await merge(ctx, req, gathered, live);
    // The scope of the claim keeps the kept fact and the deleted matches. The merged-away facts are deleted now, and
    // the unrelated facts left the merge, so both leave the scope.
    const deleted = scope.filter((m) => m.isDeleted);
    if (seq === null) {
      scope = [kept, ...deleted];
    } else {
      mergeSeqs.push(seq);
      const reread = must(getFactMaterial(ctx.store, kept.factId), `merged fact ${kept.factId} not found`);
      scope = [reread, ...deleted];
    }
  }

  // Step 4.
  const judged = await judge(ctx, req, gathered, scope);
  return finishSubmission(ctx, req, { gathered, scope, gatherSeq, mergeSeqs, judged });
}

/** What steps 5 to 9 need from the steps before them. */
export interface JudgedSubmission {
  gathered: Gathered;
  /** The facts that step 2 matched, after the merge. */
  scope: FactMaterial[];
  /** The highest seq at the gather; 0 without a stale check. */
  gatherSeq: number;
  /** The seqs of the merge changes already written. */
  mergeSeqs: number[];
  judged: JudgeResult;
  /** The Q5 draft of the claim's fact when it is already written; Q5 is then asked only after a lint failure. */
  firstDraft?: ModelDraft;
}

/**
 * Steps 5 to 9 of a submission, after the judgment: the draft, the dependents, the write and the prior query check.
 *
 * @param ctx - the agent context
 * @param req - the submission request
 * @param st - the material of the steps before, the judgment included
 * @returns the result of `submission`; `claimFactId` is the claim's fact of an accepted change
 * @throws {LintError} when a draft fails the lint twice
 * @throws {StaleChangeError} when `ctx.staleCheck` is set and another writer changed a fact of the request after its gather
 * @throws {Error} when the judgment has no claim target and no delete target, or a model answer is invalid
 * @sideEffects as `submission` for steps 5 to 9
 */
export async function finishSubmission(ctx: AgentContext, req: Request, st: JudgedSubmission): Promise<ProcessResult> {
  const { gathered, scope, gatherSeq, mergeSeqs, firstDraft } = st;
  const { judgment, existing, related } = st.judged;

  if (judgment.outcome !== ChangeOutcome.Accepted) {
    const cs: ChangeSet = {
      outcome: judgment.outcome,
      rejectReason: judgment.rejectReason,
      duplicateOf: judgment.duplicateOf,
      summary: summaryNoWrite(judgment, existing),
      changeReasoning: judgment.changeReasoning,
      facts: [],
    };
    // Step 8.
    const fresh = freshCheck(ctx, { seq: gatherSeq, scope: [...gathered.targetFacts, ...scope] }, cs);
    const { seq } = await applyChange(ctx.store, req.id, cs, { fresh });
    logChange(ctx, req, { seq, outcome: judgment.outcome, passes: 0, rejudged: 0 });
    // Step 9. A duplicate of a deletion has no relevant fact: no live search returns a deleted fact.
    const relevantFactId =
      judgment.outcome === ChangeOutcome.Duplicate && !existing?.isDeleted ? judgment.duplicateOf : undefined;
    const outcome = toProcessOutcome(judgment.outcome);
    // No search finds a staged fact, so the promotion of the batch queues the check (technical/updates.md, "High volume mode").
    if (ctx.inBatch)
      return { outcome, seq, mergeSeqs, passes: 0, rejudged: 0, ...(relevantFactId ? { relevantFactId } : {}) };
    const repairRequestId = await priorQueryCheck(ctx, { req, relevantFactId, kind: RequestKind.Submission });
    return { outcome, seq, mergeSeqs, passes: 0, rejudged: 0, repairRequestId };
  }

  // Step 5 and 6.
  const pending = await draft(ctx, {
    req,
    gathered,
    judgment,
    existing,
    related,
    ...(firstDraft ? { firstDraft } : {}),
  });
  const claimIds = pending.claimIds;

  // Step 7.
  const { passes, rejudged } = await dependents(ctx, gathered, pending);

  // Step 8.
  const cs: ChangeSet = {
    outcome: ChangeOutcome.Accepted,
    summary: summaryAccepted(pending),
    changeReasoning: judgment.changeReasoning,
    facts: pending.facts,
  };
  const fresh = freshCheck(ctx, { seq: gatherSeq, scope: [...gathered.targetFacts, ...scope] }, cs);
  const { seq } = await applyChange(ctx.store, req.id, cs, { fresh });
  logChange(ctx, req, { seq, outcome: ChangeOutcome.Accepted, passes, rejudged });

  // Step 9. No search finds a staged fact, so the promotion of the batch queues the check (technical/updates.md, "High volume mode").
  if (ctx.inBatch) {
    const relevantFactId = claimIds[0];
    return {
      outcome: ProcessOutcome.Accepted,
      seq,
      mergeSeqs,
      passes,
      rejudged,
      ...(relevantFactId ? { relevantFactId } : {}),
    };
  }
  const repairRequestId = await priorQueryCheck(ctx, {
    req,
    relevantFactId: claimIds[0],
    kind: RequestKind.Submission,
  });
  return {
    outcome: ProcessOutcome.Accepted,
    seq,
    mergeSeqs,
    passes,
    rejudged,
    repairRequestId,
    ...(claimIds[0] ? { claimFactId: claimIds[0] } : {}),
  };
}
