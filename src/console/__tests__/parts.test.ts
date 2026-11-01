// The parts of technical/console.md, "Parts". A part test may name the classes that the style sheet selects on (they are the
// contract between the part and the sheet); it never compares a whole markup string.
import { describe, expect, it } from "vitest";
import {
  DialogId,
  GridColumns,
  HealthLevel,
  InterpretationId,
  MenuClass,
  MarkerClass,
  Signal,
} from "../../domain/enums.js";
import { html } from "../html.js";
import { INTERPRETATIONS } from "../interpretations.js";
import { SIGNAL_DEFINITIONS } from "../signals.js";
import {
  checkboxField,
  column,
  dateField,
  definedLabel,
  dialogAction,
  empty,
  enumSelect,
  fold,
  grid,
  reading,
  verdicts,
  kv,
  marker,
  menu,
  note,
  notice,
  numberField,
  optionSelect,
  panel,
  paging,
  plot,
  quote,
  results,
  segmented,
  sortHeader,
  stats,
  statusPill,
  timeline,
  toolbar,
} from "../pages/parts/index.js";
import { parse, queryOf, squash } from "./helpers/dom.js";

describe("blocks", () => {
  it("renders a stat row with a link stat and a plain stat", () => {
    const page = parse(
      stats([
        { label: "Facts", value: 12, under: "live", href: "/f" },
        { label: "Tags", value: "3" },
      ]),
    );
    expect(page.stats()).toEqual({
      Facts: { value: "12", under: "live", href: "/f" },
      Tags: { value: "3", under: "" },
    });
    expect(page.$$("a.stat")).toHaveLength(1);
    expect(page.$$("div.stat")).toHaveLength(1);
  });

  it("renders a panel with its head, note, aside and body, and spans on request", () => {
    const page = parse(panel({ title: "T", note: "n", aside: html`<a href="#">all</a>`, span: true }, html`<p>b</p>`));
    expect(page.$("section.panel.span-all")).not.toBeNull();
    expect(page.headings()).toEqual(["T"]);
    expect(page.$("header.panel-head .note")?.textContent).toBe("n");
    expect(page.$("header.panel-head .aside a")?.textContent).toBe("all");
    expect(page.$("div.panel-body")?.textContent).toBe("b");
    expect(parse(panel({ title: "T" }, "b")).$("section.panel.span-all")).toBeNull();
  });

  it("renders a grid with the column class", () => {
    const page = parse(grid(GridColumns.TwoToOne, [html`<i></i>`]));
    expect(page.$("div.grid.cols-2-1 > i")).not.toBeNull();
  });

  it("renders a column of blocks, skipping the absent ones, and a note line that escapes its text", () => {
    const page = parse(column([html`<i></i>`, null, html`<b></b>`]));
    expect(page.$$("div.col > *").map((e) => e.tagName)).toEqual(["I", "B"]);
    expect(parse(note("a <b>")).$("p.note")?.textContent).toBe("a <b>");
    expect(parse(note("a <b>")).$("b")).toBeNull();
  });

  it("gives a panel its anchor id when asked", () => {
    expect(parse(panel({ title: "Flags", id: "flags" }, "b")).$("section.panel")?.id).toBe("flags");
    expect(
      parse(panel({ title: "Flags" }, "b"))
        .$("section.panel")
        ?.hasAttribute("id"),
    ).toBe(false);
  });

  it("renders a fold closed by default and open on request", () => {
    const closed = parse(fold("S", html`<p>b</p>`));
    expect(closed.folds()).toMatchObject([{ summary: "S", open: false }]);
    expect(closed.$("details.fold")).not.toBeNull();
    expect(closed.text).toContain("b");
    expect(parse(fold("S", html`<p>b</p>`, true)).folds()[0]?.open).toBe(true);
  });

  it("renders the empty state, the key-value list, the quote and the notice", () => {
    expect(parse(empty("Nothing.")).$("p.empty")?.textContent).toBe("Nothing.");
    expect(parse(kv([{ term: "Id", value: html`<code>X</code>` }])).kv()).toEqual({ Id: "X" });
    expect(parse(kv([{ term: "Id", value: html`<code>X</code>` }])).$("dl.kv dd code")?.textContent).toBe("X");
    const labeled = parse(quote("why <b>", "Justification"));
    expect(labeled.$("blockquote.quote")?.textContent).toBe("why <b>");
    expect(labeled.$("p.label")?.textContent).toBe("Justification");
    expect(parse(quote("x")).$("p.label")).toBeNull();
    expect(parse(notice("hi")).$("p.notice")?.textContent).toBe("hi");
    expect(parse(notice("hi")).$("p.notice.bad")).toBeNull();
    expect(parse(notice("bad", true)).$("p.notice.bad")?.textContent).toBe("bad");
  });

  it("renders a chart with no box of its own: a caption line over the drawing", () => {
    const page = parse(plot("Facts per day", html`<svg></svg>`));
    expect(page.$("figure.plot > figcaption.l")?.textContent).toBe("Facts per day");
    expect(page.$("figure.chartbox")).toBeNull();
    expect(page.headings()).toEqual([]);
    expect(page.svgs()).toHaveLength(1);
  });

  it("gives the caption of a chart the definition of its signal when it shows one", () => {
    const page = parse(plot("Reads per search", html`<svg></svg>`, Signal.ReadsPerSearch));
    expect(page.$("figure.plot > figcaption.l > .defined")?.textContent).toBe("Reads per search");
    expect(page.$("figcaption .defined")?.getAttribute("title")).toBe(SIGNAL_DEFINITIONS[Signal.ReadsPerSearch]);
    expect(page.folds()).toEqual([]);
  });
});

