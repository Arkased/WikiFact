import { isLiveFact } from "../../store/index.js";
import type { DraftResult, FactDraft, ModelDraft } from "../types.js";
import type { AgentContext } from "./types.js";
import { LintError } from "./types.js";

/** The drafts of one question. */
export interface Unit {
  drafts: FactDraft[];
}

/** What the lint of step 6 checks a unit against. */
export interface LintEnv {
  /** Fact ids drafted in this change set. */
  drafted: Set<string>;
}

/** How `writeAndLint` calls a question and builds the drafts from its answer. */
export interface DraftSpec {
  /** Calls the question. `lintFailure` is set on the retry. */
  write: (lintFailure?: string) => Promise<DraftResult>;
  /** Turns the answer into the drafts of the change set. */
  build: (res: DraftResult) => FactDraft[];
}

/** A question answers with exactly one draft. */
const DRAFT_COUNT = 1;

/**
 * technical/updates.md, "Step 6. Lint": checks that every field of a draft is present.
 *
 * @param d - the model's draft
 * @returns the failure text, or null when the draft is complete
 * @sideEffects none
 */
function checkFields(d: ModelDraft): string | null {
  const bad: string[] = [];
  if (d.isDeleted !== true) {
    if (typeof d.header !== "string" || d.header.trim() === "") bad.push("header");
    if (typeof d.content !== "string" || d.content.trim() === "") bad.push("content");
  }
  if (!Array.isArray(d.references)) bad.push("references");
  return bad.length > 0 ? `missing field: ${bad.join(", ")}` : null;
}

/**
 * Writes a unit with one model call, then lints it. A failure goes back to the same question as
 * `lintFailure`, once. A second failure throws a LintError.
 *
 * @param ctx - the agent context
 * @param env - what the lint checks references against
 * @param spec - the question call and the builder of the drafts
 * @returns the drafts that passed
 * @throws {LintError} when the unit fails the lint on the second attempt
 * @throws {Error} when the question does not return exactly one draft
 * @sideEffects one question call per attempt (at most 2); reads the store
 */
export async function writeAndLint(ctx: AgentContext, env: LintEnv, spec: DraftSpec): Promise<Unit> {
  const attempt = async (lintFailure?: string): Promise<{ unit: Unit; failure: string | null }> => {
    const res = await spec.write(lintFailure);
    const count = res?.drafts?.length ?? 0;
    if (count !== DRAFT_COUNT) throw new Error(`question output invalid: expected one draft, got ${count}`);
    const shape = res.drafts.map(checkFields).find((f) => f !== null) ?? null;
    if (shape) return { unit: { drafts: [] }, failure: shape };
    const unit: Unit = { drafts: spec.build(res) };
    return { unit, failure: lint(ctx, env, unit) };
  };
  const first = await attempt();
  if (first.failure === null) return first.unit;
  const second = await attempt(first.failure);
  if (second.failure === null) return second.unit;
  throw new LintError(`draft failed lint twice: ${second.failure}`);
}

/**
 * Step 6. The code checks: every reference is a live or drafted fact, and no draft references itself.
 *
 * @param ctx - the agent context
 * @param env - what the lint checks references against
 * @param unit - the drafts to check
 * @returns the failures joined, or null when the unit passes
 * @sideEffects reads the store
 */
function lint(ctx: AgentContext, env: LintEnv, unit: Unit): string | null {
  const failures: string[] = [];
  const unitIds = new Set(unit.drafts.map((d) => d.factId));
  for (const d of unit.drafts) {
    if (d.isDeleted) continue;
    for (const ref of d.references) {
      if (ref === d.factId) failures.push(`reference ${ref} points at the fact itself`);
      else if (!isLiveFact(ctx.store, ref) && !env.drafted.has(ref) && !unitIds.has(ref)) {
        failures.push(`reference ${ref} is not a live fact`);
      }
    }
  }
  return failures.length > 0 ? failures.join("; ") : null;
}
