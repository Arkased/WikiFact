// How the pages say a request kind and the document of an `operatorEdit` request (technical/console.md, "The `operatorEdit` request"): in words, with the
// operator's note.
import { CleanupFinder, OperatorEditKind, RequestKind, assertNever } from "../../domain/enums.js";
import {
  namesOf,
  parseOperatorEdit,
  parseCleanupRepair,
  cleanupRepairTargets,
  type IdNames,
  type OperatorEdit,
  type Store,
  type CleanupRepair,
} from "../../store/index.js";
import { html, type SafeHtml } from "../html.js";
import { factLink, type KvRow } from "./parts/index.js";

/**
 * Names a request kind as a page shows it.
 *
 * @param kind - the `kind` column of a request row; the page shows words, not the stored value (technical/console.md, "The `operatorEdit` request")
 * @returns "submission", "lookup repair", "operator edit" or "cleanup"
 * @sideEffects none
 */
export function kindLabel(kind: RequestKind): string {
  switch (kind) {
    case RequestKind.Submission:
      return "submission";
    case RequestKind.LookupRepair:
      return "lookup repair";
    case RequestKind.OperatorEdit:
      return "operator edit";
    case RequestKind.CleanupRepair:
      return "cleanup";
  }
  return assertNever(kind);
}

/**
 * Names what an operator edit does.
 *
 * @param edit - the `edit` field of the request document, which the worker switches on
 * @returns the name in words
 * @sideEffects none
 */
export function editName(edit: OperatorEditKind): string {
  switch (edit) {
    case OperatorEditKind.Cleanup:
      return "cleanup run";
    case OperatorEditKind.Reindex:
      return "reindex";
  }
  return assertNever(edit);
}

/**
 * Reads the `change` text of an `operatorEdit` request.
 *
 * @param change - the `change` column of a request row: JSON text for an `operatorEdit`, NULL on a repair row
 * @returns the edit, or `undefined` for no text or a document that is not a valid edit
 * @sideEffects none
 */
export function readEdit(change: string | null): OperatorEdit | undefined {
  if (change === null) return undefined;
  try {
    return parseOperatorEdit(change);
  } catch {
    return undefined;
  }
}

function factRef(names: IdNames, wiki: string, id: string): SafeHtml {
  const header = names.facts.get(id);
  if (header !== undefined) return factLink(wiki, id, header);
  return html`<span class="mono">${id}</span> <span class="muted">(unknown fact)</span>`;
}

/**
 * Names a finder of the cleanup by what it looks for (technical/cleanup.md, "Cleanup").
 *
 * @param finder - the finder of a `cleanupRepair` document or a `cleanup_repair` log line
 * @returns the name in words
 * @sideEffects none
 */
export function finderName(finder: CleanupFinder): string {
  switch (finder) {
    case CleanupFinder.DuplicateFact:
      return "the duplicate fact check";
  }
  return assertNever(finder);
}

function editWords(edit: OperatorEdit): SafeHtml {
  switch (edit.edit) {
    case OperatorEditKind.Cleanup:
      return html`run the cleanup on the whole wiki: merge duplicate facts`;
    case OperatorEditKind.Reindex:
      return html`reindex the wiki`;
  }
  return assertNever(edit);
}

function repairWords(names: IdNames, wiki: string, repair: CleanupRepair): SafeHtml {
  const check = finderName(repair.finder);
  return html`${check}: the facts ${factRef(names, wiki, repair.factIds[0])} and
  ${factRef(names, wiki, repair.factIds[1])} may be 1 fact`;
}

function parseRepair(change: string): CleanupRepair | undefined {
  try {
    return parseCleanupRepair(change);
  } catch {
    return undefined;
  }
}

/** The kind and the `change` column of a request, which is all the words need. */
interface ChangeSource {
  kind: RequestKind;
  change: string | null;
}

function refsOf(request: ChangeSource): string[] {
  if (request.change === null || request.kind !== RequestKind.CleanupRepair) return [];
  const repair = parseRepair(request.change);
  return repair === undefined ? [] : cleanupRepairTargets(repair);
}

/**
 * Reads the names of every fact that the words of some requests mention, in one store call.
 *
 * @param store - the open store
 * @param requests - the requests a page shows
 * @returns the names for `changeWords`
 * @sideEffects reads the store
 */
export function changeNames(store: Store, requests: ChangeSource[]): IdNames {
  return namesOf(store, requests.flatMap(refsOf));
}

/**
 * Says the `change` text of an `operatorEdit` or a `cleanupRepair` request in words, with links to the facts it
 * names (requirements/console.md, "Plain words"). The operator's note is not part of it.
 *
 * @param names - the names of the ids the request mentions, from `changeNames`
 * @param wiki - the wiki name, for the links
 * @param request - the kind and the `change` column of the request
 * @returns the sentence; `undefined` for a kind with its own text, no text, or a document that does not parse
 * @sideEffects none
 */
export function changeWords(names: IdNames, wiki: string, request: ChangeSource): SafeHtml | undefined {
  if (request.change === null) return undefined;
  if (request.kind === RequestKind.OperatorEdit) {
    const edit = readEdit(request.change);
    return edit === undefined ? undefined : editWords(edit);
  }
  if (request.kind === RequestKind.CleanupRepair) {
    const repair = parseRepair(request.change);
    return repair === undefined ? undefined : repairWords(names, wiki, repair);
  }
  return undefined;
}

/**
 * Lists the fields of an operator edit as the rows of a key-value list, for the request page.
 *
 * @param edit - the parsed document
 * @returns the edit's name, the ids and values it carries, and the operator's note as stored
 * @sideEffects none
 */
export function editRows(edit: OperatorEdit): KvRow[] {
  const head: KvRow = { term: "Operator edit", value: editName(edit.edit) };
  const note: KvRow = { term: "Why", value: edit.note };
  return [head, note];
}
