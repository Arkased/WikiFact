// technical/console.md, "Architecture", `html.ts`: the layout, the escape function and the table helper. Every string from the
// database or the query enters a page through `html`, which escapes it; only a value built by `html` or `raw` is
// inserted as markup.
import { ConsoleSection, HealthLevel, MenuClass, TableCellClass, assertNever } from "../domain/enums.js";
import { STYLE_PATH } from "./style.js";
import { CLOCK_FIELD_WIDTH } from "../constants.js";

/** The path the script is served at (technical/console.md, "Architecture"). */
export const SCRIPT_PATH = "/console/console.js";

/** The path prefix of the console. */
export const CONSOLE_PREFIX = "/console/";

/** Markup that is safe to insert: the output of `html` or `raw`. */
export interface SafeHtml {
  readonly html: string;
}

/** What `html` accepts between the template parts. A string is escaped; markup must come as `SafeHtml`. */
export type HtmlValue = string | number | boolean | null | undefined | SafeHtml | HtmlValue[];

/**
 * Escapes text for an HTML body or a double-quoted attribute.
 *
 * @param text - any string
 * @returns the text with `&`, `<`, `>`, `"` and `'` as entities
 * @sideEffects none
 */
export function escapeHtml(text: string): string {
  // Hand-rolled: 5 replacements that the HTML standard fixes, under 10 lines, and the one place every string passes.
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Marks markup that the code built as safe to insert.
 *
 * @param markup - HTML text that holds no unescaped outside value
 * @returns the markup wrapped
 * @sideEffects none
 */
export function raw(markup: string): SafeHtml {
  return { html: markup };
}

function render(value: HtmlValue): string {
  if (value === null || value === undefined || value === false) return "";
  if (typeof value === "string") return escapeHtml(value);
  if (typeof value === "number" || value === true) return String(value);
  if (Array.isArray(value)) return value.map(render).join("");
  return value.html;
}

/**
 * Builds markup from a template: every interpolated string is escaped, a `SafeHtml` is inserted as is, an array is
 * joined, and `null`, `undefined` and `false` render as nothing.
 *
 * @param strings - the template parts
 * @param values - the interpolated values
 * @returns the markup
 * @sideEffects none
 */
export function html(strings: TemplateStringsArray, ...values: HtmlValue[]): SafeHtml {
  let out = "";
  strings.forEach((part, i) => {
    out += part;
    if (i < values.length) out += render(values[i]);
  });
  return { html: out };
}

/** A table cell with a class of technical/console.md, "Parts": `num` for a number, `wide` for a text that can be long. */
export interface Cell {
  readonly cell: HtmlValue;
  readonly cls: TableCellClass;
  /** The full text of a `wide` cell, shown on hover. */
  readonly title?: string;
}

function isCell(value: HtmlValue | Cell): value is Cell {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "cls" in value;
}

/**
 * Marks a numeric table cell (technical/console.md, "Parts"): right-aligned, tabular figures.
 *
 * @param value - the number or its text
 * @returns the cell
 * @sideEffects none
 */
export function num(value: HtmlValue): Cell {
  return { cell: value, cls: TableCellClass.Num };
}

/**
 * Marks a wide table cell (technical/console.md, "Parts"): cut with an ellipsis at 26 em, the full text in its `title`.
 *
 * @param text - the text; it is the cell and its title
 * @returns the cell
 * @sideEffects none
 */
export function wide(text: string): Cell {
  return { cell: text, cls: TableCellClass.Wide, title: text };
}

/**
 * Marks the cell of a row action (technical/console.md, "Parts"): the button alone, in a fixed-width column.
 *
 * @param value - the button or the form that holds it
 * @returns the cell
 * @sideEffects none
 */
export function act(value: HtmlValue): Cell {
  return { cell: value, cls: TableCellClass.Action };
}

function td(c: HtmlValue | Cell): SafeHtml {
  if (!isCell(c)) return html`<td>${c}</td>`;
  const title = c.title === undefined ? null : html`title="${c.title}"`;
  return html`<td class="${c.cls}" ${title}>${c.cell}</td>`;
}

/** A sort header of a table (technical/console.md, "Parts"): a link that sets the sort in the URL. */
export interface SortHeader {
  label: string;
  /** The URL with this column as the sort. */
  href: string;
  /** True for the column the list is sorted by. */
  sorted: boolean;
}

/** A column header: a text, markup, or a sort link. */
export type TableHeader = HtmlValue | SortHeader;

/** What `table` takes besides the headers and the rows. */
export interface TableOptions {
  /** The sentence shown instead of the table when there is no row (technical/console.md, "Pages", L3). */
  empty?: string;
  /** The line over the table, e.g. "90 facts". */
  count?: string;
}

/** The sentence of an empty table when the page gives none. */
const EMPTY_TABLE_TEXT = "none";

function isSortHeader(h: TableHeader): h is SortHeader {
  return typeof h === "object" && h !== null && !Array.isArray(h) && "sorted" in h;
}

// A header over a column of numbers is right-aligned with it.
function th(h: TableHeader, numeric: boolean): SafeHtml {
  // A header with no text is the column of a row action: a fixed width, so the buttons align.
  if (h === "") return html`<th class="${TableCellClass.Action}"></th>`;
  const cls = numeric ? html`class="${TableCellClass.Num}"` : null;
  if (!isSortHeader(h)) return html`<th ${cls}>${h}</th>`;
  const link = h.sorted
    ? html`<a class="sorted" href="${h.href}">${h.label}</a>`
    : html`<a href="${h.href}">${h.label}</a>`;
  return html`<th ${cls} aria-sort="${h.sorted ? "descending" : "none"}">${link}</th>`;
}

const isNumCell = (c: HtmlValue | Cell | undefined): boolean =>
  c !== undefined && isCell(c) && c.cls === TableCellClass.Num;

/**
 * Renders a table.
 *
 * @param headers - the column headers; a `SortHeader` renders as a link with `aria-sort`
 * @param rows - one array of cells per row; a string cell is escaped; a `Cell` carries its class
 * @param opts - the empty sentence and the count line
 * @returns the `<table>` inside a `div.scroll`, under `p.count` when `opts.count` is set; `p.empty` and no table when
 *   `rows` is empty
 * @sideEffects none
 */
export function table(headers: TableHeader[], rows: (HtmlValue | Cell)[][], opts: TableOptions = {}): SafeHtml {
  if (rows.length === 0) return html`<p class="empty">${opts.empty ?? EMPTY_TABLE_TEXT}</p>`;
  return html`${opts.count === undefined ? null : html`<p class="count">${opts.count}</p>`}
    <div class="scroll">
      <table>
        <thead>
          <tr>
            ${headers.map((h, i) =>
              th(
                h,
                rows.some((cells) => isNumCell(cells[i])),
              ),
            )}
          </tr>
        </thead>
        <tbody>
          ${rows.map(
            (cells) =>
              html`<tr>
                ${cells.map(td)}
              </tr>`,
          )}
        </tbody>
      </table>
    </div>`;
}

function pad2(n: number): string {
  return String(n).padStart(CLOCK_FIELD_WIDTH, "0");
}

/** What `time` shows besides the date and the minute. */
export interface TimeOptions {
  /** Show the seconds too: a log line, a request timeline (technical/console.md, "Parts"). */
  seconds?: boolean;
  /** The clock that decides what "today" is, in ms since the epoch; the clock of the server when absent. */
  now?: number;
}

const SECOND_MS = 1000;
const MINUTE_S = 60;
const HOUR_MIN = 60;

/**
 * Writes a duration in the one form every page uses (technical/console.md, "Routes"): `<1 s` under a second, `N s` under
 * a minute, `N min` under an hour, else `N h`; whole numbers, rounded down, never a millisecond count.
 *
 * @param ms - the duration, in ms; a negative value reads as 0
 * @returns for example `<1 s`, `9 s`, `3 min`, `2 h`
 * @sideEffects none
 */
export function durationText(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / SECOND_MS);
  if (seconds < 1) return "<1 s";
  if (seconds < MINUTE_S) return `${seconds} s`;
  const minutes = Math.floor(seconds / MINUTE_S);
  if (minutes < HOUR_MIN) return `${minutes} min`;
  return `${Math.floor(minutes / HOUR_MIN)} h`;
}

