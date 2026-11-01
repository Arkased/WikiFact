// A console page parsed with `jsdom`, with the queries a test needs to check what a reader sees: the text, the links
// and their targets, the rows of a table, the value behind a label, the options of a select and the fields of a form.
// A test never reads markup, a CSS class or an attribute order; the few selectors that name a part live here, so a
// change of the markup is fixed in this one file.
import { JSDOM } from "jsdom";

/** A link as a reader sees it: its text and where it goes. */
export interface Link {
  text: string;
  href: string;
}

/** An option of a select. */
export interface Option {
  value: string;
  label: string;
  selected: boolean;
}

/** A form control as the browser would submit it. */
export interface Field {
  name: string;
  type: string;
  value: string;
  checked: boolean;
}

/** A form: where it goes and the controls it submits. */
export interface Form {
  method: string;
  action: string;
  fields: Field[];
}

/** A column header of a table. */
export interface Header {
  label: string;
  /** The link of a sortable header; absent for a plain header. */
  href?: string;
  /** The sort state a screen reader gets: "none", "ascending" or "descending"; absent for a plain header. */
  sort?: string;
}

/** A stat of the stat row. */
export interface Stat {
  value: string;
  under: string;
  /** The page the stat leads to; absent for a plain stat. */
  href?: string;
}

/**
 * Collapses the white space of a text.
 *
 * @param text - the text
 * @returns the text with every run of white space as one space, trimmed
 */
