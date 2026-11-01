import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Mode } from "../../domain/enums.js";
import { seedChange } from "../../store/index.js";
import { accepted, draft } from "../../../__tests__/helpers/store.js";
import { wikisPage } from "../pages/wikis.js";
import { parse } from "./helpers/dom.js";
import { openTmpWiki, type TmpWiki } from "./helpers/tmp-wiki.js";

let wiki: TmpWiki;
beforeEach(() => {
  wiki = openTmpWiki();
});
afterEach(() => wiki.close());

/** A time as a page shows it: the hour and minute for today, else the date before them. */
const DATE = /^(\d{4}-\d\d-\d\d )?\d\d:\d\d$/;

describe("wikisPage", () => {
  it("shows a wiki with no fact as a row: the link, the badge to Health, zeros, a stopped worker, no change yet", () => {
    const page = parse(wikisPage(wiki.ctx()));
    const table = page.within("main");
    const cells = table?.rowOf("/console/w/alpha") ?? [];
    expect(table?.href("alpha")).toBe("/console/w/alpha");
    expect(cells[0]).toContain("alpha");
    expect(cells[1]).toMatch(/^(ok|warning|failing)$/);
    expect(table?.itemWith("/console/w/alpha/health")?.text).toContain(cells[1] ?? "?");
    expect(cells.slice(2, 4)).toEqual(["0", "0"]);
    expect(cells[4]).toBe("stopped");
    expect(cells[5]).not.toMatch(DATE);
    expect(page.rows()).toHaveLength(1);
  });

  it("shows the counts, the last change time and the health of the wiki in its row", async () => {
    const now = Date.now() - 1000;
    await seedChange(
      wiki.store,
      accepted([draft({ header: "Alpha", content: "Alpha content." }), draft({ header: "Beta" })]),
      { now },
    );
    const page = parse(wikisPage(wiki.ctx()));
    const cells = page.rowOf("/console/w/alpha") ?? [];
    expect(cells.slice(2, 4)).toEqual(["2", "0"]);
    expect(cells[5]).toMatch(DATE);
    expect(page.$$("td time").map((t) => t.getAttribute("datetime"))).toContain(new Date(now).toISOString());
    // A wiki without a worker is red on the worker row (technical/console.md, "Health").
    expect(cells[1]).toBe("failing");
  });

  it("shows no table of wikis when no wiki is mounted", () => {
    const deps = { ...wiki.deps, listWikis: () => [] };
    const page = parse(wikisPage({ ...wiki.ctx(), deps }));
    expect(page.rows()).toEqual([]);
    expect(page.href("alpha")).toBeUndefined();
    expect(page.header("Live facts")).toBeUndefined();
  });

  it("describes the service in a key-value panel", () => {
    const page = parse(wikisPage(wiki.ctx()));
    expect(page.title).toBe("Wikis - WikiFact");
    expect(page.kvValue("Version")).toBe("0.0.0-test");
    expect(page.kvValue("Address")).toBe("127.0.0.1:1");
    expect(page.kvValue("Mode")).toBe(Mode.Local);
    expect(page.kvValue("Wikis directory")).toBe(wiki.dir);
    expect(page.kvValue("Log directory")).toBe(wiki.logDir);
    // The table and the archives panel show the rest.
    for (const term of ["Wikis mounted", "Archives", "Errors, 24 hours"]) expect(page.kvValue(term)).toBeUndefined();
  });

  it("lists the archives with a restore button, or none", () => {
    const none = parse(wikisPage(wiki.ctx()));
    expect(none.section("Archives")?.tables()).toEqual([]);
    const archives = [{ name: "old", folder: "old-20260101-000000", archivedAt: "2026-01-01T00:00:00.000Z" }];
    const deps = { ...wiki.deps, service: () => ({ ...wiki.deps.service(), archives }) };
    const page = parse(wikisPage({ ...wiki.ctx(), deps }));
    const section = page.section("Archives");
    const cells = section?.row("old") ?? [];
    expect(cells[0]).toBe("old");
    expect(section?.$("time")?.getAttribute("datetime")).toBe("2026-01-01T00:00:00.000Z");
    expect(section?.formTo("/console/w/old-20260101-000000/unarchive")?.method).toBe("post");
    expect(section?.buttons()).toEqual(["Restore"]);
  });

  it("offers 'Create wiki' as a button in the page header with a form that posts to the create route", () => {
    const page = parse(wikisPage(wiki.ctx()));
    expect(page.buttons()).toContain("Create wiki");
    const form = page.formTo("/console/wikis");
    expect(form?.method).toBe("post");
    expect(form?.fields.map((f) => f.name)).toEqual(expect.arrayContaining(["name", "subject", "quality"]));
    const cells = page.rowOf("/console/w/alpha") ?? [];
    expect(cells[6]).toContain("/wikis/alpha/mcp");
    expect(page.formTo("/console/w/alpha/archive")?.method).toBe("post");
  });

  it("offers no write when the console may not write", () => {
    const deployed = openTmpWiki("alpha", { mode: Mode.Deployed });
    try {
      const page = parse(wikisPage(deployed.ctx()));
      expect(page.buttons()).not.toContain("Create wiki");
      expect(page.formTo("/console/w/alpha/archive")).toBeUndefined();
      expect(page.forms().filter((f) => f.method === "post")).toEqual([]);
      expect(page.href("alpha")).toBe("/console/w/alpha");
    } finally {
      deployed.close();
    }
  });
});
