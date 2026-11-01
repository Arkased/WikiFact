import {
  ChangeOutcome,
  JudgmentTargetKind,
  LogEvent,
  LogLevel,
  Q4Relation,
  RejectReason,
  WrongRelatedAction,
} from "../../domain/enums.js";
import type { FactMaterial, Gathered, Judgment, Q4Output, Request } from "../types.js";
import { questionContext } from "./context.js";
import { currentVersion } from "./draft-utils.js";
import type { AgentContext } from "./types.js";

/** What step 4 returns: the judgment and the facts it was made against. */
export interface JudgeResult {
  judgment: Judgment;
  existing?: FactMaterial;
  related: FactMaterial[];
}

/** The inputs of `mapJudgment` and `judgeFromOutput`. */
export interface MapJudgmentOptions {
  out: Q4Output;
  existing: FactMaterial | undefined;
  related: FactMaterial[];
  req: Request;
}

/**
 * Maps the action Q4 proposes for a wrong related fact to the target kind of a judgment.
 *
 * @param a - the action of Q4
 * @returns the target kind with the same meaning
 * @sideEffects none
 */
function toTargetKind(a: WrongRelatedAction): JudgmentTargetKind {
  switch (a) {
    case WrongRelatedAction.Delete:
      return JudgmentTargetKind.Delete;
    case WrongRelatedAction.Narrow:
      return JudgmentTargetKind.Narrow;
  }
}

/**
 * Step 4. Asks Q4 whether the change is supported and how it relates to the matched and related facts.
 *
 * @param ctx - the agent context
 * @param req - the request
 * @param g - the gathered material
 * @param scope - the facts that step 2 matched, after the merge
 * @returns the judgment, the existing fact that the claim changes (undefined when none matched), and the related
 *   facts that Q4 saw
 * @throws {Error} when Q4 omits a field that its answer requires (see `mapJudgment`)
 * @sideEffects one Q4 call; logs one `LogEvent.Judge` line for each wrong-related fact that is dropped,
 *   and one `LogEvent.ScopeOvermatch` line when Q4 calls the existing fact unrelated
 */
export async function judge(ctx: AgentContext, req: Request, g: Gathered, scope: FactMaterial[]): Promise<JudgeResult> {
  const { existing, related } = judgeMaterial(g, scope);
  const out = await ctx.q.q4(
    { change: req.change, justification: req.justification, existing, related },
    questionContext(ctx),
  );
  return judgeFromOutput(ctx, { out, existing, related, req });
}

/**
 * Picks the material of Q4 from the gather and the scope match: the existing fact and the related facts.
 *
 * @param g - the gathered material
 * @param scope - the facts that step 2 matched, after the merge
 * @returns the existing fact (the live match, else the most recently deleted match; undefined when none matched) and
 *   the target and candidate facts that are not in the scope, with no fact twice
 * @sideEffects none
 */
export function judgeMaterial(
  g: Gathered,
  scope: FactMaterial[],
): { existing: FactMaterial | undefined; related: FactMaterial[] } {
  // The live match wins. Else the most recently deleted match. Deleted matches next to a live one are dropped.
  let existing: FactMaterial | undefined = scope.find((m) => !m.isDeleted);
  if (!existing) {
    const deleted = scope.filter((m) => m.isDeleted);
    deleted.sort((a, b) => currentVersion(b).seq - currentVersion(a).seq);
    existing = deleted[0];
  }
  const matched = new Set(scope.map((m) => m.factId));
  const related: FactMaterial[] = [];
  const relatedIds = new Set<string>();
  const addRelated = (f: FactMaterial): void => {
    if (matched.has(f.factId) || relatedIds.has(f.factId)) return;
    relatedIds.add(f.factId);
    related.push(f);
  };
  g.targetFacts.forEach(addRelated);
  g.candidates.forEach((c) => addRelated(c.fact));
  return { existing, related };
}

/**
 * Step 4, after the answer: turns an answer of Q4 (or the verdict of a group call) into the judgment.
 *
 * @param ctx - the agent context
 * @param opts - the Q4 output, the existing fact, the related facts and the request
 * @returns the judgment, the existing fact that the claim changes (undefined when none matched, or when Q4 called it
 *   unrelated) and the related facts that Q5 sees (the unrelated existing fact among them)
 * @throws {Error} when the answer omits a field that it requires (see `mapJudgment`)
 * @sideEffects logs as `mapJudgment` does
 */
export function judgeFromOutput(ctx: AgentContext, opts: MapJudgmentOptions): JudgeResult {
  const { out, existing, related, req } = opts;
  const judgment = mapJudgment(ctx, { out, existing, related, req });
  // An unrelated existing fact is a sibling scope: the claim is new, and Q5 sees the sibling as a related fact.
  if (existing && out.supported && out.relation === Q4Relation.Unrelated) {
    return { judgment, existing: undefined, related: [...related, existing] };
  }
  return { judgment, existing, related };
}

