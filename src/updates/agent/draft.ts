import { JudgmentTargetKind } from "../../domain/enums.js";
import { newId } from "../../store/index.js";
import type { FactDraft, FactMaterial, Gathered, Judgment, ModelDraft, Request } from "../types.js";
import { questionContext } from "./context.js";
import { currentVersion, draftId, toDraft, unionNames } from "./draft-utils.js";
import { writeAndLint, type LintEnv } from "./lint.js";
import { must, mustFromModel } from "../../must.js";
import type { AgentContext, Pending } from "./types.js";

/** The inputs of `draft`. */
export interface DraftOptions {
  req: Request;
  gathered: Gathered;
  judgment: Judgment;
  existing: FactMaterial | undefined;
  related: FactMaterial[];
  /** The Q5 draft of the claim's fact, already written (by the group call of the bulk test); Q5 is asked only after a lint failure. */
  firstDraft?: ModelDraft;
}

/** What steps 5 and 6 produce: the drafts, the ids of the claim's facts and one label per draft. */
export type Drafted = Pending & { claimIds: string[]; labels: string[] };

/**
 * Steps 5 and 6. Drafts the claim's fact with Q5 (with `negate` for a deleted fact restated too weakly), then the
 * narrowed facts with Q6, and lints each unit. The code writes the facts that the judgment deletes, the existing
 * fact of a deletion by negation included; that case calls no Q5.
 *
 * @param ctx - the agent context
 * @param opts - the request, the gathered material, the judgment, the existing fact and the related facts
 * @returns the drafts, the ids of the claim's facts, and the labels for the summary line
 * @throws {LintError} when a unit fails the lint a second time
 * @throws {Error} when the judgment has no claim target and no delete target, or Q5 or Q6 returns no draft or Q5
 *   drafts only deletions (the next attempt asks the model again)
 * @throws {InvariantError} when a narrow target has no claim draft, or a wrong related fact is not among the related
 *   facts
 * @sideEffects Q5 and Q6 calls; reads the store; creates ULIDs (reads the clock)
 */
export async function draft(ctx: AgentContext, opts: DraftOptions): Promise<Drafted> {
  const { req, judgment, existing, related } = opts;
  const qctx = questionContext(ctx);
  const claimTarget = judgment.targets.find(
    (t) => t.kind === JudgmentTargetKind.Claim || t.kind === JudgmentTargetKind.Negate,
  );
  // A deletion by negation has no claim target: the delete target is the existing fact, and Q5 is not called.
  if (!claimTarget && !judgment.targets.some((t) => t.kind === JudgmentTargetKind.Delete)) {
    // The judgment comes from the Q4 answer, so the next attempt can differ: a failed attempt, not an InvariantError.
    throw new Error("the accepted judgment has no claim target and no delete target");
  }
  const negate = claimTarget?.kind === JudgmentTargetKind.Negate;
  // The pre-assigned ULID: a new fact is referenced by the other drafts before the write.
  const preId = claimTarget ? (claimTarget.factId ?? newId()) : undefined;
  const claimDeleted = existing?.isDeleted ?? false;

  const drafted = new Set<string>([
    ...(preId ? [preId] : []),
    ...judgment.targets.map((t) => t.factId).filter((x): x is string => !!x),
  ]);
  const env: LintEnv = { drafted };
  const facts: FactDraft[] = [];
  const labels: string[] = [];
  let claimIds: string[] = [];
  let claimDraft: FactDraft | undefined;

  // Q5: the claim's fact.
  if (preId) {
    const claim = await writeAndLint(ctx, env, {
      write: (lintFailure) =>
        opts.firstDraft && lintFailure === undefined
          ? Promise.resolve({ drafts: [opts.firstDraft] })
          : ctx.q.q5(
              {
                change: req.change,
                justification: req.justification,
                existing,
                related,
                ...(negate ? { negate } : {}),
                lintFailure,
              },
              qctx,
            ),
      build: (res) => [toDraft(mustFromModel(res.drafts[0], "Q5 returned no draft"), preId, req.justification)],
    });
    for (const d of claim.drafts) {
      facts.push(d);
      env.drafted.add(draftId(d));
      labels.push(
        d.isDeleted
          ? `deleted "${d.header}"`
          : existing && d.factId === existing.factId
            ? negate
              ? `negated "${d.header}"`
              : claimDeleted
                ? `revived "${d.header}"`
                : `updated "${d.header}"`
            : `created "${d.header}"`,
      );
    }
    claimIds = claim.drafts.filter((d) => !d.isDeleted).map(draftId);
    claimDraft = mustFromModel(
      claim.drafts.find((d) => !d.isDeleted),
      "Q5 drafted only deletions",
    );
  }

  // Q6 for each narrow target. The code writes each delete target.
  for (const t of judgment.targets) {
    if (t.kind === JudgmentTargetKind.Claim || t.kind === JudgmentTargetKind.Negate) continue;
    const wrong = must(
      [...related, ...(existing ? [existing] : [])].find((r) => r.factId === t.factId),
      `wrong related fact ${t.factId} is not among the related facts`,
    );
    const cur = currentVersion(wrong);
    if (t.kind === JudgmentTargetKind.Delete) {
      facts.push({
        factId: wrong.factId,
        header: cur.header,
        content: cur.content,
        justification: req.justification,
        references: [],
        isDeleted: true,
      });
      labels.push(`deleted "${cur.header}"`);
      continue;
    }
    const claim = must(claimDraft, "a narrow target needs a claim draft");
    const unit = await writeAndLint(ctx, env, {
      write: (lintFailure) => ctx.q.q6({ wrong, claim, lintFailure }, qctx),
      build: (res) => {
        const d = mustFromModel(res.drafts[0], "Q6 returned no draft");
        return [
          {
            ...toDraft(d, wrong.factId, cur.justification),
            references: unionNames(d.references ?? [], [...claimIds]).filter((r) => r !== wrong.factId),
          },
        ];
      },
    });
    facts.push(...unit.drafts);
    labels.push(`narrowed "${mustFromModel(unit.drafts[0], "Q6 unit has no draft").header}"`);
  }
  return { facts, claimIds, labels };
}
