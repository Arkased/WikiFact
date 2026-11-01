// End to end: `serve --wikis <dir> --http 0` as a child process, with the console (technical/console.md, "Mount in the service") fetched over HTTP.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/index.js";
import { ConsoleAction, LogEvent, Mode, RequestKind, RequestStatus } from "../src/domain/enums.js";
import { WIKI_CONFIG_FILE, WIKI_DB_FILE } from "../src/paths.js";
import { closeStore, getRequest, listFacts, openStoreFor } from "../src/store/index.js";
import { parse } from "../src/console/__tests__/helpers/dom.js";
import { accepted, draft, write } from "./helpers/store.js";
import { PROCESS_START_TIMEOUT_MS } from "./helpers/timeouts.js";

const ROOT = resolve(import.meta.dirname, "..");
/** How long the server gets to print its listening line, in ms. */
/** How often the test looks for the listening line in the log file, in ms. */
const POLL_MS = 100;
/** The one wiki that `beforeAll` seeds. */
const WIKI = "alpha";

let dir: string;
let child: ChildProcess;
let base: string;
const stderrLines: string[] = [];

function seedWiki(name: string, subject: string, header: string): void {
  const folder = join(dir, name);
  mkdirSync(folder);
  writeFileSync(join(folder, WIKI_CONFIG_FILE), JSON.stringify({ mode: Mode.Local, subject }));
  const store = openStoreFor(parseConfig({ mode: Mode.Local, subject }), join(folder, WIKI_DB_FILE));
  write(store, accepted([draft({ header, content: `${header} is a fact.` })]), Date.now());
  closeStore(store);
}

function serviceLogLines(): Record<string, unknown>[] {
  const logs = join(dir, ".logs");
  if (!existsSync(logs)) return [];
  return readdirSync(logs)
    .filter((f) => /^service\.\d+\.log$/.test(f))
    .flatMap((f) => readFileSync(join(logs, f), "utf8").split("\n"))
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

// Waits for the `listening` line and the `wiki_mounted` line of the seeded wiki, and returns the bound port.
function waitForPort(proc: ChildProcess): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const fail = (why: string): void => {
      clearInterval(poll);
      clearTimeout(timer);
      reject(new Error(`${why}:\n${stderrLines.join("")}`));
    };
    const timer = setTimeout(() => fail("no listening line"), PROCESS_START_TIMEOUT_MS);
    const poll = setInterval(() => {
      const lines = serviceLogLines();
      const hit = lines.find((l) => l.event === LogEvent.Listening);
      if (hit === undefined || !lines.some((l) => l.event === LogEvent.WikiMounted)) return;
      clearInterval(poll);
      clearTimeout(timer);
      resolvePort(Number(hit.port));
    }, POLL_MS);
    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on("data", (chunk: string) => stderrLines.push(chunk));
    proc.once("exit", (code) => fail(`serve exited with ${code}`));
  });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "wikifact-console-e2e-"));
  seedWiki(WIKI, "The first wiki.", "Creeper damage");
  child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--import",
      pathToFileURL(join(ROOT, "__tests__/helpers/preload-fake-embedder.ts")).href,
      join(ROOT, "src/cli.ts"),
      "serve",
      "--wikis",
      dir,
      "--http",
      "0",
    ],
    { cwd: ROOT, stdio: ["ignore", "ignore", "pipe"] },
  );
  base = `http://127.0.0.1:${await waitForPort(child)}`;
}, PROCESS_START_TIMEOUT_MS + 5000);

afterAll(async () => {
  const exited = new Promise((r) => child.once("exit", r));
  child.kill();
  await exited;
});

