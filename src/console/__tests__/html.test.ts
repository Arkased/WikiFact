import { describe, expect, it } from "vitest";
import { ConsoleSection, HealthLevel } from "../../domain/enums.js";
import { act, day, escapeHtml, html, layout, num, raw, table, time, wide, wikiPath, type StatusPill } from "../html.js";
import { parse } from "./helpers/dom.js";

describe("escapeHtml", () => {
  it("escapes the 5 characters that break markup or an attribute", () => {
    const text = `<a href="x">Tom & Jerry's</a>`;
    const page = parse(`<p title="${escapeHtml(text)}">${escapeHtml(text)}</p>`);
    expect(page.text).toBe(text);
    expect(page.$("p")?.getAttribute("title")).toBe(text);
    expect(page.$("a")).toBeNull();
  });

  it("leaves other text alone", () => {
    expect(escapeHtml("Creepers do 10 damage. Ünïcödé")).toBe("Creepers do 10 damage. Ünïcödé");
  });
});

describe("html", () => {
  it("escapes an interpolated string and inserts safe markup as is", () => {
    const page = parse(html`<p>${"<b>db text</b>"}${raw("<em>code</em>")}</p>`);
    expect(page.text).toBe("<b>db text</b>code");
    expect(page.$("b")).toBeNull();
    expect(page.$("em")?.textContent).toBe("code");
  });

  it("joins arrays and drops null, undefined and false", () => {
    const page = parse(
      html`<ul>
        ${[html`<li>a</li>`, null, undefined, false, html`<li>b</li>`]}
      </ul>`,
    );
    expect(page.$$("li").map((li) => li.textContent)).toEqual(["a", "b"]);
    expect(page.text).not.toMatch(/null|undefined|false/);
  });

  it("renders a number", () => {
    expect(parse(html`<p>${42}</p>`).text).toBe("42");
  });
});

describe("table", () => {
  it("escapes the cells", () => {
    const page = parse(table(["h"], [["<x>"]]));
    expect(page.rows()).toEqual([["<x>"]]);
    expect(page.$("td x")).toBeNull();
  });

  it("returns the empty sentence and no table when there is no row", () => {
    const page = parse(table(["a", "b"], [], { empty: "No fact matches." }));
    expect(page.text).toBe("No fact matches.");
    expect(page.tables()).toEqual([]);
    expect(parse(table(["a"], [], { count: "0 facts" })).text).not.toContain("0 facts");
  });

  it("renders a sort header as a link, and marks the sorted one", () => {
    const page = parse(
      table(
        [
          { label: "Header", href: "?sort=header", sorted: false },
          { label: "Created", href: "?sort=created", sorted: true },
        ],
        [["x", "y"]],
      ),
    );
    expect(page.headers()).toEqual([
      { label: "Header", href: "?sort=header", sort: "none" },
      { label: "Created", href: "?sort=created", sort: "descending" },
    ]);
    expect(page.rows()).toEqual([["x", "y"]]);
  });

  it("shows the count line with the table", () => {
    const page = parse(table(["a"], [["x"]], { count: "90 facts" }));
    expect(page.text).toContain("90 facts");
    expect(page.rows()).toEqual([["x"]]);
  });

  it("gives a header with no text and an action cell the class of the action column", () => {
    const page = parse(table(["Job", ""], [["a", act(html`<button>Run</button>`)]]));
    expect(page.$("th.act")?.textContent).toBe("");
    expect(page.$("td.act button")?.textContent).toBe("Run");
    expect(page.$$("th.act")).toHaveLength(1);
  });

  it("shows a num cell and a wide cell with their text, escaped", () => {
    const page = parse(table(["n", "t"], [[num(7), wide('a "long" <text>')]]));
    expect(page.rows()).toEqual([["7", 'a "long" <text>']]);
    expect(page.$("td.num")?.textContent).toBe("7");
    expect(page.$("td.wide")?.getAttribute("title")).toBe('a "long" <text>');
  });
});

describe("time", () => {
  const ms = new Date(2026, 9, 11, 8, 5, 9).getTime();

  it("shows the local date and minute, and the ISO time in datetime", () => {
    const page = parse(time(ms));
    expect(page.text).toBe("2026-10-11 08:05");
    expect(page.$("time")?.getAttribute("datetime")).toBe(new Date(ms).toISOString());
  });

  it("adds the seconds on request", () => {
    expect(parse(time(ms, { seconds: true })).text).toBe("2026-10-11 08:05:09");
  });

  it("keeps the unix milliseconds in the title of a day that is not today", () => {
    expect(parse(time(ms)).$("time")?.getAttribute("title")).toBe(String(ms));
  });

  it("shows a time of today as the hour and the minute, with the ISO time in the title", () => {
    const today = new Date(2026, 9, 11, 20, 0, 0).getTime();
    const page = parse(time(ms, { now: today }));
    expect(page.text).toBe("08:05");
    expect(page.$("time")?.getAttribute("title")).toBe(new Date(ms).toISOString());
    expect(parse(time(ms, { now: today, seconds: true })).text).toBe("08:05:09");
    // The next day it is a date again.
    expect(parse(time(ms, { now: today + 86_400_000 })).text).toBe("2026-10-11 08:05");
  });
});

