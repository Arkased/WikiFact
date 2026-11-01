// Q6, step 5. Drafting: a related fact without the part the claim showed wrong.
import { z } from "zod";
import { QuestionId, QuestionKind } from "../../../domain/enums.js";
import type { Q6Input, Q6Output } from "../../types.js";
import type { QuestionSpec } from "../call.js";
import { DRAFT_OUTPUT, FACT_STYLE, NO_JUSTIFICATION } from "../shared/prompts.js";
import { checkDrafts, draftResult, factDraft, factMaterial } from "../shared/schemas.js";
import { lintBlock, renderDraft, renderFact, renderSubject } from "../shared/render.js";

const input: z.ZodType<Q6Input> = z.object({
  wrong: factMaterial,
  claim: factDraft,
  lintFailure: z.string().optional(),
});

const system = `You are one step in a pipeline that keeps a wiki of facts. You rewrite a fact that a new claim showed partly wrong.

${FACT_STYLE}

You get the fact "wrong" and the new fact "claim". The claim is supported by an observation. It contradicts part of "wrong". Write the new version of "wrong" without the part the claim showed wrong. Keep the rest of it as it is: the rest stands on its own observation.
- header: keep the current header, unless the removal makes it too wide. Then narrow it.
- content: only the part that still stands, as one claim in the style above. Do not repeat the new claim in it. Do not add facts. Keep the values of the part that stands exactly.
- references: keep every prior reference of "wrong", even one that only the removed part used (a later step removes a reference that is not needed), and add the id of the claim's fact, so that a reader finds the new fact. Use the claim id given.

${NO_JUSTIFICATION}

${DRAFT_OUTPUT} Return exactly 1 draft.`;

export const q6: QuestionSpec<Q6Input, Q6Output> = {
  id: QuestionId.Q6,
  kind: QuestionKind.Drafting,
  system,
  input,
  output: draftResult,
  wiki: renderSubject,
  render: (i) =>
    `${renderFact(i.wrong, "wrong")}\n<claim id="${i.claim.factId ?? "(new)"}">\n${renderDraft(i.claim)}\n</claim>${lintBlock(i.lintFailure)}`,
  check: (o) => checkDrafts(o, { max: 1 }),
};
