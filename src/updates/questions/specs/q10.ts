// Q10, step 9. Drafting: what makes the prior query return the fact.
import { z } from "zod";
import { QuestionId, QuestionKind } from "../../../domain/enums.js";
import type { Q10Input, Q10Output } from "../../types.js";
import type { QuestionSpec } from "../call.js";
import { DRAFT_OUTPUT, FACT_STYLE, NO_JUSTIFICATION } from "../shared/prompts.js";
import { checkDrafts, draftResult, factMaterial } from "../shared/schemas.js";
import { lintBlock, renderFact, renderSubject } from "../shared/render.js";

const input: z.ZodType<Q10Input> = z.object({
  priorQuery: z.string(),
  target: factMaterial,
  results: z.array(z.object({ id: z.string(), header: z.string() })),
  lintFailure: z.string().optional(),
});

const system = `You are one step in a pipeline that keeps a wiki of facts. You repair a failed search.

${FACT_STYLE}

A submitter searched the wiki with the text in "prior_query", did not find the fact "target", and acted on reality. The search still does not return the target. The wiki's words and the submitter's words differ. You write what makes the search return it.

Write one equivalence fact. It says that the submitter's words and the wiki's words name the same thing. Example: the query "skellies" and a target about skeletons give the fact "Skellies are skeletons." under the header of the query's name for the thing.
- header: the thing in the submitter's words, as a scope (for example "Skellies"). Use the words of the query.
- content: one claim of the form "<the submitter's word> means <the wiki's word>", with explicit subjects, in the style above. Use the exact words of the query for the submitter's name, whole and in the same order (do not shorten, correct or re-inflect them: a search finds the fact by those words), and the target's own words for the wiki's name. Add no other claim and no value.
- references: exactly the target's id.

${NO_JUSTIFICATION}

${DRAFT_OUTPUT} Return exactly 1 draft.`;

export const q10: QuestionSpec<Q10Input, Q10Output> = {
  id: QuestionId.Q10,
  kind: QuestionKind.Drafting,
  system,
  input,
  output: draftResult,
  wiki: renderSubject,
  render: (i) =>
    `<prior_query>\n${i.priorQuery}\n</prior_query>\n${renderFact(i.target, "target")}\n<search_results_now>\n${
      i.results.length ? i.results.map((r) => `- fact ${r.id}: ${r.header}`).join("\n") : "(none)"
    }\n</search_results_now>${lintBlock(i.lintFailure)}`,
  check: (o) => checkDrafts(o, { max: 1 }),
};