/**
 * Turns the output of Q4 into a judgment.
 *
 * @param ctx - the agent context
 * @param opts - the Q4 output, the existing fact, the related facts and the request
 * @returns the judgment; a rejection, a duplicate (of a live existing fact) or an acceptance with its targets
 *   (a new fact when the existing fact is unrelated; a delete of the existing fact when the claim negates it; a
 *   negate target when a deleted fact is restated with weaker evidence). `negates` on a deleted fact is a
 *   duplicate of the deletion, since nothing is written.
 * @throws {Error} when Q4 says unsupported without a valid `rejectReason` (`unsupported`, `contradicted` or `compound`), says supported with an existing fact
 *   and no valid `relation`, or says `stale` for a live existing fact
 * @sideEffects logs one `LogEvent.Judge` line for each wrong-related fact that is dropped (unknown, deleted,
 *   repeated or with an invalid action), and one
 *   `LogEvent.ScopeOvermatch` line when the relation is `unrelated`
 */
function mapJudgment(ctx: AgentContext, opts: MapJudgmentOptions): Judgment {
  const { out, existing, related, req } = opts;
  const base = { changeReasoning: out.reason };
  if (!out.supported) {
    // technical/updates.md, "Step 4. Judge": Q4 may find that the claim joins 2 claims (`compound`), though its prompt
    // names only the other 2 reasons. It is a rejection with that reason, as at step 1.
    const reasons = [RejectReason.Unsupported, RejectReason.Contradicted, RejectReason.Compound];
    if (!out.rejectReason) {
      throw new Error("Q4 output invalid: rejectReason is required when supported is false");
    }
    if (!reasons.includes(out.rejectReason)) {
      throw new Error(`Q4 output invalid: rejectReason ${out.rejectReason} is not accepted when supported is false`);
    }
    return { ...base, outcome: ChangeOutcome.Rejected, rejectReason: out.rejectReason, targets: [] };
  }
  const relations = Object.values(Q4Relation);
  if (existing && (!out.relation || !relations.includes(out.relation))) {
    throw new Error("Q4 output invalid: relation is required when an existing fact is present");
  }
  if (existing && !existing.isDeleted && out.relation === Q4Relation.Stale) {
    throw new Error("Q4 output invalid: relation stale needs a deleted existing fact");
  }
  if (existing?.isDeleted && out.relation === Q4Relation.Negates) {
    // The deletion already says it, so the request writes nothing and is a duplicate of the deletion.
    return { ...base, outcome: ChangeOutcome.Duplicate, duplicateOf: existing.factId, targets: [] };
  }
  const negates = !!existing && out.relation === Q4Relation.Negates;
  if (existing && !existing.isDeleted && out.relation === Q4Relation.Same) {
    return { ...base, outcome: ChangeOutcome.Duplicate, duplicateOf: existing.factId, targets: [] };
  }
  const overmatch = out.relation === Q4Relation.Unrelated;
  if (existing && overmatch) {
    ctx.log({
      event: LogEvent.ScopeOvermatch,
      level: LogLevel.Info,
      request_id: req.id,
      existingFactId: existing.factId,
      reason: out.reason,
    });
  }
  let first: Judgment["targets"][number];
  if (existing && negates) first = { kind: JudgmentTargetKind.Delete, factId: existing.factId };
  else if (existing && out.relation === Q4Relation.Stale) {
    first = { kind: JudgmentTargetKind.Negate, factId: existing.factId };
  } else first = { kind: JudgmentTargetKind.Claim, factId: overmatch ? undefined : existing?.factId };
  const targets: Judgment["targets"] = [first];
  const seen = new Set<string>();
  for (const w of out.wrongRelated ?? []) {
    const f = related.find((r) => r.factId === w.factId);
    if (
      !f ||
      f.isDeleted ||
      seen.has(w.factId) ||
      (w.action !== WrongRelatedAction.Delete && w.action !== WrongRelatedAction.Narrow) ||
      // A deletion by negation has no claim draft, so Q6 has nothing to narrow against.
      (negates && w.action === WrongRelatedAction.Narrow)
    ) {
      ctx.log({ event: LogEvent.Judge, level: LogLevel.Info, request_id: req.id, droppedWrongRelated: w.factId });
      continue;
    }
    seen.add(w.factId);
    targets.push({ kind: toTargetKind(w.action), factId: w.factId });
  }
  return { ...base, outcome: ChangeOutcome.Accepted, targets };
}
