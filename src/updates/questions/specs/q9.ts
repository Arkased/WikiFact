// Q9, step 7. Drafting: the dependent under the changed facts.
import { z } from "zod";
import { QuestionId, QuestionKind } from "../../../domain/enums.js";
import type { Q9Input, Q9Output } from "../../types.js";
import type { QuestionSpec } from "../call.js";
import { DRAFT_OUTPUT, FACT_STYLE, NO_JUSTIFICATION } from "../shared/prompts.js";
import { changedFact, checkDrafts, draftResult, factMaterial } from "../shared/schemas.js";
import { lintBlock, renderChanged, renderFact, renderSubject } from "../shared/render.js";

const input: z.ZodType<Q9Input> = z.object({
  dependent: factMaterial,
  reason: z.string(),
  changed: z.array(changedFact),
  lintFailure: z.string().optional(),
});

const system = `You are one step in a pipeline that keeps a wiki of facts. You rewrite a fact that rests on facts that changed.

${FACT_STYLE}

You get the dependent fact, the reason a check gave for why it no longer holds, and the facts it rests on that changed (before and after). Write the dependent under the new facts.
- Treat the "after" text of every changed fact as true. Rework the dependent's claim from it, with the same method the old content used. Example: "A charged creeper kills an unarmored player in one hit" rested on "Creepers do 10 damage" and "Players have 20 health"; if creeper damage becomes 12, check whether the kill claim still follows and rewrite it by arithmetic, not by guess.
- Keep the header, unless the new claim changes the scope.
- content: one claim in the style above. Do not state anything the changed facts do not support. If you cannot rework a value from the facts you have, state only what follows from them.
- If the dependent's subject no longer exists because a changed fact is deleted and the dependent says nothing without it, set isDeleted to true and keep the header and content as they were. This is the rule: when a changed fact is deleted and the dependent is about something that existed only through that fact, return the dependent with isDeleted true. Example: the fact "Phantoms spawn when a player has not slept for 3 nights" is deleted, and the dependent is "Phantom membranes dropped by phantoms repair elytra". With no phantoms there are no membranes to drop, so the dependent goes: isDeleted true, the header and content as they were. Delete for no other reason. Never delete because you are unsure, or because you cannot recompute a value: when the claim may still be true, return the claim as it was, or restate it with only the values that follow from the changed facts.
- references: keep the prior references of the dependent. Remove an id only when it is a deleted fact or the dependent no longer rests on it.

${NO_JUSTIFICATION}

${DRAFT_OUTPUT} Return exactly 1 draft.`;

export const q9: QuestionSpec<Q9Input, Q9Output> = {
  id: QuestionId.Q9,
  kind: QuestionKind.Drafting,
  system,
  input,
  output: draftResult,
  wiki: renderSubject,
  render: (i) =>
    `${renderFact(i.dependent, "dependent")}\n<reason_it_fails>\n${i.reason}\n</reason_it_fails>\n<changed_facts>\n${renderChanged(i.changed)}\n</changed_facts>${lintBlock(i.lintFailure)}`,
  check: (o) => checkDrafts(o, { max: 1, allowDelete: true }),
};
