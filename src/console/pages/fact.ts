// technical/console.md, "Fact": the fact page. The fact block (content, justification, why this version) and the history timeline in
// the main column and the details in the side column. The page has no control: the console edits no fact. The
// agent's text (justification, change reasoning, summary) shows as stored (requirements/console.md, "Stored text").
import { ConsoleErrorKind, ConsoleSection, GridColumns, MarkerClass, RetrievalKind } from "../../domain/enums.js";
import { getFactDetail, type FactDetail, type FactDetailVersion, type FactVersion } from "../../store/index.js";
import { diffHtml } from "../diff.js";
import { ConsoleError } from "../errors.js";
import { html, layout, time, type SafeHtml } from "../html.js";
import type { PageContext } from "../page.js";
import {
  column,
  empty,
  factLink,
  fold,
  grid,
  kv,
  liveMarker,
  marker,
  meter,
  none,
  notice,
  objectPath,
  panel,
  quote,
  timeline,
  withWiki,
  type KvRow,
  type TimelineEntry,
} from "./parts/index.js";

// The markers of technical/console.md, "Fact": observed (it reset confidence) and derived (empty justification).
function stateMarkers(v: { observed: boolean; justification: string }): SafeHtml[] {
  const out: SafeHtml[] = [];
  if (v.observed) out.push(marker("observed", MarkerClass.Observed, "This version reset the confidence."));
  if (v.justification === "") {
    out.push(
      marker(
        "derived",
        MarkerClass.Derived,
        "The pipeline derived this version from the facts it references; nobody looked.",
      ),
    );
  }
  return out;
}

// The markers of a version in the history: deletion, revival, observed and derived.
function versionMarkers(v: FactDetailVersion, prev: FactVersion | undefined): SafeHtml[] {
  const out: SafeHtml[] = [];
  if (v.isDeleted && prev?.isDeleted !== true) out.push(marker("deletion", MarkerClass.Bad));
  if (!v.isDeleted && prev?.isDeleted === true) out.push(marker("revival", MarkerClass.Live));
  return [...out, ...stateMarkers(v)];
}

function idDiff(before: string[], after: string[]): { added: string[]; removed: string[] } {
  const b = new Set(before);
  const a = new Set(after);
  return { added: after.filter((x) => !b.has(x)), removed: before.filter((x) => !a.has(x)) };
}

const countOf = (n: number, one: string): string => `${n} ${n === 1 ? one : `${one}s`}`;

// "0 reads, 0 confirms": the retrievals of a version, in words.
function readsText(v: FactDetailVersion): string {
  return `${countOf(v.retrievals[RetrievalKind.Read], "read")}, ${countOf(v.retrievals[RetrievalKind.Confirm], "confirm")}`;
}

// The body of the "Diff and reasoning" fold of one version.
function versionDiff(wiki: string, v: FactDetailVersion, prev: FactVersion | undefined): SafeHtml {
  const refs = idDiff(prev?.references ?? [], v.references);
  const rows: KvRow[] = [
    {
      term: "Header",
      value: prev === undefined || prev.header === v.header ? v.header : diffHtml(prev.header, v.header),
    },
    { term: "Content", value: v.isDeleted ? none() : diffHtml(prev?.content ?? "", v.content) },
    {
      term: "References",
      value:
        refs.added.length === 0 && refs.removed.length === 0
          ? none()
          : html`${refs.added.map((id) => html`<ins>${factLink(wiki, id)}</ins> `)}
            ${refs.removed.map((id) => html`<del>${factLink(wiki, id)}</del> `)}`,
    },
    { term: "Justification", value: v.justification === "" ? none() : quote(v.justification) },
    { term: "Change reasoning", value: v.changeReasoning },
    { term: "Reads and confirms", value: readsText(v) },
  ];
  return kv(rows);
}

function entries(wiki: string, fact: FactDetail): TimelineEntry[] {
  return fact.versions.map((v, i) => ({
    when: html`<a href="${objectPath(wiki, ConsoleSection.Requests, v.change.requestId)}" title="seq ${v.seq}"
        >${time(v.created)}</a
      >
      ${versionMarkers(v, fact.versions[i + 1])}`,
    what: v.change.summary,
    fold: { summary: "Diff and reasoning", body: versionDiff(wiki, v, fact.versions[i + 1]) },
    ...(i === 0 ? { current: true } : {}),
  }));
}

// The body of the Fact panel: the content as the result list shows it, the justification as stored, and the
// change reasoning behind a fold.
function factBlock(shown: FactVersion): SafeHtml {
  return html`${shown.isDeleted ? notice("This fact is deleted.", true) : null}
    <p class="content">${shown.content}</p>
    ${
      shown.justification === ""
        ? empty("No justification: the pipeline derived this version.")
        : quote(shown.justification, "Justification")
    }
    ${fold("Why this version", html`<p>${shown.changeReasoning}</p>`)}`;
}

function refList(wiki: string, fact: FactDetail): SafeHtml {
  return fact.references.length === 0
    ? none()
    : html`${fact.references.map((r) => html`<div>${factLink(wiki, r.id, r.header)} ${liveMarker(r.isDeleted)}</div>`)}`;
}

function dependentList(wiki: string, fact: FactDetail): SafeHtml {
  return fact.dependents.length === 0
    ? none()
    : html`${fact.dependents.map((d) => html`<div>${factLink(wiki, d.id, d.header)}</div>`)}`;
}

function details(wiki: string, fact: FactDetail, current: FactDetailVersion, created: number): SafeHtml {
  const origin =
    current.justification === "" ? marker("derived", MarkerClass.Derived) : marker("observed", MarkerClass.Observed);
  return panel(
    { title: "Details" },
    kv([
      { term: "Status", value: liveMarker(fact.isDeleted) },
      { term: "Origin", value: origin },
      { term: "Confidence", value: meter(fact.confidence) },
      { term: "Reads and confirms", value: readsText(current) },
      { term: "References", value: refList(wiki, fact) },
      { term: "Dependents", value: dependentList(wiki, fact) },
      { term: "Id", value: html`<code>${fact.id}</code>` },
      { term: "Created", value: time(created) },
    ]),
  );
}

/**
 * Renders the fact page at `GET /console/w/:w/facts/:id`.
 *
 * @param ctx - the deps, the wiki in `params.w`, the fact in `params.id`
 * @returns the HTML document
 * @throws {ConsoleError} `NotFound` for an unknown wiki or fact
 * @sideEffects one read-only connection, opened and closed; reads the clock once; reads the lock file and signals its
 *   pid with 0 for the status pill
 */
export async function factPage(ctx: PageContext): Promise<string> {
  const id = ctx.params.id ?? "";
  return withWiki(ctx, ({ wiki, store, now, frame }) => {
    const fact = getFactDetail(store, id, now);
    const current = fact?.versions[0];
    if (fact === null || current === undefined)
      throw new ConsoleError(ConsoleErrorKind.NotFound, `no fact with id "${id}"`);
    const created = fact.versions[fact.versions.length - 1]?.created ?? current.created;
    const factPanel = panel({ title: "Fact" }, factBlock(current));
    return layout(
      {
        ...frame,
        section: ConsoleSection.Facts,
        title: current.header,
      },
      html`${grid(GridColumns.MainSide, [
        column([factPanel, panel({ title: "History" }, timeline(entries(wiki.name, fact)))]),
        column([details(wiki.name, fact, current, created)]),
      ])}`,
    );
  });
}