export function squash(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Reads the query of a link as the server would.
 *
 * @param href - a path, a query-only link such as `?sort=created`, or a full URL
 * @returns the parameters of its query
 */
export function queryOf(href: string): URLSearchParams {
  return new URL(href, "http://console.test/").searchParams;
}

// The body rows of a table as arrays of cell texts.
function rowsOf(table: Element): string[][] {
  const rows = [...table.querySelectorAll("tbody tr")];
  const body = rows.length > 0 ? rows : [...table.querySelectorAll("tr")].filter((r) => r.querySelector("td"));
  return body.map((r) => [...r.querySelectorAll("td")].map((td) => squash(td.textContent)));
}

// A form control as the browser would submit it.
function fieldOf(el: Element): Field {
  const name = el.getAttribute("name") ?? "";
  if (el.tagName === "SELECT") {
    const chosen = el.querySelector("option[selected]") ?? el.querySelector("option");
    return {
      name,
      type: "select",
      value: chosen?.getAttribute("value") ?? squash(chosen?.textContent),
      checked: false,
    };
  }
  if (el.tagName === "TEXTAREA") return { name, type: "textarea", value: el.textContent ?? "", checked: false };
  return {
    name,
    type: el.getAttribute("type") ?? "text",
    value: el.getAttribute("value") ?? "",
    checked: el.hasAttribute("checked"),
  };
}

/** A view over an element, or a whole page, with the queries of a reader. */
export class View {
  constructor(protected readonly root: Element) {}

  /**
   * The visible text.
   *
   * @returns the text content with white space collapsed
   */
  get text(): string {
    return squash(this.root.textContent);
  }

  /**
   * The first element that matches a selector; the way out for a part test that names a class of the sheet.
   *
   * @param selector - a CSS selector
   * @returns the element, or null
   */
  $(selector: string): Element | null {
    return this.root.querySelector(selector);
  }

  /**
   * Every element that matches a selector.
   *
   * @param selector - a CSS selector
   * @returns the elements in page order
   */
  $$(selector: string): Element[] {
    return [...this.root.querySelectorAll(selector)];
  }

  /**
   * The first element that matches a selector, as a view; for a landmark such as `nav[aria-label="Sections"]`.
   *
   * @param selector - a CSS selector
   * @returns the view, or undefined
   */
  within(selector: string): View | undefined {
    const el = this.$(selector);
    return el === null ? undefined : new View(el);
  }

  /**
   * The headings of a level.
   *
   * @param level - the heading level, h2 by default
   * @returns the heading texts in page order
   */
  headings(level: Extract<keyof HTMLElementTagNameMap, `h${number}`> = "h2"): string[] {
    return this.$$(level).map((h) => squash(h.textContent));
  }

  /**
   * The part of the page under a heading: the panel or section that holds it.
   *
   * @param heading - the text of the heading (exact)
   * @returns the view, or undefined when no such heading is on the page
   */
  section(heading: string): View | undefined {
    const h = this.$$("h2, h3").find((e) => squash(e.textContent) === heading);
    const box = h?.closest("section, figure, article, li, div");
    return box === undefined || box === null ? undefined : new View(box);
  }

  /**
   * Every link.
   *
   * @returns the links in page order
   */
  links(): Link[] {
    return this.$$("a[href]").map((a) => ({ text: squash(a.textContent), href: a.getAttribute("href") ?? "" }));
  }

  /**
   * The first link with this text.
   *
   * @param text - the link text (exact)
   * @returns the link, or undefined
   */
  link(text: string): Link | undefined {
    return this.links().find((l) => l.text === text);
  }

  /**
   * The target of the first link with this text.
   *
   * @param text - the link text (exact)
   * @returns the target, or undefined
   */
  href(text: string): string | undefined {
    return this.link(text)?.href;
  }

  /**
   * The targets of all links with this text.
   *
   * @param text - the link text (exact)
   * @returns the targets in page order
   */
  hrefs(text: string): string[] {
    return this.links()
      .filter((l) => l.text === text)
      .map((l) => l.href);
  }

  /**
   * The first link whose target contains a path fragment.
   *
   * @param fragment - part of the target
   * @returns the link, or undefined
   */
  linkTo(fragment: string): Link | undefined {
    return this.links().find((l) => l.href.includes(fragment));
  }

  /**
   * The buttons; links styled as buttons come from `links`.
   *
   * @returns the button texts in page order
   */
  buttons(): string[] {
    return this.$$("button").map((b) => squash(b.textContent));
  }

  /**
   * The tables of the view.
   *
   * @returns each table as its body rows of cell texts
   */
  tables(): string[][][] {
    return this.$$("table").map((t) => rowsOf(t));
  }

  /**
   * The body rows of a table.
   *
   * @param index - which table, the first by default
   * @returns the rows as arrays of cell texts; empty when there is no such table
   */
  rows(index = 0): string[][] {
    return this.tables()[index] ?? [];
  }

  /**
   * The column headers of a table.
   *
   * @param index - which table, the first by default
   * @returns the headers; empty when there is no such table
   */
  headers(index = 0): Header[] {
    const table = this.$$("table")[index];
    if (table === undefined) return [];
    return [...table.querySelectorAll("th")].map((th) => {
      const a = th.querySelector("a");
      const header: Header = { label: squash(th.textContent).replace(/\s*[▲▼]$/, "") };
      if (a !== null) header.href = a.getAttribute("href") ?? "";
      const sort = th.getAttribute("aria-sort");
      if (sort !== null) header.sort = sort;
      return header;
    });
  }

  /**
   * One column header of a table.
   *
   * @param label - the header text without the sort glyph
   * @param index - which table, the first by default
   * @returns the header, or undefined
   */
  header(label: string, index = 0): Header | undefined {
    return this.headers(index).find((h) => h.label === label);
  }

  /**
   * The cells of the table row that holds the first link whose target contains a fragment.
   *
   * @param fragment - part of the target
   * @returns the cell texts, or undefined
   */
  rowOf(fragment: string): string[] | undefined {
    const a = this.$$("tr a[href]").find((e) => (e.getAttribute("href") ?? "").includes(fragment));
    const tr = a?.closest("tr");
    return tr === undefined || tr === null
      ? undefined
      : [...tr.querySelectorAll("td")].map((c) => squash(c.textContent));
  }

  /**
   * The row of a table by its first cell.
   *
   * @param first - the text of the first cell, or its start up to a space
   * @param index - which table, the first by default
   * @returns the cell texts, or undefined
   */
  row(first: string, index = 0): string[] | undefined {
    return this.rows(index).find((r) => r[0] === first || r[0]?.startsWith(`${first} `));
  }

  /**
   * The stat row.
   *
   * @returns the stats by label
   */
  stats(): Record<string, Stat> {
    const out: Record<string, Stat> = {};
    for (const s of this.$$(".stat")) {
      // The label is the span or, for a signal, the defined label inside it (the hidden definition text is not the label).
      const [l, n, u] = [".l > .defined, .l:not(:has(.defined))", ".n", ".u"].map((sel) =>
        squash(s.querySelector(sel)?.textContent),
      );
      const href = s.getAttribute("href");
      out[l ?? ""] = { value: n ?? "", under: u ?? "", ...(href === null ? {} : { href }) };
    }
    return out;
  }

  /**
   * The value of a stat.
   *
   * @param label - the stat label
   * @returns the value text, or undefined
   */
  stat(label: string): string | undefined {
    return this.stats()[label]?.value;
  }

  /**
   * The key-value rows. A term that repeats (a list of panels) keeps its first value; scope the view to a section for
   * the others.
   *
   * @returns the value text by term
   */
  kv(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const dt of this.$$("dt")) out[squash(dt.textContent)] ??= squash(dt.nextElementSibling?.textContent);
    return out;
  }

  /**
   * The value of a key-value row.
   *
   * @param term - the term
   * @returns the value text, or undefined
   */
  kvValue(term: string): string | undefined {
    return this.kv()[term];
  }

  /**
   * The value of a key-value row as a view, for its links.
   *
   * @param term - the term
   * @returns the view, or undefined
   */
  kvView(term: string): View | undefined {
    const dt = this.$$("dt").find((e) => squash(e.textContent) === term);
    const dd = dt?.nextElementSibling;
    return dd === undefined || dd === null ? undefined : new View(dd);
  }

  /**
   * The options of a select.
   *
   * @param name - the name of the select
   * @returns the options; empty when there is no such select
   */
  options(name: string): Option[] {
    const select = this.$(`select[name="${name}"]`);
    if (select === null) return [];
    return [...select.querySelectorAll("option")].map((o) => ({
      value: o.getAttribute("value") ?? squash(o.textContent),
      label: squash(o.textContent),
      selected: o.hasAttribute("selected"),
    }));
  }

  /**
   * The selected options of a select.
   *
   * @param name - the name of the select
   * @returns the labels of the selected options
   */
  selected(name: string): string[] {
    return this.options(name)
      .filter((o) => o.selected)
      .map((o) => o.label);
  }

  /**
   * A form control by its name.
   *
   * @param name - the control name
   * @returns the control (a select reports its selected value), or undefined
   */
  field(name: string): Field | undefined {
    const el = this.$(`[name="${name}"]`);
    return el === null ? undefined : fieldOf(el);
  }

  /**
   * The placeholder of a text control: what the box asks for when it has no label.
   *
   * @param name - the control name
   * @returns the placeholder, or undefined
   */
  placeholder(name: string): string | undefined {
    return this.$(`[name="${name}"]`)?.getAttribute("placeholder") ?? undefined;
  }

  /**
   * The visible label texts of the labels that wrap a control of the given name.
   *
   * @param name - the control name
   * @returns the text of the wrapping label, trimmed; empty for a control with no label text
   */
  labelOf(name: string): string {
    return squash(this.$(`[name="${name}"]`)?.closest("label")?.textContent);
  }

  /**
   * The names of all controls.
   *
   * @returns the distinct names in page order
   */
  fieldNames(): string[] {
    return [...new Set(this.$$("input[name], select[name], textarea[name]").map((e) => e.getAttribute("name") ?? ""))];
  }

  /**
   * The forms.
   *
   * @returns each form with its method, its action and its controls
   */
  forms(): Form[] {
    return this.$$("form").map((f) => ({
      method: (f.getAttribute("method") ?? "get").toLowerCase(),
      action: f.getAttribute("action") ?? "",
      fields: [...f.querySelectorAll("input[name], select[name], textarea[name]")].map((e) => fieldOf(e)),
    }));
  }

  /**
   * The form that goes to an action path.
   *
   * @param action - the action path
   * @returns the form, or undefined
   */
  formTo(action: string): Form | undefined {
    return this.forms().find((f) => f.action === action);
  }

  /**
   * The form that goes to an action path, as a view for its text and links.
   *
   * @param action - the action path
   * @returns the view, or undefined
   */
  formView(action: string): View | undefined {
    const form = this.$$("form").find((f) => f.getAttribute("action") === action);
    return form === undefined ? undefined : new View(form);
  }

  /**
   * The items the reader is told are the current one (a tab, a menu entry, a version).
   *
   * @returns a view of each
   */
  current(): View[] {
    return this.$$("[aria-current]").map((e) => new View(e));
  }

  /**
   * The folds (disclosures).
   *
   * @returns each fold with its summary line, whether it is open, and its content
   */
  folds(): { summary: string; open: boolean; view: View }[] {
    return this.$$("details").map((d) => ({
      summary: squash(d.querySelector("summary")?.textContent),
      open: d.hasAttribute("open"),
      view: new View(d),
    }));
  }

  /**
   * The content of a fold.
   *
   * @param summary - the summary line
   * @returns the view, or undefined
   */
  fold(summary: string): View | undefined {
    return this.folds().find((f) => f.summary === summary)?.view;
  }

  /**
   * The texts a diff shows as inserted.
   *
   * @returns the texts in page order
   */
  inserted(): string[] {
    return this.$$("ins").map((e) => squash(e.textContent));
  }

  /**
   * The texts a diff shows as deleted.
   *
   * @returns the texts in page order
   */
  removed(): string[] {
    return this.$$("del").map((e) => squash(e.textContent));
  }

  /**
   * The list item or table row that holds the first link whose target contains a fragment.
   *
   * @param fragment - part of the target
   * @returns the view, or undefined
   */
  itemWith(fragment: string): View | undefined {
    const a = this.$$("a[href]").find((e) => (e.getAttribute("href") ?? "").includes(fragment));
    const item = a?.closest("li, tr");
    return item === undefined || item === null ? undefined : new View(item);
  }

  /**
   * The items of a result list.
   *
   * @returns a view of each in page order
   */
  results(): View[] {
    return this.$$("li.result").map((li) => new View(li));
  }

  /**
   * One item of a result list.
   *
   * @param header - the text of the header link
   * @returns the view, or undefined
   */
  result(header: string): View | undefined {
    return this.results().find((r) => r.link(header) !== undefined);
  }

  /**
   * The drawings.
   *
   * @returns a view of each
   */
  svgs(): View[] {
    return this.$$("svg").map((s) => new View(s));
  }
}

/** A whole page: the document, with its title. */
export class Page extends View {
  private constructor(readonly doc: Document) {
    super(doc.documentElement);
  }

  /**
   * Parses a page or a fragment.
   *
   * @param markup - the HTML string a page handler or a part returns
   * @returns the parsed page
   */
  static parse(markup: string | { html: string }): Page {
    const source = typeof markup === "string" ? markup : markup.html;
    return new Page(new JSDOM(source).window.document);
  }

  /**
   * The document title.
   *
   * @returns the title with white space collapsed
   */
  get title(): string {
    return squash(this.doc.title);
  }
}

/**
 * Parses a page or a fragment.
 *
 * @param markup - the HTML string a page handler or a part returns
 * @returns the parsed page
 */
export function parse(markup: string | { html: string }): Page {
  return Page.parse(markup);
}