describe("controls", () => {
  it("renders a segmented control with the current item marked", () => {
    const page = parse(
      segmented("Window", [
        { label: "7 days", href: "?days=7", current: false },
        { label: "30 days", href: "?days=30", current: true },
      ]),
    );
    expect(page.$("nav.segmented")?.getAttribute("aria-label")).toBe("Window");
    expect(page.links()).toEqual([
      { text: "7 days", href: "?days=7" },
      { text: "30 days", href: "?days=30" },
    ]);
    expect(page.current().map((v) => v.text)).toEqual(["30 days"]);
  });

  it("renders a toolbar: a GET form with auto-apply, Apply, the second row and the applied chips", () => {
    const page = parse(
      toolbar({
        fields: [enumSelect("kind", "Kind", MarkerClass, undefined), numberField("min", "Min", 0.5)],
        more: [checkboxField("unread", "Unread", true)],
        applied: [{ label: "Kind", value: "marker", href: "?" }],
      }),
    );
    const form = page.$("form.toolbar");
    expect(form?.getAttribute("method")).toBe("get");
    expect(form?.hasAttribute("data-auto")).toBe(true);
    expect(page.buttons()).toEqual(["Apply"]);
    expect(page.fieldNames()).toEqual(["kind", "min", "unread"]);
    expect(page.field("min")?.value).toBe("0.5");
    expect(page.folds().map((f) => f.summary)).toEqual(["More filters"]);
    expect(page.folds()[0]?.view.field("unread")).toMatchObject({ type: "checkbox", checked: true });
    expect(page.link("Kind: marker ×")?.href).toBe("?");
    expect(page.$("ul.applied a.chip.remove")).not.toBeNull();
  });

  it("leaves out the second row and the applied list when there are none", () => {
    const page = parse(toolbar({ fields: [] }));
    expect(page.folds()).toEqual([]);
    expect(page.$("ul.applied")).toBeNull();
  });

  it("labels the submit button and carries the hidden fields inside the form", () => {
    const page = parse(toolbar({ fields: [], submit: "Compare", hidden: [{ name: "sort", value: "created" }] }));
    expect(page.buttons()).toEqual(["Compare"]);
    expect(page.forms()[0]?.fields).toMatchObject([{ name: "sort", type: "hidden", value: "created" }]);
  });

  it("renders a menu with links, a rule, a note and the current item marked", () => {
    const page = parse(
      menu({ label: "More", cls: MenuClass.More }, [
        { label: "Facts", href: "/f", current: true },
        "hr",
        { note: "v1" },
      ]),
    );
    expect(page.$("details.menu.more > summary")?.textContent).toBe("More");
    expect(page.links()).toEqual([{ text: "Facts", href: "/f" }]);
    expect(page.current().map((v) => v.text)).toEqual(["Facts"]);
    expect(page.$$("hr")).toHaveLength(1);
    expect(page.$("p.muted")?.textContent).toBe("v1");
    expect(parse(menu({ label: "Actions" }, [])).$("details.menu")).not.toBeNull();
  });

  it("renders a dialog action as a button and a dialog with a form, a title, the submit and Cancel", () => {
    const { button, dialog } = dialogAction(
      { id: DialogId.CreateWiki, label: "Rename", action: "/console/w/a/x", submit: "Preview" },
      html`<label class="field">Note <input name="note" /></label>`,
    );
    const trigger = parse(button);
    expect(trigger.buttons()).toEqual(["Rename"]);
    const dialogId = trigger.$("button")?.getAttribute("data-dialog");
    const page = parse(dialog);
    expect(page.$("dialog.sheet")?.id).toBe(dialogId);
    expect(page.forms()).toMatchObject([{ method: "post", action: "/console/w/a/x" }]);
    expect(page.headings()).toEqual(["Rename"]);
    expect(page.fieldNames()).toContain("note");
    expect(page.buttons()).toEqual(["Preview", "Cancel"]);
    expect(page.$("button[formmethod=dialog]")?.textContent).toBe("Cancel");
  });

  it("names the dialog by its title for the role dialog", () => {
    const { dialog } = dialogAction(
      { id: DialogId.RunCleanup, label: "Run now", title: "Run the cleanup now", action: "/x" },
      "",
    );
    const el = parse(dialog).$("dialog");
    const labelId = el?.getAttribute("aria-labelledby") ?? "";
    expect(labelId).not.toBe("");
    expect(el?.querySelector(`#${labelId}`)?.textContent).toBe("Run the cleanup now");
  });

  it("titles the dialog apart from its button when asked", () => {
    const { button, dialog } = dialogAction(
      { id: DialogId.RunCleanup, label: "Run now", title: "Run the cleanup now", action: "/x" },
      "",
    );
    expect(parse(button).buttons()).toEqual(["Run now"]);
    expect(parse(dialog).headings()).toEqual(["Run the cleanup now"]);
  });

  it("posts confirm=0 for the preview, and confirm=1 when the dialog is the confirmation", () => {
    const preview = dialogAction({ id: DialogId.RunCleanup, label: "Run", action: "/x" }, "");
    const confirmed = dialogAction({ id: DialogId.PauseQueue, label: "Pause", action: "/x", confirmed: true }, "");
    expect(parse(preview.dialog).forms()[0]?.fields).toMatchObject([{ name: "confirm", value: "0" }]);
    expect(parse(confirmed.dialog).forms()[0]?.fields).toMatchObject([{ name: "confirm", value: "1" }]);
  });

  it("makes a danger action's button and submit danger", () => {
    const { button, dialog } = dialogAction({ id: DialogId.Archive, label: "Delete", action: "/x", danger: true }, "");
    expect(parse(button).$("button.danger")?.textContent).toBe("Delete");
    expect(parse(dialog).$("button.danger")?.textContent).toBe("Delete");
  });

  it("renders the status pill as a level link", () => {
    const page = parse(statusPill({ level: HealthLevel.Yellow, text: "yellow · queue", title: "t", href: "/h" }));
    expect(page.links()).toEqual([{ text: "yellow · queue", href: "/h" }]);
    expect(page.$("a.status.yellow")?.getAttribute("title")).toBe("t");
  });

  it("renders the paging control only when there is a next page", () => {
    const query = new URLSearchParams("sort=created");
    expect(paging(query, null)).toBeNull();
    const next = parse(paging(query, "c1") ?? "").link("Next page");
    expect(Object.fromEntries(queryOf(next?.href ?? ""))).toEqual({ sort: "created", cursor: "c1" });
  });

  it("builds a sort header for the table", () => {
    const query = new URLSearchParams("sort=created&cursor=c1");
    expect(sortHeader(query, "header", "Header", "created")).toMatchObject({ label: "Header", sorted: false });
    const sorted = sortHeader(query, "created", "Created", "created");
    expect(sorted.sorted).toBe(true);
    expect(Object.fromEntries(queryOf(sorted.href))).toEqual({ sort: "created" });
  });
});

