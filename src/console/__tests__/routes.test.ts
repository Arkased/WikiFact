import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseConfig } from "../../config/index.js";
import { LogEvent, Mode } from "../../domain/enums.js";
import type { LogLine } from "../../log/index.js";
import { startHttpServer, type HttpHandle } from "../../mcp/http.js";
import { WIKI_CONFIG_FILE, WIKI_DB_FILE } from "../../paths.js";
import { createWikiRegistry, discoverWikis, type WikiRegistry } from "../../service/registry.js";
import { closeStore, openStoreFor } from "../../store/index.js";
import { accepted, draft, write } from "../../../__tests__/helpers/store.js";
import { registryDeps } from "../deps.js";
import { CONSOLE_PREFIX, SCRIPT_PATH } from "../html.js";
import { exportPage } from "../pages/export.js";
import { factPage } from "../pages/fact.js";
import { healthPage } from "../pages/health.js";
import { requestPage } from "../pages/request.js";
import { requestsPage } from "../pages/requests.js";
import { searchPage } from "../pages/search.js";
import { overviewPage } from "../pages/overview.js";
import { wikisPage } from "../pages/wikis.js";
import { consoleRoute, matchConsolePath } from "../routes.js";
import { STYLE_PATH } from "../style.js";
import { parse } from "./helpers/dom.js";

describe("matchConsolePath", () => {
  it("maps the root to the wikis page with no parameter", () => {
    expect(matchConsolePath("/console/")).toMatchObject({ page: wikisPage, params: {} });
  });

  it("extracts the wiki and the id", () => {
    expect(matchConsolePath("/console/w/alpha/facts/01ABC")).toMatchObject({
      page: factPage,
      params: { w: "alpha", id: "01ABC" },
    });
    expect(matchConsolePath("/console/w/alpha/requests/01R")).toMatchObject({
      page: requestPage,
      params: { w: "alpha", id: "01R" },
    });
  });

  it("prefers the fixed export segment over an id", () => {
    expect(matchConsolePath("/console/w/alpha/facts/export")?.page).toBe(exportPage);
  });

  it('has every route of technical/console.md, "Routes"', () => {
    const paths = [
      "/console/w/alpha",
      "/console/w/alpha/health",
      "/console/w/alpha/facts/export",
      "/console/w/alpha/facts/01F",
      "/console/w/alpha/search",
      "/console/w/alpha/requests",
      "/console/w/alpha/requests/01R",
      "/console/w/alpha/settings",
    ];
    for (const p of paths) expect(matchConsolePath(p), p).toBeDefined();
    expect(matchConsolePath("/console/w/alpha")?.page).toBe(overviewPage);
    expect(matchConsolePath("/console/w/alpha/health")?.page).toBe(healthPage);
    expect(matchConsolePath("/console/w/alpha/search")?.page).toBe(searchPage);
    expect(matchConsolePath("/console/w/alpha/requests")?.page).toBe(requestsPage);
  });

  it("has no route of the removed pages", () => {
    const gone = ["activity", "coverage", "changes/12", "compare", "pulse", "facts", "history", "health/actions"];
    for (const p of gone) expect(matchConsolePath(`/console/w/alpha/${p}`), p).toBeUndefined();
  });

  it("knows no unknown path", () => {
    expect(matchConsolePath("/console/nothing")).toBeUndefined();
    expect(matchConsolePath("/console/w/alpha/facts/a/b")).toBeUndefined();
    expect(matchConsolePath("/console/w/")).toBeUndefined();
    expect(matchConsolePath("/mcp")).toBeUndefined();
  });
});

