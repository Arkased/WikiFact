// The blocks every page builds from: the stat row, the panel, the grid, the empty state, the key-value list, the quote,
// the notice, the chart box, the fold and the table cells that cut or mark a value (technical/console.md, "Shell", "Parts" and "Charts").
import { TableCellClass, type GridColumns, type HealthLevel, type Signal } from "../../../domain/enums.js";
import { html, type Cell, type HtmlValue, type SafeHtml } from "../../html.js";
import { definedLabel, definedPhrase } from "./data.js";
import { levelWord } from "./markers.js";

/** The length a content cell is cut to, in characters, before the style sheet cuts it with an ellipsis. */
export const CONTENT_PREVIEW = 100;

/**
 * Marks the first cell of a list as its key (technical/console.md, "Parts"): it gets room, so a header link does not wrap to many
 * lines.
 *
 * @param value - the cell content
 * @returns the cell
 * @sideEffects none
 */
export function key(value: HtmlValue): Cell {
  return { cell: value, cls: TableCellClass.Key };
}

/** One stat of a stat row (technical/console.md, "Parts"). */
export interface StatItem {
  /** The label over the value. */
  label: string;
  /** The value, large; a `SafeHtml` is the dash of a value with no divisor. */
  value: string | number | SafeHtml;
  /** The line under the value. */
  under?: HtmlValue;
  /** The page the stat leads to; the stat becomes a link. */
  href?: string;
  /** The signal the value shows: its definition shows on hover or focus of the label (technical/console.md, "Data and interpretation"). */
  signal?: Signal;
  /** The level of the rule over the number: the number shows in the color of the level. A number with no rule has none. */
  level?: HealthLevel;
  /** The reading of the number: its sentence shows on hover or focus of the number, as the definition shows on the label. */
  reading?: string | null;
}

// The number of a stat; with a reading it is focusable and carries the sentence like a definition, with a hidden copy that
// `aria-describedby` points at.
function number(item: StatItem): SafeHtml {
  const levelClass = item.level === undefined ? "n" : `n ${levelWord(item.level)}`;
  if (item.reading === undefined || item.reading === null)
    return html`<span class="${levelClass}">${item.value}</span>`;
  const id = `reading-${item.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return html`<span
      class="${levelClass}"
      tabindex="0"
      data-definition="${item.reading}"
      title="${item.reading}"
      aria-describedby="${id}"
      >${item.value}</span
    ><span class="sr-only" id="${id}">${item.reading}</span>`;
}

function stat(item: StatItem): SafeHtml {
  // The label of a signal carries its definition on hover or focus.
  const label = html`<span class="l"
    >${item.signal === undefined ? item.label : definedLabel(item.signal, item.label)}</span
  >`;
  const inner = html`${label}${number(item)}${
    item.under === undefined ? null : html`<span class="u">${item.under}</span>`
  }`;
  return item.href === undefined
    ? html`<div class="stat">${inner}</div>`
    : html`<a class="stat" href="${item.href}">${inner}</a>`;
}

/**
 * Renders a stat row (technical/console.md, "Parts").
 *
 * @param items - the stats, left to right from the start of the row, each of a fixed width
 * @returns the `div.stats`; each stat an `a.stat` when it has an `href`, else a `div.stat`; the number of a stat with a `level`
 *   is a `span.n` with the level word (`ok`, `warning` or `failing`) as a second class; the number of a stat with a `reading` is
 *   focusable and holds the sentence in `data-definition` and `title`, with a hidden `span.sr-only` copy that `aria-describedby`
 *   names
 * @sideEffects none
 */
export function stats(items: StatItem[]): SafeHtml {
  return html`<div class="stats">${items.map(stat)}</div>`;
}

/** What `panel` takes besides the body (technical/console.md, "Parts"). */
export interface PanelOptions {
  /** The heading of the panel. */
  title: string;
  /** One line after the title, in the secondary tone. */
  note?: HtmlValue;
  /** The link or the segmented control at the right of the head. */
  aside?: HtmlValue;
  /** True when the panel spans the whole row of a grid. */
  span?: boolean;
  /** The anchor of the panel: a link such as `#flags` leads to it. */
  id?: string;
}

/**
 * Renders a panel (technical/console.md, "Parts").
 *
 * @param opts - the title, the note, the aside, the span and the id
 * @param body - the content
 * @returns the `section.panel` with its `header.panel-head` and `div.panel-body`; `span-all` when `opts.span`; the
 *   `id` attribute when `opts.id` is set
 * @sideEffects none
 */
