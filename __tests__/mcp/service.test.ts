// End to end: `serve --wikis <dir> --http 0` as a child process, driven by an MCP client over HTTP.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseConfig } from "../../src/config/index.js";
import { LogEvent, Mode } from "../../src/domain/enums.js";
import { EMPTY_NOTE } from "../../src/mcp/instructions.js";
import { WIKI_CONFIG_FILE, WIKI_DB_FILE } from "../../src/paths.js";
import { closeStore, openStoreFor } from "../../src/store/index.js";
import { accepted, draft, write } from "../helpers/store.js";
import { PROCESS_START_TIMEOUT_MS } from "../helpers/timeouts.js";

const ROOT = resolve(import.meta.dirname, "../..");
/** How long the server gets to print its listening line, in ms. */
/** How often the test looks for the listening line in the log file, in ms. */
const POLL_MS = 100;
/** The cap given to `serve`: the 2 seeded wikis and `gamma`. */
const MAX_WIKIS = 3;
/** The wikis that `beforeAll` seeds before the service starts. */
const SEEDED_WIKIS = 2;

let dir: string;
let child: ChildProcess;
let base: string;
const stderrLines: string[] = [];

// Makes a wiki folder with a local-mode wikifact.json and one fact.
function seedWiki(name: string, subject: string, header: string): void {
  const folder = join(dir, name);
  mkdirSync(folder);
  writeFileSync(join(folder, WIKI_CONFIG_FILE), JSON.stringify({ mode: Mode.Local, subject }));
  const store = openStoreFor(parseConfig({ mode: Mode.Local, subject }), join(folder, WIKI_DB_FILE));
  write(store, accepted([draft({ header, content: `${header} is a fact.` })]), Date.now());
  closeStore(store);
}

// The lines of the service log files (`<dir>/.logs/service.<n>.log`), parsed.
function serviceLogLines(): Record<string, unknown>[] {
  const logs = join(dir, ".logs");
  if (!existsSync(logs)) return [];
  return readdirSync(logs)
    .filter((f) => /^service\.\d+\.log$/.test(f))
    .flatMap((f) => readFileSync(join(logs, f), "utf8").split("\n"))
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

// Waits for the `listening` line in the service log and for the `wikiMounted` line of each seeded wiki, and returns
// the bound port. The port is bound before the wikis are mounted and the model is warm, so the first line alone does
// not mean that the service answers for its wikis. The service writes to files only, so stderr holds the one line
// that names the log directory.
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
      if (hit === undefined || lines.filter((l) => l.event === LogEvent.WikiMounted).length < SEEDED_WIKIS) return;
      clearInterval(poll);
      clearTimeout(timer);
      resolvePort(Number(hit.port));
    }, POLL_MS);
    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on("data", (chunk: string) => stderrLines.push(chunk));
    proc.once("exit", (code) => fail(`serve exited with ${code}`));
  });
}