describe("lists", () => {
  it("renders a result with its header, markers, content and meta", () => {
    const page = parse(
      results([
        {
          title: html`<a href="/f">Header</a>`,
          markers: marker("deleted", MarkerClass.Bad),
          content: "Creepers <explode>",
          confidence: 0.5,
        },
      ]),
    );
    expect(page.$$("ol.results > li.result")).toHaveLength(1);
    expect(squash(page.$("li.result h3")?.textContent)).toBe("Header deleted");
    expect(page.$("li.result h3 a")?.getAttribute("href")).toBe("/f");
    expect(page.$("li.result p.content")?.textContent).toBe("Creepers <explode>");
    expect(page.$("li.result .meta .meter")).not.toBeNull();
    expect(page.$("li.result .meta")?.textContent).not.toContain("score");
  });

  it("renders a timeline entry with the when line, the summary, the fold and the current mark", () => {
    const page = parse(
      timeline([
        { when: html`<a href="#seq-2">2</a>`, what: "Changed", current: true },
        {
          when: html`<a href="#seq-1">1</a>`,
          what: "Created",
          fold: { summary: "Diff", body: html`<p>body</p>` },
        },
      ]),
    );
    const entries = page.$$("ol.timeline > li.entry");
    expect(entries).toHaveLength(2);
    expect(entries[0]?.getAttribute("aria-current")).toBe("true");
    expect(entries[1]?.hasAttribute("aria-current")).toBe(false);
    expect(entries[0]?.querySelector(".when a")?.textContent).toBe("2");
    expect(entries[0]?.querySelector("p.what")?.textContent).toBe("Changed");
    expect(entries[0]?.querySelector("details")).toBeNull();
    expect(entries[1]?.querySelector("p.what")?.textContent).toBe("Created");
    expect(page.folds()).toMatchObject([{ summary: "Diff" }]);
    expect(page.folds()[0]?.view.text).toContain("body");
  });

  it("opens the fold of a timeline entry only when the entry says so", () => {
    const fold = { summary: "Diff", body: html`<p>body</p>` };
    expect(parse(timeline([{ when: html`1`, what: "a", fold, open: true }])).folds()[0]?.open).toBe(true);
    expect(parse(timeline([{ when: html`1`, what: "a", fold }])).folds()[0]?.open).toBe(false);
  });

  it("renders the empty state for an empty list, with the given sentence or a default", () => {
    expect(parse(results([], "No fact matches.")).$("p.empty")?.textContent).toBe("No fact matches.");
    for (const out of [results([]), timeline([])]) expect(parse(out).$("p.empty")?.textContent).toBeTruthy();
  });
});

