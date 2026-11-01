// The lists of a page (technical/console.md, "Parts"): the result list and the timeline. An empty list is the empty state of L3, never a
// frame over nothing.
import { html, type HtmlValue, type SafeHtml } from "../../html.js";
import { fold } from "./blocks.js";
import { meter } from "./markers.js";

/** One search result or sampled fact. */
export interface ResultItem {
  /** The header link of the fact. */
  title: SafeHtml;
  /** The markers after the header: deleted, old version. */
  markers?: SafeHtml;
  /** The content; a string is escaped, markup is inserted as is. */
  content: string | SafeHtml;
  /** The confidence, 0 to 1, drawn as the meter. */
  confidence?: number;
}

function result(item: ResultItem): SafeHtml {
  return html`<li class="result">
    <h3>${item.title} ${item.markers ?? null}</h3>
    <p class="content">${item.content}</p>
    <div class="meta">${item.confidence === undefined ? null : meter(item.confidence)}</div>
  </li>`;
}

/**
 * Renders a result list (technical/console.md, "Parts").
 *
 * @param items - the results in order
 * @param emptyText - the sentence when there is no result
 * @returns the `ol.results`, or a `p.empty` when `items` is empty
 * @sideEffects none
 */
export function results(items: ResultItem[], emptyText = "No result."): SafeHtml {
  if (items.length === 0) return html`<p class="empty">${emptyText}</p>`;
  return html`<ol class="results">
    ${items.map(result)}
  </ol>`;
}

/** A fold under a timeline entry: its summary line and its body. */
interface FoldSpec {
  summary: HtmlValue;
  body: SafeHtml;
}

/** One version of a timeline. */
export interface TimelineEntry {
  /** The line over the summary: the time link, the markers. */
  when: SafeHtml;
  /** The summary. */
  what: HtmlValue;
  /** A fold under the entry, e.g. the diff and the reasoning. */
  fold?: FoldSpec;
  /** True for the current version: its dot is in the accent color. */
  current?: boolean;
  /** True to open the fold on load, e.g. the version a link points at. */
  open?: boolean;
}

function entry(e: TimelineEntry): SafeHtml {
  const body = html`<div class="when">${e.when}</div>
    <p class="what">${e.what}</p>
    ${e.fold === undefined ? null : fold(e.fold.summary, e.fold.body, e.open === true)}`;
  return e.current === true
    ? html`<li class="entry" aria-current="true">${body}</li>`
    : html`<li class="entry">${body}</li>`;
}

/**
 * Renders a timeline (technical/console.md, "Parts").
 *
 * @param entries - the entries, newest first
 * @param emptyText - the sentence when there is no entry
 * @returns the `ol.timeline`, or a `p.empty` when `entries` is empty
 * @sideEffects none
 */
export function timeline(entries: TimelineEntry[], emptyText = "No version."): SafeHtml {
  if (entries.length === 0) return html`<p class="empty">${emptyText}</p>`;
  return html`<ol class="timeline">
    ${entries.map(entry)}
  </ol>`;
}