describe("the console of serve --wikis", () => {
  it("serves the wikis page with the wiki name, the MCP URL and the service row", async () => {
    const res = await fetch(`${base}/console/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const page = parse(await res.text());
    expect(page.href(WIKI)).toBe(`/console/w/${WIKI}`);
    expect(page.text).toContain("The first wiki.");
    expect(page.text).toContain(`${base}/wikis/${WIKI}/mcp`);
    expect(page.kvValue("Wikis directory")).toBeDefined();
    expect(page.text).toContain(join(dir, ".logs"));
  });

  it("serves the style sheet", async () => {
    const res = await fetch(`${base}/console/style.css`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/css");
  });

  // The server runs from source and cannot be given a script file: the 200 path is in routes.test.ts.
  it("answers the script route with 200 when the build made it, else 404", async () => {
    const res = await fetch(`${base}/console/console.js`);
    expect([200, 404]).toContain(res.status);
  });

  it("serves the page Overview and a fact page, each with the frame and the script tag", async () => {
    const signals = await fetch(`${base}/console/w/${WIKI}`);
    expect(signals.status).toBe(200);
    const page = parse(await signals.text());
    expect(page.title).toBe(`Overview - ${WIKI} - WikiFact`);
    expect(page.$("script[src]")?.getAttribute("src")).toBe("/console/console.js");
    expect(page.linkTo(`/console/w/${WIKI}/health`)).toBeDefined();
    expect(page.linkTo(`/console/w/${WIKI}/jobs`)).toBeUndefined();
    expect(page.fold("More")?.links().length).toBeGreaterThan(0);
    expect((await fetch(`${base}/console/w/${WIKI}?span=all`)).status).toBe(200);
    // The old address of Jobs leads to the Operation page.
    expect((await fetch(`${base}/console/w/${WIKI}/jobs`, { redirect: "manual" })).status).toBe(303);
    expect((await fetch(`${base}/console/w/${WIKI}/pulse`)).status).toBe(404);
    expect((await fetch(`${base}/console/w/${WIKI}/search?sample=1`)).status).toBe(200);
    expect((await fetch(`${base}/console/w/${WIKI}/requests`)).status).toBe(200);

    const config = parseConfig({ mode: Mode.Local, subject: "The first wiki." });
    const store = openStoreFor(config, join(dir, WIKI, WIKI_DB_FILE));
    try {
      const factId = listFacts(store, { now: Date.now() }).items[0]?.id ?? "";
      const fact = await fetch(`${base}/console/w/${WIKI}/facts/${factId}`);
      expect(fact.status).toBe(200);
      expect(parse(await fact.text()).text).toContain("Creeper damage is a fact.");
    } finally {
      closeStore(store);
    }
  });

  it('serves the Operation page of technical/console.md, "Routes" and 404 for an unknown path', async () => {
    const health = await fetch(`${base}/console/w/${WIKI}/health`);
    expect(health.status).toBe(200);
    expect(parse(await health.text()).title).toBe(`Operation - ${WIKI} - WikiFact`);
    expect((await fetch(`${base}/console/nothing`)).status).toBe(404);
    expect((await fetch(`${base}/console/w/nope`)).status).toBe(404);
  });

  it("logs a console_page line in the service log", async () => {
    await fetch(`${base}/console/w/${WIKI}/search`);
    const line = serviceLogLines().find(
      (l) => l.event === LogEvent.ConsolePage && l.path === `/console/w/${WIKI}/search`,
    );
    expect(line).toMatchObject({ level: "info", status: 200 });
  });

  it("writes in local mode: a preview, then a reindex and a cleanup run that land as operatorEdit rows", async () => {
    const config = parseConfig({ mode: Mode.Local, subject: "The first wiki." });
    const store = openStoreFor(config, join(dir, WIKI, WIKI_DB_FILE));
    try {
      const send = (path: string, fields: Record<string, string>): Promise<Response> =>
        fetch(`${base}${path}`, {
          method: "POST",
          redirect: "manual",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams(fields).toString(),
        });

      const reindexPath = `/console/w/${WIKI}/jobs/reindex`;
      const preview = await send(reindexPath, { confirm: "0", note: "round trip" });
      expect(preview.status).toBe(200);
      const reindexed = await send(reindexPath, { confirm: "1", note: "round trip" });
      expect(reindexed.status).toBe(303);
      const id = reindexed.headers.get("location")?.split("/").pop() ?? "";
      expect(getRequest(store, id)).toMatchObject({ kind: RequestKind.OperatorEdit, status: RequestStatus.Queued });
      const page = parse(await (await fetch(`${base}/console/w/${WIKI}/requests/${id}`)).text());
      expect(page.text).toContain("operator edit");
      expect(page.kvValue("Operator edit")).toBe("reindex");

      const cleanup = await send(`/console/w/${WIKI}/jobs/cleanup`, { confirm: "1", note: "first run" });
      expect(cleanup.status).toBe(303);
      const cleanupId = cleanup.headers.get("location")?.split("/").pop() ?? "";
      expect(getRequest(store, cleanupId)).toMatchObject({
        kind: RequestKind.OperatorEdit,
        status: RequestStatus.Queued,
      });

      // The section Jobs of the Operation page links the request of the reindex it queued.
      const jobs = parse(await (await fetch(`${base}/console/w/${WIKI}/health`)).text());
      expect(jobs.linkTo(`/requests/${id}`)).toBeDefined();

      const actions = serviceLogLines().filter((l) => l.event === LogEvent.ConsoleAction);
      expect(actions).toEqual([
        expect.objectContaining({ level: "info", action: ConsoleAction.Reindex, wiki: WIKI, id }),
        expect.objectContaining({ level: "info", action: ConsoleAction.RunCleanup, wiki: WIKI, id: cleanupId }),
      ]);
    } finally {
      closeStore(store);
    }
  });

  it("refuses a POST whose Origin is another site with 403, and takes the service's own Origin", async () => {
    const send = (origin: string): Promise<Response> =>
      fetch(`${base}/console/w/${WIKI}/jobs/reindex`, {
        method: "POST",
        redirect: "manual",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: origin },
        body: new URLSearchParams({ confirm: "0", note: "origin check" }).toString(),
      });
    const foreign = await send("http://evil.example");
    expect(foreign.status).toBe(403);
    expect((await send(base)).status).toBe(200);
  });

  it("still serves MCP: POST works and GET is 405", async () => {
    expect((await fetch(`${base}/mcp`)).status).toBe(405);
    const client = new Client({ name: "console-test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/wikis/${WIKI}/mcp`)));
    const hit = await client.callTool({ name: "search", arguments: { query: "creeper damage" } });
    expect(JSON.stringify(hit.structuredContent)).toContain("Creeper damage");
    await client.close();
    // The call counted: the Operation page shows the search of the endpoint of this wiki.
    const health = parse(await (await fetch(`${base}/console/w/${WIKI}/health`)).text());
    expect(Number(health.section("MCP server, now")?.stats()["Tool calls"]?.value)).toBeGreaterThanOrEqual(1);
  });
});