describe("data and interpretation", () => {
  it("renders the label of a signal with its definition in data-definition and title, focusable, and read by aria-describedby", () => {
    const text = SIGNAL_DEFINITIONS[Signal.CostPerWrite];
    const page = parse(definedLabel(Signal.CostPerWrite, "Cost per write"));
    const label = page.$(".defined");
    expect(label?.textContent).toBe("Cost per write");
    expect(label?.getAttribute("data-definition")).toBe(text);
    expect(label?.getAttribute("title")).toBe(text);
    expect(label?.getAttribute("tabindex")).toBe("0");
    const described = page.$(`#${label?.getAttribute("aria-describedby")}`);
    expect(described?.textContent).toBe(text);
    expect(described?.classList.contains("sr-only")).toBe(true);
    expect(page.folds()).toEqual([]);
  });

  it("gives a stat that names a signal the definition on its label, and none to a stat that does not", () => {
    const page = parse(
      stats([
        { label: "Cost per write", value: 9, under: "in 3 writes", signal: Signal.CostPerWrite },
        { label: "Plain", value: 1 },
      ]),
    );
    expect(page.$$("[data-definition]")).toHaveLength(1);
    expect(page.$(".stat .defined")?.getAttribute("title")).toBe(SIGNAL_DEFINITIONS[Signal.CostPerWrite]);
    expect(page.stats()["Cost per write"]).toBeDefined();
    expect(page.$$(".stat > span.l")[1]?.textContent).toBe("Plain");
  });

  it("colors the number of a stat by its level class and leaves a stat with no level in ink", () => {
    const page = parse(
      stats([
        { label: "A", value: 1, level: HealthLevel.Green },
        { label: "B", value: 2, level: HealthLevel.Yellow },
        { label: "C", value: 3, level: HealthLevel.Red },
        { label: "D", value: 4 },
      ]),
    );
    expect(page.$$(".stat > span.n").map((n) => n.getAttribute("class"))).toEqual([
      "n ok",
      "n warning",
      "n failing",
      "n",
    ]);
  });

  it("gives the number of a stat with a reading the sentence on hover and focus, like a definition", () => {
    const sentence = "Poor. Agents leave almost every search without a read.";
    const page = parse(
      stats([
        { label: "With reading", value: 1, level: HealthLevel.Red, reading: sentence },
        { label: "Without reading", value: 2, level: HealthLevel.Green, reading: null },
        { label: "No field", value: 3 },
      ]),
    );
    const [withReading, without, plain] = page.$$(".stat > span.n");
    expect(withReading?.getAttribute("title")).toBe(sentence);
    expect(withReading?.getAttribute("data-definition")).toBe(sentence);
    expect(withReading?.getAttribute("tabindex")).toBe("0");
    expect(withReading?.classList.contains("failing")).toBe(true);
    const hidden = page.$(`#${withReading?.getAttribute("aria-describedby")}`);
    expect(hidden?.classList.contains("sr-only")).toBe(true);
    expect(hidden?.textContent).toBe(sentence);
    for (const n of [without, plain]) {
      expect(n?.getAttribute("title")).toBeNull();
      expect(n?.getAttribute("aria-describedby")).toBeNull();
      expect(n?.hasAttribute("data-definition")).toBe(false);
    }
  });

  it("renders a verdict as a reading line with no word, its level as a class, and no hairline when flush", () => {
    const page = parse(
      verdicts([
        { level: HealthLevel.Yellow, text: "Warning. 2 calls failed in the last hour." },
        { level: HealthLevel.Green, text: "Ok. Fine." },
      ]),
    );
    expect(page.$$("ul.interps > li.interp > p.reading")).toHaveLength(2);
    expect(page.$("p.reading.yellow .sentence")?.textContent).toBe("Warning. 2 calls failed in the last hour.");
    expect(page.$("p.reading svg.info")).not.toBeNull();
    expect(page.$(".status")).toBeNull();
    expect(page.$("ul.interps.flush")).toBeNull();
    expect(
      parse(verdicts([{ level: HealthLevel.Green, text: "All good." }], true)).$("ul.interps.flush"),
    ).not.toBeNull();
  });

  it("reads the current numbers with an entry of the list: the sentence, or null when the data says nothing", () => {
    const data = { stage: { searches: 10, additions: 20, corrections: 5 } };
    expect(reading(data, InterpretationId.Stage)).toBe(
      "Growing fast. Agents add far more than they find: quality should rise as the gaps fill.",
    );
    for (const entry of INTERPRETATIONS) {
      expect(reading({}, entry.id), entry.id).toBeNull();
    }
    expect(() => reading(data, "nope" as InterpretationId)).toThrow();
  });
});

describe("fields", () => {
  it("renders an enum select with a label and an any option", () => {
    const page = parse(enumSelect("kind", "Kind", MenuClass, "more"));
    expect(page.$("label.field")?.textContent).toContain("Kind");
    const options = page.options("kind");
    expect(options[0]).toEqual({ value: "", label: "any", selected: false });
    expect(options.filter((o) => o.selected)).toEqual([{ value: "more", label: "more", selected: true }]);
  });

  it("renders a date field", () => {
    const page = parse(dateField("since", "Since", "2026-10-11"));
    expect(page.field("since")).toMatchObject({ type: "date", value: "2026-10-11" });
    expect(page.labelOf("since")).toBe("Since");
  });

  it("renders an option select over value and label pairs, with the current value selected", () => {
    const page = parse(
      optionSelect(
        "tag",
        "Tag",
        [
          { value: "t1", label: "Mobs" },
          { value: "t2", label: "Items" },
        ],
        "t2",
      ),
    );
    expect(page.options("tag")).toEqual([
      { value: "", label: "any", selected: false },
      { value: "t1", label: "Mobs", selected: false },
      { value: "t2", label: "Items", selected: true },
    ]);
  });
});