/**
 * Renders a time as `YYYY-MM-DD HH:mm` in the local time of the server, with the ISO time in `datetime`; a time of today
 * shows as `HH:mm` with the ISO time in `title`, any other day has the unix milliseconds in `title` (technical/console.md,
 * "Routes" and "Parts").
 *
 * @param ms - the time, in ms since the epoch
 * @param opts - whether to show the seconds, and the clock for "today"
 * @returns a `<time>` element
 * @sideEffects reads the clock when `opts.now` is absent; the local time is that of the server process
 */
export function time(ms: number, opts: TimeOptions = {}): SafeHtml {
  const d = new Date(ms);
  const today = new Date(opts.now ?? Date.now());
  const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const clock = `${pad2(d.getHours())}:${pad2(d.getMinutes())}${opts.seconds === true ? `:${pad2(d.getSeconds())}` : ""}`;
  const isToday = d.toDateString() === today.toDateString();
  return isToday
    ? html`<time datetime="${d.toISOString()}" title="${d.toISOString()}">${clock}</time>`
    : html`<time datetime="${d.toISOString()}" title="${ms}">${date} ${clock}</time>`;
}

/**
 * Renders a day as `YYYY-MM-DD` in the local time of the server, for a line that names no hour.
 *
 * @param ms - the time, in ms since the epoch
 * @returns a `<time>` element with the ISO time in `datetime` and in `title`
 * @sideEffects none; the local time is that of the server process
 */
