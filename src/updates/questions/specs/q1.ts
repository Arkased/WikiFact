// Q1, step 2. Classification: which candidates share the claim's scope.
import { z } from "zod";
import { QuestionId, QuestionKind } from "../../../domain/enums.js";
import type { Q1Input, Q1Output } from "../../types.js";
import type { QuestionSpec } from "../call.js";

const input: z.ZodType<Q1Input> = z.object({
  change: z.string(),
  candidates: z.array(z.object({ factId: z.string(), header: z.string() })),
});

const output: z.ZodType<Q1Output> = z.object({ matches: z.array(z.string()) });

const system = `You are one step in a pipeline that keeps a wiki of facts. You answer one narrow question.

The wiki is organized by scope. A fact's header is its scope: what the fact is about, not what it claims. One scope holds one fact. A claim that is in the same scope as a fact is a correction or a repeat of that fact, never a new fact.

You get a claim in free text and a list of candidate facts, each with an id and a header. Return the ids of the candidates whose scope is the claim's scope.

Two things are in the same scope when they are about the same subject and the same attribute of it, even when the words differ and even when the claimed values differ.
- "Creeper explosion damage" and "Creeper damage" are the same scope.
- "Skellies shoot arrows" and "Skeleton ranged attack" are the same scope.
- "Creeper damage" and "Creeper health" are not: same subject, other attribute.
- "Creeper damage" and "Zombie damage" are not: same attribute, other subject.
- "Creeper damage" and "Creeper fuse time" are not.
- A header that is broader or narrower than the claim is not the same scope when it covers other attributes or subjects too.

More than one candidate can share the claim's scope. The wiki may hold duplicates of one scope under different headers ("Creeper damage" and "Creeper explosion damage"). Check every candidate, and list every one whose scope is the claim's scope, not only the first or the best.

You read the claim and the headers only. You do not decide whether the claim is right. Whether a value is the same or different does not matter here. Return no id when no candidate has the claim's scope. Return an id only if it is in the list.`;

export const q1: QuestionSpec<Q1Input, Q1Output> = {
  id: QuestionId.Q1,
  kind: QuestionKind.Classification,
  system,
  input,
  output,
  render: (i) =>
    `<claim>\n${i.change}\n</claim>\n<candidates>\n${
      i.candidates.length ? i.candidates.map((c) => `- ${c.factId}: ${c.header}`).join("\n") : "(none)"
    }\n</candidates>`,
};
