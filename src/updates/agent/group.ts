// The pipeline steps of a batch that the group call replaces or surrounds (technical/updates.md, "High volume mode", "Run"):
// the steps of one request before the group call, and the write of one answer.
import { JudgmentTargetKind, MemberPrepKind } from "../../domain/enums.js";
import type { ChangeRequestRow, Store } from "../../store/index.js";
import { getFactMaterial } from "../../store/index.js";
import { must } from "../../must.js";
import type { FactMaterial, GroupAnswer, Gathered, Questions, Request } from "../types.js";
import { createContext, requestOf } from "./context.js";
import { judgeFromOutput, judgeMaterial } from "./judge.js";
import { MIN_FACTS_TO_MERGE, finishSubmission, liveFacts, submissionHead } from "./submission.js";
import type { AgentContext, AgentDeps, PipelineConfig, ProcessResult } from "./types.js";

/** A request that stays in its group after Q7, the gather and Q1. */
export interface GroupMember {
  ctx: AgentContext;
  req: Request;
  gathered: Gathered;
  /** The facts that Q1 matched. */
  scope: FactMaterial[];
  /** The highest live seq at the gather; the stale check of the write reads it. */
  gatherSeq: number;
  /** The existing fact of the claim's scope, as Q4 gets it; absent when Q1 matched nothing. */
  existing?: FactMaterial;
  /** The other facts that may relate to the claim, as Q4 gets them. */
  related: FactMaterial[];
}

/**
 * What the steps of one request before the group call came to: the request ended there (Q7 split it or rejected it), it
 * stays in the group, or its scope holds 2 or more live facts and so it needs the merge of step 3, which the group call does not do.
 */
type MemberPrep =
  | { kind: MemberPrepKind.Ended; result: ProcessResult }
  | { kind: MemberPrepKind.Member; member: GroupMember }
  | { kind: MemberPrepKind.Crowded };

/** The inputs of `prepareMember`. */
interface PrepareMemberOptions {
  store: Store;
  questions: Questions;
  config: PipelineConfig;
  row: ChangeRequestRow;
  deps?: AgentDeps;
}

/**
 * Runs the steps of one request that come before the group call: the submission check (Q7), the gather and the scope match (Q1).
 *
 * @param opts - the store, the questions, the config, the taken request and the injection points
 * @returns `ended` with the result when Q7 split or rejected the request (its change is written); `crowded` when the scope
 *   holds 2 or more live facts (nothing is written); else `member`
 * @throws {Error} when a model call fails; nothing of the failed step is written
 * @sideEffects reads the store; Q7 and Q1 calls; the embedder runs; a split or a rejection writes one change as step 1 does; logs
 */
export async function prepareMember(opts: PrepareMemberOptions): Promise<MemberPrep> {
  const { store, questions, config, row, deps = {} } = opts;
  const ctx = createContext(store, questions, config, { ...deps, requestId: row.id });
  const req = requestOf(row);
  const head = await submissionHead(ctx, req);
  if ("ended" in head) return { kind: MemberPrepKind.Ended, result: head.ended };
  const { gathered, scope, gatherSeq } = head.matched;
  if (liveFacts(scope).length >= MIN_FACTS_TO_MERGE) return { kind: MemberPrepKind.Crowded };
  const { existing, related } = judgeMaterial(gathered, scope);
  return { kind: MemberPrepKind.Member, member: { ctx, req, gathered, scope, gatherSeq, existing, related } };
}

/** Where `writeMember` writes: the overlay store of the batch, and the requests of the group of the member. */
interface MemberTarget {
  /** The overlay store: the live wiki plus the staged set, writing to the staging tables. */
  store: Store;
  /** The ids of the requests of the group, the member included; their staged versions do not make the write stale. */
  group: string[];
}

/**
 * Writes the answer of the group call for one claim: the verdict becomes the judgment, the draft goes through the lint, and the
 * change is written, with the dependents and the prior query check, as the pipeline of 1 request at a time writes it.
 *
 * @param member - the request, with its context and material
 * @param answer - the answer of the group call for this claim
 * @param earlier - the fact that each earlier claim of the group wrote, by position
 * @param on - the overlay store to read the target from and write to, and the requests of the group
 * @returns the result of the request; `claimFactId` names the fact that the claim wrote
 * @throws {Error} when the target names a fact that is not in the store or an earlier claim that wrote none, when the verdict writes
 *   a fact and the answer has no draft, or when the judgment is invalid
 * @throws {LintError} when the draft fails the lint twice (the second attempt asks Q5, with the failure)
 * @sideEffects reads the store; writes one change through `applyChange` (one embedder run); the dependents loop makes its calls; logs
 */
export async function writeMember(
  member: GroupMember,
  answer: GroupAnswer,
  earlier: ReadonlyMap<number, string>,
  on: MemberTarget,
): Promise<ProcessResult> {
  const { req } = member;
  // The write reads the staged facts of the earlier claims, so it runs on the overlay store.
  const ctx: AgentContext = { ...member.ctx, store: on.store, group: on.group };
  const { target } = answer;
  let existing: FactMaterial | undefined;
  if (target) {
    let factId: string;
    if ("factId" in target) factId = target.factId;
    else {
      const wrote = earlier.get(target.position);
      if (wrote === undefined)
        throw new Error(`the group answer targets claim ${target.position}, which wrote no fact`);
      factId = wrote;
    }
    existing = must(getFactMaterial(ctx.store, factId), `the group answer targets ${factId}, which is no fact`);
  }
  const related = [...member.related, ...(member.existing ? [member.existing] : [])].filter(
    (f, i, all) => f.factId !== existing?.factId && all.findIndex((g) => g.factId === f.factId) === i,
  );
  const judged = judgeFromOutput(ctx, { out: answer.verdict, existing, related, req });
  const writes = judged.judgment.targets.some(
    (t) => t.kind === JudgmentTargetKind.Claim || t.kind === JudgmentTargetKind.Negate,
  );
  if (writes && !answer.draft) throw new Error("the group answer has no draft for a claim that writes a fact");
  return finishSubmission(ctx, req, {
    gathered: member.gathered,
    scope: existing ? [...member.scope, existing] : member.scope,
    gatherSeq: member.gatherSeq,
    mergeSeqs: [],
    judged,
    ...(answer.draft ? { firstDraft: answer.draft } : {}),
  });
}
