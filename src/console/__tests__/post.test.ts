import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LogEvent, Mode, OperatorEditKind } from "../../domain/enums.js";
import type { LogLine } from "../../log/index.js";
import { applyChangeSync, enqueueOperatorEdit } from "../../store/index.js";
import { T0, accepted, draft } from "../../../__tests__/helpers/store.js";
import { MAX_FORM_BYTES, matchWriteRoute } from "../post.js";
import { parse, type Page } from "./helpers/dom.js";
import { fakeWrites, linesOf, post, serveConsole, type FakeWrites, type RunningConsole } from "./helpers/serve.js";
import { openTmpWiki, type TmpWiki } from "./helpers/tmp-wiki.js";

let wiki: TmpWiki;
let server: RunningConsole;
let fake: FakeWrites;
let lines: LogLine[];

async function start(mode: Mode, host = "127.0.0.1"): Promise<void> {
  fake = fakeWrites();
  lines = [];
  wiki = openTmpWiki("alpha", { mode, host, writes: fake.writes, log: (l) => lines.push(l) });
  server = await serveConsole(wiki.deps);
}

async function getPage(path: string): Promise<Page> {
  return parse(await (await fetch(`${server.base}${path}`)).text());
}

afterEach(async () => {
  await server.close();
  wiki.close();
});

describe("matchWriteRoute", () => {
  beforeEach(() => start(Mode.Local));

  it('has every route of technical/console.md, "Operator actions" and "Direct edits of non-request fields"', () => {
    const paths = [
      "/console/w/a/jobs/cleanup",
      "/console/w/a/jobs/reindex",
      "/console/wikis",
      "/console/w/a/archive",
      "/console/w/a/unarchive",
      "/console/w/a/settings/description",
      "/console/w/a/settings/config",
      "/console/w/a/settings/rename",
    ];
    for (const p of paths) expect(matchWriteRoute(p), p).toBeDefined();
    expect(matchWriteRoute("/console/w/a/facts")).toBeUndefined();
    expect(matchWriteRoute("/console/w/a/index/check")).toBeUndefined();
  });
});

describe("in local mode", () => {
  beforeEach(() => start(Mode.Local));

  it("is a 400 for a body over the form cap and for a content type that is not a form", async () => {
    const big = await post(server.base, "/console/w/alpha/jobs/reindex", { note: "x".repeat(MAX_FORM_BYTES) });
    expect(big.status).toBe(400);
    const json = await fetch(`${server.base}/console/w/alpha/jobs/reindex`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(json.status).toBe(400);
    expect(linesOf(lines, LogEvent.ConsoleAction)).toHaveLength(0);
  });

  it("reads a body just under the cap", async () => {
    const res = await post(server.base, "/console/w/alpha/jobs/reindex", {
      note: "x".repeat(500),
      pad: "y".repeat(MAX_FORM_BYTES - 1000),
      confirm: "0",
    });
    expect(res.status).toBe(200);
  });

  it("answers 405 for a POST on a path that has no write route, and 404 for a GET on a write route", async () => {
    expect((await post(server.base, "/console/w/alpha/facts", {})).status).toBe(405);
    expect((await post(server.base, "/console/nothing", {})).status).toBe(405);
    expect((await fetch(`${server.base}/console/w/alpha/jobs/reindex`)).status).toBe(404);
  });

  it("logs the POST as a console_page line next to the console_action line", async () => {
    const done = await post(server.base, "/console/w/alpha/jobs/reindex", { confirm: "1", note: "n" });
    expect(done.status).toBe(303);
    expect(linesOf(lines, LogEvent.ConsoleAction)).toHaveLength(1);
  });

  it("answers 404 for the old health actions page", async () => {
    expect((await fetch(`${server.base}/console/w/alpha/health/actions`)).status).toBe(404);
  });
});

describe("the operator edit in words", () => {
  beforeEach(() => start(Mode.Local));

  it("says operator edit and the note in the requests list and the request page", async () => {
    const id = enqueueOperatorEdit(wiki.store, { edit: OperatorEditKind.Reindex, note: "after the fix" }, T0 + 1);
    applyChangeSync(wiki.store, id, accepted([draft()]), { now: T0 + 2 });
    const list = await getPage("/console/w/alpha/requests");
    expect(list.text).toContain("operator edit");
    expect(list.text).toContain("reindex");
    expect(list.text).toContain("after the fix");
    const page = await getPage(`/console/w/alpha/requests/${id}`);
    expect(page.text).toContain("operator edit");
    expect(page.text).toContain("reindex");
    expect(page.kvValue("Why")).toBe("after the fix");
  });
});

describe("in deployed mode", () => {
  beforeEach(() => start(Mode.Deployed));

  it("shows no form on any page", async () => {
    const paths = [
      "/console/",
      "/console/w/alpha",
      "/console/w/alpha/health",
      "/console/w/alpha/jobs",
      "/console/w/alpha/search",
    ];
    for (const p of [...paths, "/console/w/alpha/settings", "/console/w/alpha/requests"]) {
      expect(
        (await getPage(p)).forms().filter((f) => f.method === "post"),
        p,
      ).toEqual([]);
    }
  });
});

describe("serve --db: the wiki-level writes", () => {
  beforeEach(() => start(Mode.Local));

  it("is a 409 not in service mode, while the jobs still work", async () => {
    const solo = openTmpWiki("solo");
    const soloServer = await serveConsole(solo.deps);
    try {
      const refused = await post(soloServer.base, "/console/w/solo/archive", { confirm: "1" });
      expect(refused.status).toBe(409);
      expect(parse(await refused.text()).text).toContain("not in service mode");
      expect((await post(soloServer.base, "/console/wikis", { name: "b", subject: "s", confirm: "1" })).status).toBe(
        409,
      );
      expect((await post(soloServer.base, "/console/w/solo/jobs/reindex", { note: "n", confirm: "1" })).status).toBe(
        303,
      );
    } finally {
      await soloServer.close();
      solo.close();
    }
  });
});
