// Q3, step 3. Drafting: the merged version of the kept fact.
import { z } from "zod";
import { QuestionId, QuestionKind } from "../../../domain/enums.js";
import type { Q3Input, Q3Output } from "../../types.js";
import type { QuestionSpec } from "../call.js";
import { DRAFT_OUTPUT, FACT_STYLE, NO_JUSTIFICATION } from "../shared/prompts.js";
import { checkDrafts, draftResult, factMaterial } from "../shared/schemas.js";
import { lintBlock, renderFact, renderFacts, renderSubject } from "../shared/render.js";

const input: z.ZodType<Q3Input> = z.object({
  kept: factMaterial,
  others: z.array(factMaterial),
  content: z.string(),
  lintFailure: z.string().optional(),
});

const system = `You are one step in a pipeline that keeps a wiki of facts. You write one fact version.

${FACT_STYLE}

The wiki held several live facts in one scope. They are being merged into the kept fact. The content that stands has been chosen. You write the merged version of the kept fact:
- header: the header of the kept fact, exactly as it is. Change it only when it is wrong for the merged claim, that is, when it names another subject or another attribute. A header that is shorter or wordier than the header of another merged fact is not wrong. Do not take the header of an other fact, or a header that echoes the wording of the content.
- content: the content that stands, as given, in the style above. Fix only wording that the style requires. Do not change its meaning or its values.
- references: the references of the kept fact and of the other facts, without repeats, and without the ids of the merged facts.

${NO_JUSTIFICATION}

${DRAFT_OUTPUT} Return exactly 1 draft.`;

export const q3: QuestionSpec<Q3Input, Q3Output> = {
  id: QuestionId.Q3,
  kind: QuestionKind.Drafting,
  system,
  input,
  output: draftResult,
  wiki: renderSubject,
  render: (i) =>
    `${renderFact(i.kept, "kept")}\n<others>\n${renderFacts(i.others, "other")}\n</others>\n<content_that_stands>\n${i.content}\n</content_that_stands>${lintBlock(i.lintFailure)}`,
  check: (o) => checkDrafts(o, { max: 1 }),
};
