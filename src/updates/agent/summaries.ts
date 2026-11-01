import { ChangeOutcome } from "../../domain/enums.js";
import type { FactMaterial, Judgment } from "../types.js";
import { currentVersion } from "./draft-utils.js";
import { must } from "../../must.js";
import type { Drafted } from "./draft.js";

/**
 * Writes the summary line of a change that writes no fact.
 *
 * @param j - the judgment, a duplicate or a rejection
 * @param existing - the existing fact; the duplicate names it
 * @returns the summary text, naming the duplicated header or the reject reason
 * @throws {InvariantError} when the judgment is a duplicate and `existing` is undefined
 * @sideEffects none
 */
export function summaryNoWrite(j: Judgment, existing: FactMaterial | undefined): string {
  if (j.outcome === ChangeOutcome.Duplicate) {
    const header = currentVersion(must(existing, "a duplicate judgment has no existing fact")).header;
    return `Duplicate of "${header}".`;
  }
  return `Rejected as ${j.rejectReason}.`;
}

/**
 * Writes the summary line of an accepted change: one part per labeled draft, then one per dependent.
 *
 * @param p - the drafts with their labels; the facts after the labels are the dependents of step 7
 * @returns the summary text
 * @sideEffects none
 */
export function summaryAccepted(p: Drafted): string {
  const dependents = p.facts.slice(p.labels.length);
  const parts = [
    ...p.labels,
    ...dependents.map((d) =>
      d.isDeleted
        ? `deleted dependent "${d.header}"`
        : d.justification === ""
          ? `rewrote dependent "${d.header}"`
          : `dropped references of "${d.header}"`,
    ),
  ];
  return parts.join("; ") + ".";
}
