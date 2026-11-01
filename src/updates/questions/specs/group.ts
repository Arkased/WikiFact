// The group call of the bulk test architecture C (technical/updates.md, "The candidate architectures of the bulk test"):
// 1 call judges the claims of 1 group (the rules of Q4) and drafts the facts they write (the rules of Q5).
import { z } from "zod";
import { GroupQuestionId, Q4Relation, QuestionKind } from "../../../domain/enums.js";
import type { FactMaterial, GroupAnswer, GroupInput, GroupOutput } from "../../types.js";
import type { QuestionSpec } from "../call.js";
import { modelDraft, factMaterial } from "../shared/schemas.js";
import { renderFact, renderFacts, renderSubject } from "../shared/render.js";
import { q4 } from "./q4.js";
import { q5 } from "./q5.js";

const input: z.ZodType<GroupInput> = z.object({
  claims: z.array(
    z.object({
      position: z.number().int(),
      change: z.string(),
      justification: z.string(),
      existing: factMaterial.optional(),
      related: z.array(factMaterial),
    }),
  ),
});

const output: z.ZodType<GroupOutput> = z.object({
  answers: z.array(
    z.object({
      position: z.number().int(),
      verdict: q4.output,
      target: z
        .union([z.object({ factId: z.string() }).strict(), z.object({ position: z.number().int() }).strict()])
        .optional(),
      draft: modelDraft.optional(),
    }),
  ),
});

/** The frame before the 2 sets of rules: what the group is and how to use the rules. */
const FRAME_INTRO = `You are one step in a pipeline that keeps a wiki of facts. You get the claims of one group, in queue order, and you judge and draft all of them in one answer. The claims of a group are about the same subject, so a later claim may depend on an earlier one.

For each claim do two jobs, in order. First judge the claim by the judgment rules. Then, when the verdict writes a fact, write the draft by the drafting rules. Each set of rules is given in full, between its tags. Where a set of rules says that you get a claim, its justification, the existing fact and the related facts, those are the blocks of that claim in the user message.`;

/** The frame after the 2 sets of rules: the order of the claims, the target, and the shape of the answer. */
const FRAME_GROUP = `How the claims of a group relate, and how to answer.
- The claims come in queue order. Judge and draft them in that order. A later claim is judged against the facts that the earlier claims of the group produce, as well as against the facts in its own blocks: the fact that an earlier claim writes is written before the later claim is, so it is the existing fact of its scope for the later claim, with the justification of the earlier claim.
- "target" is the fact that the claim is about, the "existing fact" of the rules. Set "factId" to the id of a fact in the blocks of the claims when the claim is about that fact. Set "position" to the position of an earlier claim of the group when the claim is about the fact that this earlier claim writes; that claim must be supported and must write a fact. Set exactly one of the two. Leave "target" out when the claim is new, that is, when the rules say there is no existing fact. Never name a fact that is not in the blocks, a later claim, or the claim itself.
- "verdict" holds the fields that the judgment rules ask for: supported, rejectReason, relation, wrongRelated and reason. "relation" is required when "target" is set and is left out otherwise. "wrongRelated" names facts in the blocks of that claim only.
- "draft" holds the one draft that the drafting rules ask for in "drafts". Write it when the verdict writes a fact, and leave it out otherwise: a claim that is not supported, a claim with relation "same" on a live fact, and a claim with relation "negates" write no fact. "references" holds ids from the blocks only.
- Answer with the JSON object of the schema: "answers" holds one entry for each claim, in the order of the claims, each with the "position" of its claim. Where the rules above describe an answer with "reason" or "drafts", the answer is the entry of the claim.`;

const system = `${FRAME_INTRO}

<judgment_rules>
${q4.system}
</judgment_rules>

<drafting_rules>
${q5.system}
</drafting_rules>

${FRAME_GROUP}`;

/**
 * Collects the facts that the blocks of a group hold, by id.
 *
 * @param i - the input of the group call
 * @returns each existing and related fact of every claim
 * @sideEffects none
 */
