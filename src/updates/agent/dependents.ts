import { getDependents, getFactMaterial } from "../../store/index.js";
import type { ChangedFact, FactDraft, Gathered, Q8Input } from "../types.js";
import { questionContext } from "./context.js";
import { currentVersion, draftId, toDraft } from "./draft-utils.js";
import { writeAndLint, type LintEnv } from "./lint.js";
import { must, mustFromModel } from "../../must.js";
import type { AgentContext, Pending } from "./types.js";

/**
 * Step 7 (technical/updates.md, "Dependents loop"). Re-judges the facts that depend on a changed fact, pass by pass, until no new dependent
 * appears. Appends the new drafts to `p.facts`.
 *
 * @param ctx - the agent context
 * @param g - the gathered material
 * @param p - the drafts so far; changed in place
 * @returns the number of passes and the number of dependents that were re-judged; both 0 when nothing depends on
 *   the drafted facts
 * @throws {LintError} when a rewritten dependent fails the lint twice
 * @throws {InvariantError} when a dependent has no material in the store
 * @sideEffects reads the store; Q8 and Q9 calls; mutates `p`
 */
export async function dependents(
  ctx: AgentContext,
  g: Gathered,
  p: Pending,
): Promise<{ passes: number; rejudged: number }> {
  const qctx = questionContext(ctx);
  const visited = new Set(p.facts.map(draftId));
  let frontier = [...visited];
  let passes = 0;
  let rejudged = 0;
  const env: LintEnv = { drafted: visited };

  for (;;) {
    const deps = new Set<string>();
    for (const id of frontier) for (const d of getDependents(ctx.store, id)) if (!visited.has(d)) deps.add(d);
    if (deps.size === 0) break;
    passes++;
    const csById = new Map(p.facts.map((f) => [draftId(f), f] as const)); // snapshot: the pass judges against it
    const added: FactDraft[] = [];

    for (const depId of [...deps].sort()) {
      rejudged++;
      const dep = must(getFactMaterial(ctx.store, depId), `dependent ${depId} not found`);
      const cur = currentVersion(dep);
      const changed: ChangedFact[] = [];
      const unchanged: Q8Input["unchanged"] = [];
      for (const refId of cur.references) {
        const after = csById.get(refId);
        const now = getFactMaterial(ctx.store, refId)?.versions[0];
        if (after) {
          changed.push({
            factId: refId,
            before: { header: now?.header ?? "", content: now?.content ?? "" },
            after: { header: after.header, content: after.content, isDeleted: after.isDeleted === true },
          });
        } else if (now) {
          unchanged.push({ factId: refId, header: now.header, content: now.content });
        }
      }
      const q8 = await ctx.q.q8(
        {
          dependent: { factId: depId, header: cur.header, content: cur.content, justification: cur.justification },
          changed,
          unchanged,
        },
        qctx,
      );
      const stillIds = new Set((q8.stillDepends ?? []).filter((id) => changed.some((c) => c.factId === id)));
      const dropped = changed.map((c) => c.factId).filter((id) => !stillIds.has(id));

      if (q8.holds) {
        if (dropped.length === 0) continue;
        // F8. The code drafts the version with the wrong references removed. No model call.
        added.push({
          factId: depId,
          header: cur.header,
          content: cur.content,
          justification: cur.justification,
          references: cur.references.filter((r) => !dropped.includes(r)),
        });
        continue;
      }

      const unit = await writeAndLint(ctx, env, {
        write: (lintFailure) => ctx.q.q9({ dependent: dep, reason: q8.reason, changed, lintFailure }, qctx),
        build: (res) => {
          const d = mustFromModel(res.drafts[0], "Q9 returned no draft");
          const refs = (d.references ?? []).filter((r) => !dropped.includes(r));
          if (d.isDeleted) {
            return [
              {
                factId: depId,
                header: cur.header,
                content: cur.content,
                justification: "",
                references: [],
                isDeleted: true,
              },
            ];
          }
          return [{ ...toDraft(d, depId, ""), references: refs }];
        },
      });
      added.push(...unit.drafts);
    }

    for (const d of added) {
      p.facts.push(d);
      visited.add(draftId(d));
    }
    // A reference-only draft (header, content and isDeleted equal the committed version) collects no dependents.
    frontier = added
      .filter((d) => {
        const committed = getFactMaterial(ctx.store, draftId(d))?.versions[0];
        const referenceOnly =
          committed?.header === d.header &&
          committed.content === d.content &&
          committed.isDeleted === (d.isDeleted === true);
        return !referenceOnly;
      })
      .map(draftId);
  }
  return { passes, rejudged };
}