export function panel(opts: PanelOptions, body: HtmlValue): SafeHtml {
  const cls = opts.span === true ? "panel span-all" : "panel";
  const id = opts.id === undefined ? null : html`id="${opts.id}"`;
  return html`<section class="${cls}" ${id}>
    <header class="panel-head">
      <h2>${opts.title}</h2>
      ${opts.note === undefined ? null : note(opts.note)}
      ${opts.aside === undefined ? null : html`<span class="aside">${opts.aside}</span>`}
    </header>
    <div class="panel-body">${body}</div>
  </section>`;
}

/**
 * Renders a grid (technical/console.md, "Shell").
 *
 * @param columns - the column layout; one column under 900 px
 * @param children - the blocks of the grid; a panel with `span` takes the whole row
 * @returns the `div.grid` with the layout as its second class
 * @sideEffects none
 */
export function grid(columns: GridColumns, children: HtmlValue[]): SafeHtml {
  return html`<div class="grid ${columns}">${children}</div>`;
}

/**
 * Renders a column: the blocks of one grid cell, stacked (technical/console.md, "Shell").
 *
 * @param blocks - the blocks in order; null and undefined render as nothing
 * @returns the `div.col`
 * @sideEffects none
 */
export function column(blocks: HtmlValue[]): SafeHtml {
  return html`<div class="col">${blocks}</div>`;
}

/**
 * Renders a note line: one line of detail under a chart or a list (technical/console.md, "Parts").
 *
 * @param text - the line; a string is escaped
 * @returns the `p.note`
 * @sideEffects none
 */
export function note(text: HtmlValue): SafeHtml {
  return html`<p class="note">${text}</p>`;
}

/**
 * Renders an empty state: what would be there, in one muted sentence (technical/console.md, "Pages", L3).
 *
 * @param text - the sentence
 * @returns the `p.empty`
 * @sideEffects none
 */
export function empty(text: string): SafeHtml {
  return html`<p class="empty">${text}</p>`;
}

/** One row of a key-value list. */
export interface KvRow {
  /** The term, in the secondary tone. */
  term: string;
  /** The value; it may hold `code`. */
  value: HtmlValue;
}

/**
 * Renders a key-value list (technical/console.md, "Parts").
 *
 * @param rows - the rows in order
 * @returns the `dl.kv`
 * @sideEffects none
 */
export function kv(rows: KvRow[]): SafeHtml {
  return html`<dl class="kv">
    ${rows.map(
      (r) =>
        html`<dt>${r.term}</dt>
          <dd>${r.value}</dd>`,
    )}
  </dl>`;
}

/**
 * Renders a quote of the agent's text, as stored (design/console.md, "Stored text").
 *
 * @param text - the text; its line breaks are kept by the style sheet
 * @param label - the line over the quote, if any
 * @returns the `blockquote.quote`, under a `p.label` when labeled
 * @sideEffects none
 */
export function quote(text: string, label?: string): SafeHtml {
  return html`${label === undefined ? null : html`<p class="label">${label}</p>`}
    <blockquote class="quote">${text}</blockquote>`;
}

/**
 * Renders a notice (technical/console.md, "Parts").
 *
 * @param text - the message
 * @param bad - true for an error or a refusal
 * @returns the `p.notice`, with `bad` as a second class when `bad`
 * @sideEffects none
 */
export function notice(text: HtmlValue, bad = false): SafeHtml {
  return html`<p class="${bad ? "notice bad" : "notice"}">${text}</p>`;
}

/**
 * Renders a chart inside a panel (technical/console.md, "Charts"): no box of its own, a small label line over the drawing in
 * the style of a stat label.
 *
 * @param caption - what the chart shows, in one line
 * @param body - the drawing from `charts.ts`, or its empty sentence
 * @param signal - the signal the chart shows, or `{ definition }` for a count that is no signal: the definition shows on
 *   hover or focus of the caption, as on a stat label
 * @returns the `<figure class="plot">`
 * @sideEffects none
 */
export function plot(caption: string, body: SafeHtml, signal?: Signal | { definition: string }): SafeHtml {
  const label =
    signal === undefined
      ? caption
      : typeof signal === "string"
        ? definedLabel(signal, caption)
        : definedPhrase(caption, signal.definition);
  return html`<figure class="plot">
    <figcaption class="l">${label}</figcaption>
    ${body}
  </figure>`;
}

/**
 * Renders a closed fold (technical/console.md, "Shell"): a summary line that opens a block.
 *
 * @param summary - the summary line
 * @param body - the block
 * @param open - true to render the fold open on load
 * @returns the `<details class="fold">`, with `open` when `open`
 * @sideEffects none
 */
export function fold(summary: HtmlValue, body: SafeHtml, open = false): SafeHtml {
  return html`<details class="fold" ${open ? html`open` : null}>
    <summary>${summary}</summary>
    ${body}
  </details>`;
}
