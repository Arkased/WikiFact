// Q2, step 3. Judgment: of 2 live facts in one scope, which content stands.
import { z } from "zod";
import { Q2Stands, QuestionId, QuestionKind } from "../../../domain/enums.js";
import type { Q2Input, Q2Output } from "../../types.js";
import type { QuestionSpec } from "../call.js";
import { EVIDENCE_RULE } from "../shared/prompts.js";
import { factMaterial } from "../shared/schemas.js";
import { renderFact, renderSubject } from "../shared/render.js";

const input: z.ZodType<Q2Input> = z.object({ kept: factMaterial, other: factMaterial });

const output: z.ZodType<Q2Output> = z.object({
  stands: z.enum(Q2Stands),
  reason: z.string(),
});

const system = `You are one step in a pipeline that keeps a wiki of facts. You answer one narrow question.

The wiki must hold one live fact per scope. Two live facts, "kept" and "other", are in the same scope. They were written at different times from different submissions, so their contents may disagree. Decide which content stands. The content that stands becomes the one fact of the scope. The other fact is deleted.

Compare the current version of each fact: its content, and the justifications of its versions as observations of reality.
- When the two contents say the same thing, "kept" stands.
- When they disagree, the content backed by the stronger observation stands. Weigh what each justification says the submitter did and saw.
- When the observations are equally strong and the contents disagree, "kept" stands.
- When the two contents are about another subject or attribute, so that both can be true together, the answer is "unrelated". The matching read the headers only and over-matched a sibling scope. The facts must not merge, and neither is deleted. "Creeper damage: 10" and "Creeper damage on hard difficulty: 15" are unrelated: the second is a narrower scope with its own value. "Creeper damage: 10" and "Creeper explosion damage: 12" are the same scope, so the rules above decide "kept" or "other". Different values alone do not make facts unrelated: ask whether both can be true together.

${EVIDENCE_RULE}

Answer with "stands" ("kept", "other" or "unrelated") and a "reason" of one or two sentences.`;

export const q2: QuestionSpec<Q2Input, Q2Output> = {
  id: QuestionId.Q2,
  kind: QuestionKind.Judgment,
  system,
  input,
  output,
  wiki: renderSubject,
  render: (i) => `${renderFact(i.kept, "kept")}\n${renderFact(i.other, "other")}`,
};