export function day(ms: number): SafeHtml {
  const d = new Date(ms);
  const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  return html`<time datetime="${d.toISOString()}" title="${d.toISOString()}">${date}</time>`;
}

/**
 * Builds the URL of a section of a wiki.
 *
 * @param wiki - the wiki name
 * @param section - the section; Overview is the wiki's root
 * @returns `/console/w/<wiki>` or `/console/w/<wiki>/<segment>`
 * @sideEffects none
 */
export function wikiPath(wiki: string, section: ConsoleSection = ConsoleSection.Overview): string {
  const root = `${CONSOLE_PREFIX}w/${encodeURIComponent(wiki)}`;
  return section === ConsoleSection.Overview ? root : `${root}/${section}`;
}

/** The 2 goal pages, the tabs of the top bar, in order (technical/console.md, "The shell"). Jobs is a section of the second. */
const GOAL_SECTIONS: readonly ConsoleSection[] = [ConsoleSection.Overview, ConsoleSection.Health];

/** The tools of the More menu, in order (technical/console.md, "The shell"). The export link follows them. */
const TOOL_SECTIONS: readonly ConsoleSection[] = [
  ConsoleSection.Search,
  ConsoleSection.Requests,
  ConsoleSection.Settings,
];

/**
 * Names a section as a page shows it.
 *
 * @param section - the section
 * @returns the label, in the words of technical/console.md, "Pages"
 * @sideEffects none
 */
export function sectionLabel(section: ConsoleSection): string {
  switch (section) {
    case ConsoleSection.Overview:
      return "Overview";
    case ConsoleSection.Health:
      return "Operation";
    case ConsoleSection.Jobs:
      return "Jobs";
    case ConsoleSection.Search:
      return "Search";
    case ConsoleSection.Facts:
      return "Fact";
    case ConsoleSection.Settings:
      return "Settings";
    case ConsoleSection.Requests:
      return "Requests";
  }
  return assertNever(section);
}

/** The status pill of the top bar (technical/console.md, "The shell"): the worst of the 4 live health rows, as a link to Service health. */
export interface StatusPill {
  level: HealthLevel;
  /** "ok", or the level word and the worst row, e.g. "red · worker". */
  text: string;
  /** The 4 row details, shown on hover. */
  title: string;
  /** The Service health page. */
  href: string;
}

/** A link of a menu. */
interface MenuLink {
  label: string;
  href: string;
  /** Marks the item with `aria-current`. */
  current?: boolean;
}

/** A muted line of a menu, e.g. the version. */
interface MenuNote {
  note: string;
}

/** The rule between 2 groups of a menu. */
type MenuRule = "hr";

/** An item of a menu: a link, a rule, or a muted note. */
export type MenuItem = MenuLink | MenuRule | MenuNote;

/** What `menu` takes besides the items. */
export interface MenuOptions {
  /** The text of the button. */
  label: string;
  /** The kind of menu, a second class of the `details`; none for a plain menu. */
  cls?: MenuClass;
}

function menuItem(item: MenuItem): SafeHtml {
  if (item === "hr") return html`<hr />`;
  if ("note" in item) return html`<p class="muted">${item.note}</p>`;
  return item.current === true
    ? html`<a href="${item.href}" aria-current="true">${item.label}</a>`
    : html`<a href="${item.href}">${item.label}</a>`;
}

/**
 * Renders a menu (technical/console.md, "Parts"): a `details` whose summary is the button and whose list floats under it. The shell
 * and the parts share it, so it lives here and `parts/controls.ts` re-exports it.
 *
 * @param opts - the button text and the kind of menu
 * @param items - the links, rules and notes of the list
 * @returns the `<details class="menu">`
 * @sideEffects none
 */
export function menu(opts: MenuOptions, items: MenuItem[]): SafeHtml {
  const cls = opts.cls === undefined ? "menu" : `menu ${opts.cls}`;
  return html`<details class="${cls}">
    <summary>${opts.label}</summary>
    <div class="menu-list">${items.map(menuItem)}</div>
  </details>`;
}

/**
 * Renders the status pill (technical/console.md, "Parts").
 *
 * @param pill - the level, the text, the hover text and the target
 * @returns the `<a class="status">` with the level as a second class and a dot
 * @sideEffects none
 */
export function statusPill(pill: StatusPill): SafeHtml {
  return html`<a class="status ${pill.level}" href="${pill.href}" title="${pill.title}"
    ><span class="dot"></span>${pill.text}</a
  >`;
}