describe("consoleRoute over the HTTP layer", () => {
  let dir: string;
  let registry: WikiRegistry;
  let handle: HttpHandle;
  let base: string;
  const logs: LogLine[] = [];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "wikifact-console-"));
    const folder = join(dir, "alpha");
    mkdirSync(folder);
    const raw = { mode: Mode.Local, subject: "The <first> wiki." };
    writeFileSync(join(folder, WIKI_CONFIG_FILE), JSON.stringify(raw));
    const store = openStoreFor(parseConfig(raw), join(folder, WIKI_DB_FILE));
    write(store, accepted([draft({ header: "Creeper damage" })]), Date.now());
    closeStore(store);
    registry = createWikiRegistry({
      wikisDir: dir,
      host: "127.0.0.1",
      withWorker: false,
      log: () => undefined,
      baseUrl: () => base,
    });
    for (const w of discoverWikis(dir)) registry.mount(w);
    const log = (l: LogLine): void => {
      logs.push(l);
    };
    handle = await startHttpServer(consoleRoute(registryDeps(registry, log)), { host: "127.0.0.1", port: 0, log });
    base = `http://127.0.0.1:${handle.port}`;
  });

  afterAll(async () => {
    await new Promise((r) => handle.server.close(r));
    registry.stop();
  });

  it("sends the old address of Jobs to the section Jobs of the Operation page with a 303", async () => {
    const res = await fetch(`${base}/console/w/alpha/jobs`, { redirect: "manual" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/console/w/alpha/health#jobs");
  });

  it("answers outside the prefix with 404 and nothing else", async () => {
    expect((await fetch(`${base}/mcp`)).status).toBe(404);
    expect((await fetch(`${base}/consoles`)).status).toBe(404);
  });

  it("renders the wikis page with the service row, the card and the escaped subject", async () => {
    const res = await fetch(`${base}${CONSOLE_PREFIX}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const page = parse(await res.text());
    expect(page.href("alpha")).toBe("/console/w/alpha");
    expect(page.text).toContain("The <first> wiki.");
    expect(page.$("first")).toBeNull();
    expect(page.text).toContain(`${base}/wikis/alpha/mcp`);
    expect(page.kvValue("Address")).toBe(`127.0.0.1:${handle.port}`);
    const cells = page.rowOf("/console/w/alpha") ?? [];
    expect(cells[1]).toMatch(/^(ok|warning|failing)$/);
    expect(cells[2]).toBe("1"); // one live fact
  });

  it("serves the style sheet as CSS", async () => {
    const res = await fetch(`${base}${STYLE_PATH}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/css");
    expect(await res.text()).toContain("prefers-color-scheme: dark");
  });

  it("serves the script file it is given with the JavaScript type", async () => {
    const scriptFile = join(dir, "script.js");
    writeFileSync(scriptFile, "console.log('hi');\n");
    const log = (): void => undefined;
    const h = await startHttpServer(consoleRoute(registryDeps(registry, log), { scriptFile }), {
      host: "127.0.0.1",
      port: 0,
      log,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${h.port}${SCRIPT_PATH}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/javascript");
      expect(await res.text()).toBe("console.log('hi');\n");
    } finally {
      await new Promise((r) => h.server.close(r));
    }
  });

  it("answers 404 for the script when its file does not exist", async () => {
    const log = (): void => undefined;
    const h = await startHttpServer(
      consoleRoute(registryDeps(registry, log), { scriptFile: join(dir, "missing.js") }),
      { host: "127.0.0.1", port: 0, log },
    );
    try {
      expect((await fetch(`http://127.0.0.1:${h.port}${SCRIPT_PATH}`)).status).toBe(404);
    } finally {
      await new Promise((r) => h.server.close(r));
    }
  });

  it("renders a section page for a known wiki, with the script tag, and 404 for an unknown one", async () => {
    const ok = await fetch(`${base}/console/w/alpha/search`);
    expect(ok.status).toBe(200);
    const page = parse(await ok.text());
    expect(page.title).toMatch(/alpha - WikiFact$/);
    expect(page.$("script[src]")?.getAttribute("src")).toBe(SCRIPT_PATH);
    expect(page.$("script[src]")?.hasAttribute("defer")).toBe(true);
    const missing = await fetch(`${base}/console/w/nope/search`);
    expect(missing.status).toBe(404);
    expect(parse(await missing.text()).text).toContain('no wiki named "nope"');
  });

  it("renders a 404 page for an unknown path under the prefix", async () => {
    const res = await fetch(`${base}/console/nothing`);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("Error 404");
  });

  it("redirects /console to /console/ and refuses POST", async () => {
    const moved = await fetch(`${base}/console`, { redirect: "manual" });
    expect(moved.status).toBe(301);
    expect(moved.headers.get("location")).toBe(CONSOLE_PREFIX);
    const post = await fetch(`${base}/console/`, { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET");
  });

  it("logs one console_page line per request with the path and the status", () => {
    const pages = logs.filter((l) => l.event === LogEvent.ConsolePage);
    expect(pages).toContainEqual(expect.objectContaining({ level: "info", path: "/console/", status: 200 }));
    for (const p of pages) expect(p).toHaveProperty("durationMs", expect.anything());
    expect(pages).toContainEqual(expect.objectContaining({ path: "/console/nothing", status: 404 }));
    expect(pages).toContainEqual(expect.objectContaining({ path: "/console/w/nope/search", status: 404 }));
  });
});
