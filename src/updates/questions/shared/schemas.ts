// Zod schemas and the draft count rule that more than one question uses.
import { z } from "zod";
import type { ChangedFact, DraftResult, FactDraft, FactMaterial } from "../../types.js";

/** The schema of a fact with all its versions, as the pipeline passes it to a question. */
export const factMaterial: z.ZodType<FactMaterial> = z.object({
  factId: z.string(),
  isDeleted: z.boolean(),
  versions: z.array(
    z.object({
      seq: z.number(),
      header: z.string(),
      content: z.string(),
      justification: z.string(),
      references: z.array(z.string()),
      isDeleted: z.boolean(),
      created: z.number(),
    }),
  ),
});

/** The schema of a fact draft as the pipeline holds it. */
export const factDraft: z.ZodType<FactDraft> = z.object({
  factId: z.string().optional(),
  header: z.string(),
  content: z.string(),
  justification: z.string(),
  references: z.array(z.string()),
  isDeleted: z.boolean().optional(),
});

/** The schema of a fact that changed, with its text before and after. */
export const changedFact: z.ZodType<ChangedFact> = z.object({
  factId: z.string(),
  before: z.object({ header: z.string(), content: z.string() }),
  after: z.object({ header: z.string(), content: z.string(), isDeleted: z.boolean() }),
});

/** The schema of a fact draft as a model writes it, without the justification and the id. */
export const modelDraft = z.object({
  header: z.string(),
  content: z.string(),
  references: z.array(z.string()),
  isDeleted: z.boolean().optional(),
});

/** The schema of the answer of a drafting question: the drafts. */
export const draftResult: z.ZodType<DraftResult> = z.object({
  drafts: z.array(modelDraft),
});

/** Options of the draft count rule. */
export interface CheckDraftsOptions {
  /** The most drafts the answer may hold. */
  max: 1 | 2;
  /** Whether a draft may set `isDeleted`. */
  allowDelete?: boolean;
}

/**
 * Checks the count rule of technical/updates.md, "Pipeline": exactly one draft for every drafting question, (`max` 2 is for a caller that allows a second draft).
 *
 * @param out - the parsed answer of a drafting question
 * @param opts - the draft limit and whether a deletion is allowed
 * @returns the validation error, or undefined when the answer obeys the rule
 * @sideEffects none
 */
export function checkDrafts(out: DraftResult, opts: CheckDraftsOptions): string | undefined {
  if (out.drafts.length < 1 || out.drafts.length > opts.max) {
    return `drafts must hold ${opts.max === 1 ? "exactly 1 entry" : "1 or 2 entries"}, not ${out.drafts.length}`;
  }
  for (const d of out.drafts) {
    if (d.isDeleted && !opts.allowDelete) return "a draft must not set isDeleted for this question";
    if (!d.isDeleted && (!d.header.trim() || !d.content.trim())) return "header and content must not be empty";
  }
  return undefined;
}