async function connect(url: string): Promise<Client> {
  const client = new Client({ name: "service-test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "wikifact-service-"));
  seedWiki("beta", "The second wiki.", "Zombie health");
  seedWiki("alpha", "The first wiki.", "Creeper damage");
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
      "--max-wikis",
      String(MAX_WIKIS),
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

describe("serve --wikis", () => {
  it("names the log directory on stderr, once, and writes the rest to service files", () => {
    const lines = stderrLines
      .join("")
      .split("\n")
      .filter((l) => l !== "");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ event: LogEvent.LogDir, dir: join(dir, ".logs") });
  });

  it("names the wikis on the serve line, with a level", () => {
    const serve = serviceLogLines().find((l) => l.event === LogEvent.Serve);
    expect(serve).toMatchObject({
      level: "info",
      wikis: ["alpha", "beta"],
      target: "wikis",
      host: "127.0.0.1",
    });
  });

  it("lists, creates, and serves the new wiki", async () => {
    const mgmt = await connect(`${base}/mcp`);
    expect((await mgmt.listTools()).tools.map((t) => t.name).sort()).toEqual([
      "archiveWiki",
      "createWiki",
      "getFact",
      "getRequest",
      "listWikis",
      "requestChange",
      "search",
      "unarchiveWiki",
    ]);

    const before = await mgmt.callTool({ name: "listWikis", arguments: {} });
    expect(before.structuredContent).toEqual({
      wikis: [
        {
          name: "alpha",
          subject: "The first wiki.",
          url: `${base}/wikis/alpha/mcp`,
          liveFacts: 1,
          queued: 1,
          worker: { running: false },
        },
        {
          name: "beta",
          subject: "The second wiki.",
          url: `${base}/wikis/beta/mcp`,
          liveFacts: 1,
          queued: 1,
          worker: { running: false },
        },
      ],
      archived: [],
    });

    const made = await mgmt.callTool({ name: "createWiki", arguments: { name: "gamma", subject: "The third wiki." } });
    expect(made.isError).toBeFalsy();
    expect(made.structuredContent).toEqual({ name: "gamma", url: `${base}/wikis/gamma/mcp`, created: true });
    expect(existsSync(join(dir, "gamma", WIKI_CONFIG_FILE))).toBe(true);
    expect((await mgmt.callTool({ name: "createWiki", arguments: { name: "gamma", subject: "x" } })).isError).toBe(
      true,
    );
    await mgmt.close();

    const gamma = await connect(`${base}/wikis/gamma/mcp`);
    expect((await gamma.listTools()).tools.map((t) => t.name).sort()).toEqual([
      "getFact",
      "getRequest",
      "requestChange",
      "search",
    ]);
    const empty = await gamma.callTool({ name: "search", arguments: { query: "anything" } });
    expect(empty.isError).toBeFalsy();
    expect(empty.structuredContent).toEqual({ searchId: expect.any(String) as unknown, results: [], note: EMPTY_NOTE });
    await gamma.close();

    const alpha = await connect(`${base}/wikis/alpha/mcp`);
    const hit = await alpha.callTool({ name: "search", arguments: { query: "creeper damage" } });
    expect(JSON.stringify(hit.structuredContent)).toContain("Creeper damage");
    await alpha.close();
  });

  it("guards create, archives, and restores a wiki with its fact", async () => {
    const mgmt = await connect(`${base}/mcp`);
    const text = (r: unknown): string => JSON.stringify(r);
    const again = await mgmt.callTool({ name: "createWiki", arguments: { name: "gamma", subject: "The third wiki." } });
    expect(again.structuredContent).toEqual({ name: "gamma", url: `${base}/wikis/gamma/mcp`, created: false });
    const twin = await mgmt.callTool({ name: "createWiki", arguments: { name: "gammas", subject: "x" } });
    expect(twin.isError).toBe(true);
    expect(text(twin.content)).toContain("gamma");
    const capped = await mgmt.callTool({ name: "createWiki", arguments: { name: "delta", subject: "x" } });
    expect(capped.isError).toBe(true);
    expect(text(capped.content)).toContain("raises the cap");

    const removed = await mgmt.callTool({ name: "archiveWiki", arguments: { name: "gamma" } });
    expect(removed.structuredContent).toEqual({ name: "gamma", removed: true });
    expect(existsSync(join(dir, "gamma"))).toBe(false);
    const listed = await mgmt.callTool({ name: "listWikis", arguments: {} });
    expect(JSON.stringify(listed.structuredContent)).not.toContain("gamma");
    const delta = await mgmt.callTool({ name: "createWiki", arguments: { name: "delta", subject: "x" } });
    expect(delta.isError).toBeFalsy();
    await mgmt.callTool({ name: "archiveWiki", arguments: { name: "delta" } });

    const kept = await mgmt.callTool({ name: "archiveWiki", arguments: { name: "alpha" } });
    expect(kept.structuredContent).toMatchObject({ name: "alpha" });
    expect(text(kept.structuredContent)).toContain(".archive/alpha-");
    expect((await fetch(`${base}/wikis/alpha/mcp`, { method: "POST", body: "{}" })).status).toBe(404);
    const afterArchive = await mgmt.callTool({ name: "listWikis", arguments: {} });
    expect(text(afterArchive.structuredContent)).toContain('"archived":[{"name":"alpha"');

    const back = await mgmt.callTool({ name: "unarchiveWiki", arguments: { name: "alpha" } });
    expect(back.isError).toBeFalsy();
    expect(back.structuredContent).toMatchObject({ name: "alpha", url: `${base}/wikis/alpha/mcp` });
    await mgmt.close();

    const alpha = await connect(`${base}/wikis/alpha/mcp`);
    const hit = await alpha.callTool({ name: "search", arguments: { query: "creeper damage" } });
    expect(JSON.stringify(hit.structuredContent)).toContain("Creeper damage");
    await alpha.close();
  });

  it("serves every wiki through /mcp with the wiki argument", async () => {
    const mgmt = await connect(`${base}/mcp`);
    const made = await mgmt.callTool({
      name: "createWiki",
      arguments: { name: "epsilon", subject: "The fifth wiki." },
    });
    expect(made.isError).toBeFalsy();
    // No worker runs in this test, so the request stays queued.
    const sent = await mgmt.callTool({
      name: "requestChange",
      arguments: { wiki: "epsilon", change: "Creepers do 10 damage.", justification: "I measured it." },
    });
    expect(sent.isError).toBeFalsy();
    const { requestId, status } = sent.structuredContent as { requestId: string; status: string };
    expect(status).toBe("queued");
    const state = await mgmt.callTool({ name: "getRequest", arguments: { wiki: "epsilon", requestId } });
    expect(state.structuredContent).toEqual({ requestId, status: "queued", attempts: 0 });

    const hit = await mgmt.callTool({ name: "search", arguments: { wiki: "alpha", query: "creeper damage" } });
    expect(JSON.stringify(hit.structuredContent)).toContain("Creeper damage");
    expect((await mgmt.callTool({ name: "search", arguments: { wiki: "nope", query: "x" } })).isError).toBe(true);

    const listed = await mgmt.callTool({ name: "listWikis", arguments: {} });
    const wikis = (listed.structuredContent as { wikis: { name: string; queued: number; worker: object }[] }).wikis;
    expect(wikis.find((w) => w.name === "epsilon")).toMatchObject({ queued: 1, worker: { running: false } });
    for (const w of wikis) expect(w.worker).toHaveProperty("running");
    await mgmt.close();
  });

  it("answers 404 for an unknown wiki", async () => {
    const res = await fetch(`${base}/wikis/nope/mcp`, { method: "POST", body: "{}" });
    expect(res.status).toBe(404);
  });
});