function factsOf(i: GroupInput): Map<string, FactMaterial> {
  const facts = new Map<string, FactMaterial>();
  for (const c of i.claims) for (const f of [...(c.existing ? [c.existing] : []), ...c.related]) facts.set(f.factId, f);
  return facts;
}

/**
 * Tells whether a verdict writes a fact for its claim, by the table of technical/updates.md, "Step 4. Judge": a supported
 * claim writes one unless it repeats a live fact (`same`) or negates one (`negates`, which deletes it).
 *
 * @param a - the answer
 * @param target - the fact the target names, when it is a fact of the group
 * @returns true when the answer needs a draft
 * @sideEffects none
 */
function writesFact(a: GroupAnswer, target: FactMaterial | undefined): boolean {
  if (!a.verdict.supported) return false;
  if (a.verdict.relation === Q4Relation.Negates) return false;
  if (a.verdict.relation === Q4Relation.Same) return target?.isDeleted === true;
  return true;
}

/**
 * Checks the rules that the schema cannot say: one answer for each claim in order, the rules of Q4 for the verdict, a target
 * that is a fact of the group or an earlier claim that writes a fact, and a draft where the verdict writes a fact.
 *
 * @param o - the parsed answer
 * @param i - the claims
 * @returns the first error found, which goes back to the model in the one retry, or undefined
 * @sideEffects none
 */
function check(o: GroupOutput, i: GroupInput): string | undefined {
  if (o.answers.length !== i.claims.length) {
    return `answers must hold one entry for each of the ${i.claims.length} claims, not ${o.answers.length}`;
  }
  const facts = factsOf(i);
  // For each answer checked so far: whether it writes a fact (a revival of a deleted fact included).
  const writes: boolean[] = [];
  for (const [n, a] of o.answers.entries()) {
    const at = `answer ${n + 1}`;
    if (a.position !== n + 1) return `${at} must have position ${n + 1}: answer in the order of the claims`;
    const v = a.verdict;
    if (!v.supported && !v.rejectReason) return `${at}: rejectReason is required when supported is false`;
    let target: FactMaterial | undefined;
    if (a.target) {
      if ("factId" in a.target) {
        const { factId } = a.target;
        target = facts.get(factId);
        if (!target) return `${at}: target ${factId} is not a fact of the group`;
      } else {
        const { position } = a.target;
        // An earlier claim that revives a deleted fact writes a fact too: `writes` holds its verdict against its own target.
        if (position >= a.position || writes[position - 1] !== true) {
          return `${at}: target position ${position} is not an earlier claim of the group that writes a fact`;
        }
      }
      if (v.supported && !v.relation) return `${at}: relation is required when a target is present`;
    }
    const writing = writesFact(a, target);
    writes.push(writing);
    if (writing) {
      if (!a.draft) return `${at}: draft is required when the verdict writes a fact`;
      if (!a.draft.isDeleted && (!a.draft.header.trim() || !a.draft.content.trim())) {
        return `${at}: the header and the content of the draft must not be empty`;
      }
    }
  }
  return undefined;
}

/** The spec of the group call. Its model and effort are those of Q4 (the caller passes them). */
export const groupSpec: QuestionSpec<GroupInput, GroupOutput, GroupQuestionId> = {
  id: GroupQuestionId.Group,
  kind: QuestionKind.Judgment,
  system,
  input,
  output,
  wiki: renderSubject,
  render: (i) =>
    `<claims>\n${i.claims
      .map(
        (c) =>
          `<claim position="${c.position}">\n<change>\n${c.change}\n</change>\n<justification>\n${c.justification}\n</justification>\n<existing>\n${
            c.existing ? renderFact(c.existing, "existing_fact") : "(no existing fact in the claim's scope)"
          }\n</existing>\n<related>\n${renderFacts(c.related, "related_fact")}\n</related>\n</claim>`,
      )
      .join("\n")}\n</claims>`,
  check,
};
