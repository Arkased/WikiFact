// Q8, step 7. Classification: does this dependent still hold.
import { z } from "zod";
import { QuestionId, QuestionKind } from "../../../domain/enums.js";
import type { Q8Input, Q8Output } from "../../types.js";
import type { QuestionSpec } from "../call.js";
import { renderChanged } from "../shared/render.js";
import { changedFact } from "../shared/schemas.js";

const input: z.ZodType<Q8Input> = z.object({
  dependent: z.object({ factId: z.string(), header: z.string(), content: z.string(), justification: z.string() }),
  changed: z.array(changedFact),
  unchanged: z.array(z.object({ factId: z.string(), header: z.string(), content: z.string() })),
});

const output: z.ZodType<Q8Output> = z.object({
  holds: z.boolean(),
  stillDepends: z.array(z.string()),
  reason: z.string(),
});

const system = `You are one step in a pipeline that keeps a wiki of facts. You answer one narrow question. You classify and you do not rewrite.

A fact can rest on other facts. You get a dependent fact, the facts it lists as references that just changed (with their text before and after), and its other references that did not change. Decide two things.

1. holds. The dependent holds when its content is true under the new content of every changed fact. Work it out: take the new content of each changed fact as true, and check the dependent's content against it. Rules:
- A dependent whose justification names an old value, and whose content stays true under the new values, holds. The justification describes what its submitter saw. It is not a reason to say the dependent fails.
- A dependent whose content states or uses the old value fails to hold.
- When a changed fact is deleted, the dependent holds only if its content is true without that fact.
- Compare meaning, not wording. A reworded base fact with the same value changes nothing.
- A change that keeps the claim true leaves it true: a value that moves in the direction the claim needs, or that does not cross the threshold the claim states. Use ordinary knowledge of the game for a constant the facts do not give (a charged creeper does double damage). Answer false only when you can show that the new content makes the claim untrue, or that a deleted base leaves the claim without support. Doubt alone is not a reason to answer false.

2. stillDepends. The ids, from the changed facts, that the dependent still rests on. A dependent depends on a changed fact when its content uses that fact: it states a number, a count, a comparison or a consequence that was worked out from it, so the content would need a change if that fact changed again. Some cases are easy to get wrong.
- The dependent rests on the fact, not on the part that changed. A bed recipe whose planks changed is still the base of "Making 2 beds needs 6 wool": the id stays in stillDepends.
- A reworded base with the same value is still a base.
- A justification that records what the submitter saw ("I counted 7 hits") does not make the content independent. If the content uses the value of the changed fact, the dependent rests on it.
- A content that says something the changed fact says nothing about (a color, a sound, a hiss) does not rest on it. Its stillDepends is empty, even when it lists the reference ("Creepers are green" referencing "Creeper damage").
- A dependent never depends on a deleted fact.
Return only ids from the changed facts.

"reason" is one sentence.`;

export const q8: QuestionSpec<Q8Input, Q8Output> = {
  id: QuestionId.Q8,
  kind: QuestionKind.Classification,
  system,
  input,
  output,
  render: (i) => {
    const d = i.dependent;
    // An empty list renders as an empty line here, as the prompt was measured; renderChanged says "(none)".
    const changed = i.changed.length ? renderChanged(i.changed) : "";
    const unchanged = i.unchanged.length
      ? i.unchanged.map((u) => `<unchanged id="${u.factId}">${u.header}: ${u.content}</unchanged>`).join("\n")
      : "(none)";
    return `<dependent id="${d.factId}">\n  header: ${d.header}\n  content: ${d.content}\n  justification: ${d.justification.trim() || "(empty)"}\n</dependent>\n${changed}\n<unchanged_references>\n${unchanged}\n</unchanged_references>`;
  },
};
