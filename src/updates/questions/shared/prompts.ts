// Prompt text that more than one question uses. Byte-identical to what the question sets measured.

/** The style of a fact: its fields and the rule for each (design/data-model.md, "Fact"). */
export const FACT_STYLE = `A fact is the atomic unit of the wiki. It has these fields.
- header: the scope of the fact, what it is about, not the claim. Example: "Creeper damage". The scope is the identity of the fact. One scope holds one fact. A second claim in the same scope is a correction, not a new fact.
- content: the claim. Example: "Creepers do 10 damage". One claim, about 10 to 20 words, with an explicit subject and no pronouns, so that a reader can act on it alone, without the header.
- references: the ids of the facts this fact depends on, that is, facts it was worked out from. A fact that was observed on its own depends on nothing.`;

/** How to weigh justifications as evidence (technical/updates.md, "Evidence rule"). For Q2 and Q4. */
export const EVIDENCE_RULE = `How to weigh the text you are given.
- A justification is an observation of reality that a submitter made, stored as sent. It counts as evidence. A stronger observation (a measurement, a count, a test with a stated setup) outweighs a weaker one (a belief, a rumor, no stated setup). A newer observation does not outweigh an older one by being newer. A claim that the game changed needs an observation that says so.
- A version with an empty justification was derived by the pipeline from the facts it references. The evidence sits on those facts, not on the version.
- You see no summaries and no past reasoning of the pipeline. If you did, they would not be evidence about reality.`;

/** The instruction that the code, not the model, writes the justification. */
export const NO_JUSTIFICATION = `Do not write a justification. The code sets it. Do not decide whether to write: the decision is made, and you write the text.`;

/** The instruction that describes the output object of a drafting question. */
export const DRAFT_OUTPUT = `Answer with the JSON object of the schema. "drafts" holds the fact version you write.`;
