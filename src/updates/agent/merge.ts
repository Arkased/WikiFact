import { ChangeOutcome, LogEvent, LogLevel, Q2Stands } from "../../domain/enums.js";
import { applyChange, getDependents, getFactMaterial, isLiveFact } from "../../store/index.js";
import type { ChangeSet, FactDraft, FactMaterial, Gathered, Request } from "../types.js";
import { logChange, questionContext } from "./context.js";
import { currentVersion, oldestVersion } from "./draft-utils.js";
import { writeAndLint, type LintEnv } from "./lint.js";
import { must, mustFromModel } from "../../must.js";
import { LintError, type AgentContext } from "./types.js";

/** What the merge did: `seq` is the merge change, or null when every other fact was unrelated and nothing was written. */
export interface MergeResult {
  seq: number | null;
  kept: FactMaterial;
  /** The ids of the facts that left the merge as unrelated; they stay live and unchanged. */
  unrelatedIds: string[];
}

/**
 * Step 3. Merges the live facts that match the change into one fact and commits the merge as its own change.
 * The fact with the most versions stays. The oldest stays on a tie. A fact that Q2 calls unrelated leaves the merge.
 *
 * @param ctx - the agent context
 * @param req - the request
 * @param g - the gathered material
 * @param live - the live matching facts, at least 2
 * @returns the fact that stays, the ids of the facts that Q2 called unrelated (they left the merge and stay live and
 *   unchanged), and the seq of the merge change; `seq` is null when every other fact is unrelated and nothing is written
 * @throws {LintError} when the merged fact fails the lint twice, or a dependent cannot be pointed at the kept fact
 * @throws {InvariantError} when `live` is empty or a dependent has no material
 * @sideEffects reads the store; one Q2 call per other fact, a Q3 drafting call; writes one change through
 *   `applyChange` (with an embedder run); logs one `LogEvent.Change` line, and one `LogEvent.ScopeOvermatch` line for
 *   each unrelated fact; with no related fact, makes no Q3 call and writes nothing
 */
export async function merge(ctx: AgentContext, req: Request, g: Gathered, live: FactMaterial[]): Promise<MergeResult> {
  const sorted = [...live].sort(
    (a, b) =>
      b.versions.length - a.versions.length ||
      oldestVersion(a).created - oldestVersion(b).created ||
      (a.factId < b.factId ? -1 : 1),
  );
  const [first, ...candidates] = sorted;
  const kept = must(first, "merge needs at least one fact");
  const qctx = questionContext(ctx);

  // Q2 decides, for each other fact, whose content stands. The standing fact meets the next other fact.
  let standing = kept;
  const reasons: string[] = [];
  const others: FactMaterial[] = [];
  const unrelatedIds: string[] = [];
  for (const other of candidates) {
    const r = await ctx.q.q2({ kept: standing, other }, qctx);
    if (r.stands === Q2Stands.Unrelated) {
      unrelatedIds.push(other.factId);
      ctx.log({
        event: LogEvent.ScopeOvermatch,
        level: LogLevel.Info,
        request_id: req.id,
        existingFactId: other.factId,
        keptFactId: standing.factId,
        reason: r.reason,
      });
      continue;
    }
    others.push(other);
    reasons.push(r.reason);
    if (r.stands === Q2Stands.Other) standing = other;
  }
  if (others.length === 0) return { seq: null, kept, unrelatedIds };
  const content = currentVersion(standing).content;

  // Q3 drafts the merged version. The code sets the references and the justification.
  const all = [kept, ...others];
  const otherIds = new Set(others.map((o) => o.factId));
  const refUnion: string[] = [];
  for (const f of all) {
    const cur = currentVersion(f);
    for (const r of cur.references) {
      if (r !== kept.factId && !otherIds.has(r) && !refUnion.includes(r) && isLiveFact(ctx.store, r)) refUnion.push(r);
    }
  }
  const justification = all.map((f) => currentVersion(f).justification).join("\n\n");

  const deletions: FactDraft[] = others.map((o) => {
    const cur = currentVersion(o);
    return {
      factId: o.factId,
      header: cur.header,
      content: cur.content,
      justification: cur.justification,
      references: [],
      isDeleted: true,
    };
  });
  const env: LintEnv = { drafted: new Set(all.map((f) => f.factId)) };
  const unit = await writeAndLint(ctx, env, {
    write: (lintFailure) => ctx.q.q3({ kept, others, content, lintFailure }, qctx),
    build: (res) => {
      const d = mustFromModel(res.drafts[0], "Q3 returned no draft");
      return [
        {
          factId: kept.factId,
          header: d.header,
          content: d.content,
          justification,
          references: refUnion,
        },
      ];
    },
  });

  const names = all.map((f) => `"${currentVersion(f).header}"`).join(", ");
  const mergedHeader = mustFromModel(unit.drafts[0], "the merge unit has no draft").header;
  const cs: ChangeSet = {
    outcome: ChangeOutcome.Accepted,
    summary: `Merged ${names} into "${mergedHeader}".`,
    changeReasoning: reasons.join(" "),
    facts: [...unit.drafts, ...deletions, ...repointDependents(ctx, kept, others)],
  };
  const { seq } = await applyChange(ctx.store, req.id, cs);
  logChange(ctx, req, { seq, outcome: ChangeOutcome.Accepted, kind: "merge", passes: 0, rejudged: 0 });
  return { seq, kept, unrelatedIds };
}

// Maintenance writes for the merge: each dependent of a merged-away fact gets a version that references
// the kept fact instead. Header, content and justification carry over. No model call.
// The code lint applies: every reference is the kept fact or a live fact.
function repointDependents(ctx: AgentContext, kept: FactMaterial, others: FactMaterial[]): FactDraft[] {
  const gone = new Set(others.map((o) => o.factId));
  const out: FactDraft[] = [];
  const seen = new Set<string>([kept.factId, ...gone]);
  for (const o of others) {
    for (const depId of getDependents(ctx.store, o.factId)) {
      if (seen.has(depId)) continue;
      seen.add(depId);
      const cur = currentVersion(must(getFactMaterial(ctx.store, depId), `dependent ${depId} not found`));
      const references = [...new Set(cur.references.map((r) => (gone.has(r) ? kept.factId : r)))];
      const bad = references.find((r) => r !== kept.factId && !isLiveFact(ctx.store, r));
      if (bad) throw new LintError(`reference ${bad} of ${depId} is not a live fact`);
      out.push({
        factId: depId,
        header: cur.header,
        content: cur.content,
        justification: cur.justification,
        references,
      });
    }
  }
  return out;
}
