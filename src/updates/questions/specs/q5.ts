// Q5, step 5. Drafting: the claim's fact version.
import { z } from "zod";
import { QuestionId, QuestionKind } from "../../../domain/enums.js";
import type { Q5Input, Q5Output } from "../../types.js";
import type { QuestionSpec } from "../call.js";
import { DRAFT_OUTPUT, FACT_STYLE, NO_JUSTIFICATION } from "../shared/prompts.js";
import { checkDrafts, draftResult, factMaterial } from "../shared/schemas.js";
import { lintBlock, renderFact, renderFacts, renderSubject } from "../shared/render.js";

/** The input schema of Q5. */
const q5Item: z.ZodType<Q5Input> = z.object({
  change: z.string(),
  justification: z.string(),
  existing: factMaterial.optional(),
  related: z.array(factMaterial),
  negate: z.boolean().optional(),
  lintFailure: z.string().optional(),
});

/** How to write the draft of one claim. */
const DRAFT_RULES = `How to write the draft.
- One claim per fact. Return exactly one draft. Do not fragment one claim: a value that has several parts (a recipe, a bow at full draw dealing 6 damage) is one claim and stays in one fact. Each fact must stand alone: no pronouns, explicit subject, no "also", no "as above".
- When "existing" is present, the claim corrects that fact: keep its header, and write the new content. Return its full prior references list, and change it only if the claim changes what the fact rests on.
- When "existing" is absent, write a new fact. Choose the header as the scope, in the words a reader of the wiki would look for. Prefer the header style of the related facts.
- references: list every related fact that the claim rests on, that is, every fact whose value the claim's content was worked out from. "A charged creeper kills an unarmored player in one hit" rests on the creeper damage fact and the player health fact, so both ids go in "references"; leaving them out is an error, because a later change to either fact would not reach this one. A claim that was observed on its own, and does not use the value of a related fact, has no references. A related fact on the same topic, or one that states the same or a nearby value, is not a reference. Use the ids from the related facts. When "existing" is present, copy every id of its prior references into "references" first (an empty list loses them), then add any more.
- When "negate" is true, "existing" is a deleted fact that the claim restates with an observation too weak to restore it. Keep its header and its prior references. Write the content as one sentence with an explicit subject that says the claim of the existing fact is no longer true, for example "Fire resistance potions no longer last 3 minutes." Add no value, cause or detail that the existing content and the claim do not state.
- Keep the values of the claim exactly. Do not add detail the claim does not state. Do not use the justification as a source of new content.`;

const system = `You are one step in a pipeline that keeps a wiki of facts. You write the fact version for a claim that has been accepted.

${FACT_STYLE}

You get the claim, its justification (as evidence of what the claim means), the existing fact in the claim's scope (if the claim corrects it), and related facts.

${DRAFT_RULES}

${NO_JUSTIFICATION}

${DRAFT_OUTPUT}`;

/**
 * Renders the material of one claim as the Q5 message holds it, after the wiki block.
 *
 * @param i - the claim, its justification, the existing fact, the related facts and the retry material
 * @returns the claim blocks
 * @sideEffects none
 */
const renderDraftClaim = (i: Q5Input): string =>
  `<claim>\n${i.change}\n</claim>\n<justification>\n${i.justification}\n</justification>\n<existing>\n${
    i.existing ? renderFact(i.existing, "existing_fact") : "(none: write a new fact)"
  }\n</existing>\n<related>\n${renderFacts(i.related, "related_fact")}\n</related>${i.negate ? "\n<negate>true</negate>" : ""}${lintBlock(i.lintFailure)}`;

export const q5: QuestionSpec<Q5Input, Q5Output> = {
  id: QuestionId.Q5,
  kind: QuestionKind.Drafting,
  system,
  input: q5Item,
  output: draftResult,
  wiki: renderSubject,
  render: (i) => `${renderDraftClaim(i)}`,
  check: (o) => checkDrafts(o, { max: 1 }),
};
