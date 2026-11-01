import type { FactDraft, FactMaterial, ModelDraft } from "../types.js";
import { must } from "../../must.js";

/** One version of a fact as the agent reads it. */
export type MaterialVersion = FactMaterial["versions"][number];

/**
 * Returns the newest version of a fact.
 *
 * @param fact - a fact with at least one version
 * @returns the version at index 0 (newest first)
 * @throws {InvariantError} when the fact has no version
 * @sideEffects none
 */
export function currentVersion(fact: FactMaterial): MaterialVersion {
  return must(fact.versions[0], `fact ${fact.factId} has no version`);
}

/**
 * Returns the oldest version of a fact.
 *
 * @param fact - a fact with at least one version
 * @returns the last version of the newest-first list, that is the first one written
 * @throws {InvariantError} when the fact has no version
 * @sideEffects none
 */
export function oldestVersion(fact: FactMaterial): MaterialVersion {
  return must(fact.versions[fact.versions.length - 1], `fact ${fact.factId} has no version`);
}

/**
 * Returns the id of a draft.
 *
 * @param draft - a draft that already has its id (the pipeline assigns one to every draft before this call)
 * @returns the fact id
 * @throws {InvariantError} when the draft has no `factId`
 * @sideEffects none
 */
export function draftId(draft: FactDraft): string {
  return must(draft.factId, `draft "${draft.header}" has no factId`);
}

/**
 * Turns what a model drafted into a draft of the change set. The code sets the id and the justification.
 *
 * @param d - the model's draft
 * @param factId - the id of the fact
 * @param justification - the justification of the version
 * @returns the draft, with the references deduplicated
 * @sideEffects none
 */
export function toDraft(d: ModelDraft, factId: string, justification: string): FactDraft {
  return {
    factId,
    header: d.header,
    content: d.content,
    justification,
    references: [...new Set(d.references ?? [])],
    ...(d.isDeleted ? { isDeleted: true } : {}),
  };
}

/**
 * Joins two name lists without duplicates, comparing without case. The first spelling wins.
 *
 * @param a - the first list
 * @param b - the second list
 * @returns the union, `a` first
 * @sideEffects none
 */
export function unionNames(a: string[], b: string[]): string[] {
  const out: string[] = [];
  for (const x of [...a, ...b]) if (!out.some((y) => y.toLowerCase() === x.toLowerCase())) out.push(x);
  return out;
}
