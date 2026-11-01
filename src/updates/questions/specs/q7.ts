// Q7, step 1. Classification: is the submission one claim, what are its claims when it holds several, and what kind of support does its justification give.
import { z } from "zod";
import { QuestionId, QuestionKind, SupportKind } from "../../../domain/enums.js";
import type { Q7Input, Q7Output } from "../../types.js";
import type { QuestionSpec } from "../call.js";

/** The input schema of Q7. */
const q7Item: z.ZodType<Q7Input> = z.object({ change: z.string(), justification: z.string() });
/** The output schema of Q7. */
const q7Fields = z.object({
  reason: z.string(),
  oneClaim: z.boolean(),
  claims: z.array(z.string()),
  support: z.enum(SupportKind),
});

/** The three rules of the claim check: one claim, the kind of support, the claims of a compound change. */
const CLAIM_CHECK_RULES = `1. oneClaim. A claim has one subject, one attribute and one value. The change is not one claim (oneClaim = false) when it holds two claims, that is, when a correction to one part would leave the other part standing, or when one part could be true and the other false. Signs: two subjects with their own values ("Creepers and zombies do 10 damage"), two attributes ("Skeletons are hostile and spawn at night"), a main claim with its own exception ("Creepers explode, unless a cat is near"), two sentences that say different things. It is also not one claim when a reader cannot act on it alone: a pronoun with no antecedent ("It does 10 damage"), a missing subject, a reference to something else ("as above", "also"), or half of a claim. Not compound: one attribute whose value has several parts ("A torch needs 1 coal and 1 stick and makes 4 torches" is one recipe), a list as the value, the configuration, the scope or the key of an attribute (two attributes of one subject are one claim when the second gives the first its configuration, its scope or its key: a model and its effort, a table and its primary key, a decision and its scope; they are two claims when a reader would look up each one alone, such as "hostile" and "spawns at night"), a reason or a consequence after "because", "since" or "so" (it says why the claim holds, or what follows from it; a reader does not correct it apart), a condition that is part of the measurement ("A charged creeper kills an unarmored player in one hit"), and context around a single claim ("In version 1.20, on normal difficulty, creepers do 10 damage").

2. support. What the justification gives.
- "observation": first-hand and repeatable. The submitter saw, measured, ran, or read the code or the document, and says so.
- "report": second-hand. Someone told the submitter, or a document says so and the submitter did not check.
- "belief": inference, opinion or assumption. "I think", "should be", "probably", "it makes sense".

3. claims. When oneClaim is false because the change holds two claims or more, list them: one entry per claim, in the order of the change. Write each entry so that a reader can act on it alone: keep its subject, its condition and its value, and replace a pronoun or an "also" with the subject it stands for. Do not add, drop or change a fact, and do not split one claim into parts. When oneClaim is true, or when the change cannot be acted on for another reason (a pronoun with no antecedent, half of a claim), claims is an empty list.

Judge the text only. You do not decide whether the claim is true. "reason" is one sentence: which rule fails, or the evidence you relied on.`;

const system = `You are one step in a pipeline that keeps a wiki of facts. You check a submission before anything else runs. You get the change (the claim) and the justification (how the submitter knows). You answer three narrow questions and use no outside knowledge.

${CLAIM_CHECK_RULES}`;

/**
 * Renders one submission as the Q7 message holds it.
 *
 * @param i - the change and its justification
 * @returns the `<change>` and `<justification>` blocks
 * @sideEffects none
 */
const renderSubmission = (i: Q7Input): string =>
  `<change>\n${i.change}\n</change>\n<justification>\n${i.justification}\n</justification>`;

export const q7: QuestionSpec<Q7Input, Q7Output> = {
  id: QuestionId.Q7,
  kind: QuestionKind.Classification,
  system,
  input: q7Item,
  output: q7Fields,
  render: (i) => renderSubmission(i),
};