describe("day", () => {
  it("shows the local date alone", () => {
    expect(parse(day(new Date(2026, 9, 11, 8, 5, 9).getTime())).text).toBe("2026-10-11");
  });
});

describe("layout", () => {
  const pill: StatusPill = {
    level: HealthLevel.Red,
    text: "red · worker",
    title: "worker: no worker has run",
    href: "/console/w/alpha/health",
  };
  const base = { title: "T", wikis: ["alpha", "b<eta"], wiki: "alpha" };

  it("escapes the title and the wiki names and has the document title", () => {
    const page = parse(layout({ ...base, title: "T <1>" }, html`<p>body</p>`));
    expect(page.title).toBe("T <1> - alpha - WikiFact");
    expect(page.headings("h1")).toEqual(["T <1>"]);
    expect(page.link("b<eta")).toBeDefined();
    expect(page.$("eta")).toBeNull();
  });

  it("has the brand, the wiki switcher with the current wiki, and the tabs", () => {
    const page = parse(layout(base, html``));
    expect(page.href("WikiFact")).toBe("/console/");
    const switcher = page.fold("alpha");
    expect(switcher?.links().map((l) => l.text)).toEqual(["alpha", "b<eta", "All wikis"]);
    expect(switcher?.current().map((v) => v.text)).toEqual(["alpha"]);
    expect(switcher?.href("alpha")).toBe("/console/w/alpha");
    expect(page.within('nav[aria-label="Sections"]')).toBeDefined();
  });

  it("lists the 2 goal pages as tabs and marks the current one", () => {
    const page = parse(layout({ ...base, section: ConsoleSection.Health }, html``));
    const tabs = page.within('nav[aria-label="Sections"]');
    expect(tabs?.links().map((l) => l.text)).toEqual(["Overview", "Operation"]);
    expect(tabs?.href("Operation")).toBe(wikiPath("alpha", ConsoleSection.Health));
    expect(tabs?.current().map((v) => v.text)).toEqual(["Operation"]);
    expect(wikiPath("alpha", ConsoleSection.Overview)).toBe("/console/w/alpha");
    expect(wikiPath("alpha", ConsoleSection.Search)).toBe("/console/w/alpha/search");
  });

  it("holds the tools, the export link and the version in the More menu, marking the current tool", () => {
    const page = parse(layout({ ...base, section: ConsoleSection.Requests, version: "1.2.3" }, html``));
    const more = page.fold("More");
    expect(more?.links().map((l) => l.text)).toEqual(["Search", "Requests", "Settings", "Export"]);
    expect(more?.href("Requests")).toBe(wikiPath("alpha", ConsoleSection.Requests));
    expect(more?.current().map((v) => v.text)).toEqual(["Requests"]);
    expect(more?.href("Export")).toBe("/console/w/alpha/facts/export?format=json");
    expect(more?.text).toContain("v1.2.3");
  });

  it("renders the status pill as a link with its text and title", () => {
    const page = parse(layout({ ...base, status: pill }, html``));
    expect(page.href("red · worker")).toBe("/console/w/alpha/health");
    expect(page.$("a.status")?.getAttribute("title")).toBe("worker: no worker has run");
    expect(parse(layout(base, html``)).text).not.toContain("red · worker");
  });

  it("holds only the brand and the version on a page without a wiki", () => {
    const page = parse(layout({ title: "Wikis", wikis: ["alpha"], version: "1.2.3" }, html``));
    expect(page.title).toBe("Wikis - WikiFact");
    expect(page.href("WikiFact")).toBe("/console/");
    expect(page.text).toContain("v1.2.3");
    expect(page.within('nav[aria-label="Sections"]')).toBeUndefined();
    expect(page.folds()).toEqual([]);
    expect(page.text).not.toContain("More");
  });

  it("loads the script deferred and does not use a meta refresh", () => {
    const page = parse(layout({ title: "T", wikis: [], refreshSeconds: 15 }, html``));
    const script = page.$("script[src]");
    expect(script?.getAttribute("src")).toBe("/console/console.js");
    expect(script?.hasAttribute("defer")).toBe(true);
    expect(page.$("meta[http-equiv]")).toBeNull();
  });

  it("asks the script to refresh main only when asked", () => {
    const refresh = parse(layout({ title: "T", wikis: [], refreshSeconds: 15 }, html``));
    expect(refresh.$("main")?.getAttribute("data-refresh")).toBe("15");
    expect(
      parse(layout({ title: "T", wikis: [] }, html``))
        .$("main")
        ?.hasAttribute("data-refresh"),
    ).toBe(false);
  });

  it("renders the controls in the page header, and not without them", () => {
    const controls = html`<button>Correct</button>`;
    const page = parse(layout({ title: "T", wikis: [], controls }, html``));
    expect(page.within("main")?.buttons()).toEqual(["Correct"]);
    expect(parse(layout({ title: "T", wikis: [] }, html``)).buttons()).toEqual([]);
  });

  it("renders the lead, the badge and the version", () => {
    const page = parse(
      layout(
        {
          title: "T",
          wikis: [],
          lead: "A <lead>",
          badge: html`<span class="badge green">green</span>`,
          version: "1.2.3",
        },
        html``,
      ),
    );
    expect(page.text).toContain("A <lead>");
    expect(page.within("main")?.text).toContain("green");
    expect(page.text).toContain("v1.2.3");
  });
});