describe("the console of serve --db", () => {
  let dbDir: string;
  let dbChild: ChildProcess;
  let dbBase: string;

  // Without a log directory the process logs to stderr, so the listening line is read there.
  function waitForStderrPort(proc: ChildProcess): Promise<number> {
    return new Promise((resolvePort, reject) => {
      let text = "";
      const timer = setTimeout(() => reject(new Error(`no listening line:\n${text}`)), PROCESS_START_TIMEOUT_MS);
      proc.stderr?.setEncoding("utf8");
      proc.stderr?.on("data", (chunk: string) => {
        text += chunk;
        for (const line of text.split("\n").filter((l) => l !== "")) {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (parsed.event === LogEvent.Listening) {
            clearTimeout(timer);
            resolvePort(Number(parsed.port));
          }
        }
      });
      proc.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`serve exited with ${code}:\n${text}`));
      });
    });
  }

  beforeAll(async () => {
    dbDir = mkdtempSync(join(tmpdir(), "wikifact-console-db-"));
    const folder = join(dbDir, "demo");
    mkdirSync(folder);
    writeFileSync(join(folder, WIKI_CONFIG_FILE), JSON.stringify({ mode: Mode.Local, subject: "One database." }));
    const dbPath = join(folder, WIKI_DB_FILE);
    const store = openStoreFor(parseConfig({ mode: Mode.Local, subject: "One database." }), dbPath);
    write(store, accepted([draft({ header: "Zombie health" })]), Date.now());
    closeStore(store);
    dbChild = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--import",
        pathToFileURL(join(ROOT, "__tests__/helpers/preload-fake-embedder.ts")).href,
        join(ROOT, "src/cli.ts"),
        "serve",
        "--db",
        dbPath,
        "--http",
        "0",
      ],
      { cwd: ROOT, stdio: ["ignore", "ignore", "pipe"] },
    );
    dbBase = `http://127.0.0.1:${await waitForStderrPort(dbChild)}`;
  }, PROCESS_START_TIMEOUT_MS + 5000);

  afterAll(async () => {
    const exited = new Promise((r) => dbChild.once("exit", r));
    dbChild.kill();
    await exited;
  });

  it("mounts the console next to /mcp, with the wiki named after its folder", async () => {
    const res = await fetch(`${dbBase}/console/`);
    expect(res.status).toBe(200);
    const page = parse(await res.text());
    expect(page.href("demo")).toBe("/console/w/demo");
    expect(page.text).toContain("One database.");
    expect(page.text).toContain(`${dbBase}/mcp`);
    expect(page.kvValue("Log directory")).toContain("stderr");
    expect((await fetch(`${dbBase}/console/w/demo/jobs`)).status).toBe(200);
    expect((await fetch(`${dbBase}/console/w/demo/health`)).status).toBe(200);
    expect((await fetch(`${dbBase}/console/w/alpha`)).status).toBe(404);
    expect((await fetch(`${dbBase}/mcp`)).status).toBe(405);
  });
});