/** What the layout needs besides the body (technical/console.md, "Shell"). */
export interface LayoutOptions {
  /** The page heading: the section or the object alone. The `<title>` adds the wiki and the product. */
  title: string;
  /** Shown next to the page heading, e.g. the health badge of Service health (technical/console.md, "Service health"). */
  badge?: SafeHtml;
  /** One line under the heading: the subject, a description, a note. */
  lead?: HtmlValue;
  /** The wiki names of the wiki switcher. */
  wikis: string[];
  /** The wiki the page is about; its tabs and More menu show in the top bar. */
  wiki?: string;
  /** The section the page is in, marked in the tabs or the More menu. */
  section?: ConsoleSection;
  /** The status pill of the wiki (technical/console.md, "The shell"); absent on a page that is not about one wiki. */
  status?: StatusPill;
  /** The page header's right side (technical/console.md, "Shell"): a segmented control, a link button, the action buttons. */
  controls?: SafeHtml;
  /** The version of the service, the last line of the More menu. */
  version?: string;
  /** The script refreshes `main` in place every so many seconds (technical/console.md, "Architecture"); absent means no refresh. */
  refreshSeconds?: number;
}

function wikiSwitcher(opts: LayoutOptions, wiki: string): SafeHtml {
  const items: MenuItem[] = opts.wikis.map((name) => ({
    label: name,
    href: wikiPath(name),
    current: name === wiki,
  }));
  return menu({ label: wiki, cls: MenuClass.Wiki }, [...items, "hr", { label: "All wikis", href: CONSOLE_PREFIX }]);
}

function tabs(wiki: string, current: ConsoleSection | undefined): SafeHtml {
  return html`<nav class="tabs" aria-label="Sections">
    ${GOAL_SECTIONS.map((s) =>
      s === current
        ? html`<a href="${wikiPath(wiki, s)}" aria-current="page">${sectionLabel(s)}</a>`
        : html`<a href="${wikiPath(wiki, s)}">${sectionLabel(s)}</a>`,
    )}
  </nav>`;
}

function moreMenu(wiki: string, current: ConsoleSection | undefined, version: string | undefined): SafeHtml {
  const tools: MenuItem[] = TOOL_SECTIONS.map((s) => ({
    label: sectionLabel(s),
    href: wikiPath(wiki, s),
    current: s === current,
  }));
  const tail: MenuItem[] = version === undefined ? [] : ["hr", { note: `v${version}` }];
  return menu({ label: "More", cls: MenuClass.More }, [
    ...tools,
    { label: "Export", href: `${wikiPath(wiki, ConsoleSection.Facts)}/export?format=json` },
    ...tail,
  ]);
}

function topBar(opts: LayoutOptions): SafeHtml {
  const brand = html`<a class="brand" href="${CONSOLE_PREFIX}">WikiFact</a>`;
  if (opts.wiki === undefined) {
    return html`<header class="app">
      ${brand}
      <div class="end">${opts.version === undefined ? null : html`<p class="muted">v${opts.version}</p>`}</div>
    </header>`;
  }
  return html`<header class="app">
    ${brand} ${wikiSwitcher(opts, opts.wiki)} ${tabs(opts.wiki, opts.section)}
    <div class="end">
      ${opts.status === undefined ? null : statusPill(opts.status)} ${moreMenu(opts.wiki, opts.section, opts.version)}
    </div>
  </header>`;
}

/**
 * Renders a whole page: the top bar (brand, wiki switcher, tabs, status pill, More menu) and the main area with the
 * page header.
 *
 * @param opts - the heading, the lead, the wikis, the current wiki and section, the status pill, the controls, the
 *   version and the refresh
 * @param body - the markup of the main area, under the page header
 * @returns the HTML document; its `<title>` is "<heading> - <wiki> - WikiFact", without the wiki part on a page
 *   that has none
 * @sideEffects none
 */
export function layout(opts: LayoutOptions, body: SafeHtml): string {
  const docTitle = opts.wiki === undefined ? `${opts.title} - WikiFact` : `${opts.title} - ${opts.wiki} - WikiFact`;
  const refresh = opts.refreshSeconds === undefined ? null : html`data-refresh="${opts.refreshSeconds}"`;
  const doc = html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${docTitle}</title>
        <link rel="stylesheet" href="${STYLE_PATH}" />
        <script src="${SCRIPT_PATH}" defer></script>
      </head>
      <body>
        ${topBar(opts)}
        <main ${refresh}>
          <header class="page">
            <h1>${opts.title} ${opts.badge ?? null}</h1>
            ${opts.lead === undefined ? null : html`<p class="lead">${opts.lead}</p>`}
            ${opts.controls === undefined ? null : html`<div class="controls">${opts.controls}</div>`}
          </header>
          ${body}
        </main>
      </body>
    </html>`;
  return doc.html;
}
