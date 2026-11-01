// technical/console.md, "Request": the fact versions a change wrote, as the timeline of the request page and the change page: the write
// marker and the header link, the word diff against the version before, the reference sets, and the agent's text.
import { MarkerClass } from "../../domain/enums.js";
import type { ChangeVersion } from "../../store/index.js";
import { versionWriteKind } from "../../store/index.js";
import { diffHtml } from "../diff.js";
import { html, type HtmlValue, type SafeHtml } from "../html.js";
import { empty, factLink, marker, quote, timeline, writeMarker, type TimelineEntry } from "./parts/index.js";

/** A reference in a set diff: its id. */
interface Identified {
  id: string;
}

// The references added and removed against the version before; null when nothing changed.
function setDiff<T extends Identified>(
  label: string,
  before: T[],
  after: T[],
  show: (x: T) => HtmlValue,
): SafeHtml | null {
  const beforeIds = new Set(before.map((x) => x.id));
  const afterIds = new Set(after.map((x) => x.id));
  const added = after.filter((x) => !beforeIds.has(x.id));
  const removed = before.filter((x) => !afterIds.has(x.id));
  if (added.length === 0 && removed.length === 0) return null;
  return html`${label}: ${added.map((x) => html`<ins>${show(x)}</ins> `)}
  ${removed.map((x) => html`<del>${show(x)}</del> `)}`;
}

// The justification and the change reasoning of a version, as stored (requirements/console.md, "Stored text").
function reasoning(justification: string, changeReasoning: string | null): SafeHtml {
  return html`${justification === "" ? empty("No justification: a derived version.") : quote(justification, "Justification")}
  ${changeReasoning === null || changeReasoning === "" ? empty("No change reasoning.") : quote(changeReasoning, "Change reasoning")}`;
}

// The set of a new fact's version: no version before it, so nothing is added or removed and no item is marked.
function setList<T>(label: string, items: T[], show: (x: T) => HtmlValue): SafeHtml | null {
  if (items.length === 0) return null;
  return html`${label}: ${items.map((x) => html`${show(x)} `)}`;
}

// A referenced fact as a header link (L6); a deleted fact keeps its last header with the deleted marker, an id that no
// fact has keeps its id in `code` with a muted word.
function referenceLink(wiki: string, v: ChangeVersion, id: string): SafeHtml {
  const label = v.referenceLabels[id];
  const header = label?.header ?? null;
  if (header === null) return html`<code>${id}</code> <span class="muted">unknown</span>`;
  const link = factLink(wiki, id, header);
  return label?.isDeleted === true ? html`${link} ${marker("deleted", MarkerClass.Bad)}` : link;
}

function versionEntry(wiki: string, v: ChangeVersion): TimelineEntry {
  const { version, previous } = v;
  const kind = versionWriteKind(version.isDeleted, previous);
  const headerDiff =
    previous !== null && previous.header !== version.header
      ? html`Header: ${diffHtml(previous.header, version.header)}`
      : null;
  const prevRefs = (previous?.references ?? []).map((id) => ({ id }));
  const refs = version.references.map((id) => ({ id }));
  const showRef = (r: { id: string }): SafeHtml => referenceLink(wiki, v, r.id);
  const sets =
    previous === null ? [setList("References", refs, showRef)] : [setDiff("References", prevRefs, refs, showRef)];
  const lines: SafeHtml[] = [
    ...(headerDiff === null ? [] : [headerDiff]),
    previous === null ? html`${version.content}` : diffHtml(previous.content, version.content),
    ...sets.flatMap((line) => (line === null ? [] : [line])),
  ];
  return {
    when: html`${writeMarker(kind)} ${factLink(wiki, v.factId, version.header)}`,
    what: lines.flatMap((line, i) => (i === 0 ? [line] : [html`<br />`, line])),
    fold: {
      summary: "Justification and reasoning",
      body: reasoning(version.justification, version.changeReasoning),
    },
  };
}

/**
 * Renders the fact versions a change wrote as a timeline: the write marker and the header link, the word diff of the
 * content against the version before with the references added and removed, and a fold with the agent's text
 * as stored.
 *
 * @param wiki - the wiki name
 * @param versions - the versions with the one before each
 * @returns the timeline, or the empty sentence when the change wrote no version
 * @sideEffects none
 */
export function versionTimeline(wiki: string, versions: ChangeVersion[]): SafeHtml {
  return timeline(
    versions.map((v) => versionEntry(wiki, v)),
    "This change wrote no version.",
  );
}
