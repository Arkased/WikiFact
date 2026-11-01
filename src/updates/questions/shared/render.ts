// Renderers of the user message that more than one question uses.
import type { ChangedFact, FactDraft, FactMaterial, QuestionContext } from "../../types.js";

/**
 * Renders the wiki subject, the cached block of every question.
 *
 * @param ctx - the subject of the wiki
 * @returns the `<wiki>` block with the subject
 * @sideEffects none
 */
export const renderSubject = (ctx: QuestionContext): string =>
  `<wiki>\nSubject: ${ctx.subject || "(not stated)"}\n</wiki>`;

/**
 * Renders one fact with all its versions, newest first.
 *
 * @param f - the fact material
 * @param label - the element name of the block
 * @returns the block of the fact
 * @sideEffects none
 */
export function renderFact(f: FactMaterial, label = "fact"): string {
  const vs = f.versions
    .map((v, i) => {
      const lines = [
        `  <version n="${i + 1}" seq="${v.seq}"${i === 0 ? ' current="true"' : ""}${v.isDeleted ? ' deleted="true"' : ""}>`,
        `    header: ${v.header}`,
        `    content: ${v.content}`,
        `    references: ${v.references.join(", ") || "(none)"}`,
        `    justification: ${v.justification.trim() ? v.justification : "(empty: derived by the pipeline)"}`,
        "  </version>",
      ];
      return lines.join("\n");
    })
    .join("\n");
  return `<${label} id="${f.factId}" ${f.isDeleted ? 'status="deleted"' : 'status="live"'}>\n${vs}\n</${label}>`;
}

/**
 * Renders a list of facts, one block each.
 *
 * @param fs - the fact materials
 * @param label - the element name of each block
 * @returns the blocks joined by newlines, or "(none)" for an empty list
 * @sideEffects none
 */
export const renderFacts = (fs: FactMaterial[], label = "fact"): string =>
  fs.length ? fs.map((f) => renderFact(f, label)).join("\n") : "(none)";

/**
 * Renders the facts that changed, with their text before and after.
 *
 * @param cs - the changed facts
 * @returns one `<changed>` block each, or "(none)" for an empty list
 * @sideEffects none
 */
export function renderChanged(cs: ChangedFact[]): string {
  return cs.length
    ? cs
        .map(
          (c) =>
            `<changed id="${c.factId}">\n  before: ${c.before.header}: ${c.before.content}\n  after: ${c.after.header}: ${c.after.content}${c.after.isDeleted ? " (DELETED)" : ""}\n</changed>`,
        )
        .join("\n")
    : "(none)";
}

/**
 * Renders a fact draft without its justification.
 *
 * @param d - the draft
 * @returns the three lines of the draft
 * @sideEffects none
 */
export function renderDraft(d: FactDraft): string {
  return `header: ${d.header}\ncontent: ${d.content}\nreferences: ${d.references.join(", ") || "(none)"}`;
}

/**
 * Renders the block that tells the model why its previous draft failed a check.
 *
 * @param lintFailure - the reason of the failure, absent on the first attempt
 * @returns the `<lint_failure>` block, or an empty string
 * @sideEffects none
 */
export const lintBlock = (lintFailure?: string): string =>
  lintFailure
    ? `\n<lint_failure>\nYour previous draft failed a check. Fix it. The reason: ${lintFailure}\n</lint_failure>`
    : "";
