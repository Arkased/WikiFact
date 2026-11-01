import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpToolName } from "../../domain/enums.js";
import { registryInstructions } from "../../mcp/management.js";
import { startHttpServer, type HttpHandle } from "../../mcp/http.js";
import { toolCallStats } from "../../store/index.js";
import type { LogLine } from "../../log/index.js";
import { createWikiRegistry, type WikiRegistry } from "../registry.js";
import { serviceRoute } from "../routes.js";

const NOW = 1_800_000_000_000;

let dir: string;
let registry: WikiRegistry;
let handle: HttpHandle;
const logs: LogLine[] = [];
const clients: Client[] = [];

const base = (): string => `http://127.0.0.1:${handle.port}`;

// The calls and the failed calls that the Service health page would show for a wiki, summed over the 24 buckets and the tools.
function counted(wiki: string, tool: McpToolName): { calls: number; failed: number } {
  const entry = registry.get(wiki);
  if (entry === undefined) throw new Error(`no wiki ${wiki}`);
  const total = { calls: 0, failed: 0 };
  for (const bucket of toolCallStats(entry.store, NOW).buckets) {
    total.calls += bucket.byTool[tool].calls;
    total.failed += bucket.byTool[tool].failed;
  }
  return total;
}

async function connect(): Promise<Client> {
  const client = new Client({ name: "claude-code", version: "2.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base()}/mcp`)));
  clients.push(client);
  return client;
}

beforeEach(async () => {
  // Only the Date is fake, so the sockets and the timers of the HTTP server run as usual.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  dir = mkdtempSync(join(tmpdir(), "wikifact-mgmt-endpoint-"));
  const log = (line: LogLine): void => void logs.push(line);
  registry = createWikiRegistry({
    wikisDir: dir,
    host: "127.0.0.1",
    withWorker: false,
    log,
    baseUrl: () => "http://127.0.0.1:7777",
  });
  registry.addWiki("x", "The x wiki.");
  registry.addWiki("y", "The y wiki.");
  handle = await startHttpServer(serviceRoute(registry, log), { host: "127.0.0.1", port: 0, log });
  logs.length = 0;
});
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => undefined);
  await new Promise((r) => handle.server.close(r));
  registry.stop();
  vi.useRealTimers();
});

describe('Endpoint counters through the management endpoint (technical/deployment.md, "Endpoint counters")', () => {
  it("counts a search in the stats of the wiki it names, and no other", async () => {
    const client = await connect();
    await client.callTool({ name: "search", arguments: { wiki: "x", query: "creeper damage" } });
    expect(counted("x", McpToolName.Search)).toEqual({ calls: 1, failed: 0 });
    expect(counted("y", McpToolName.Search)).toEqual({ calls: 0, failed: 0 });
  });

  it("counts a rejection as a call that is not failed", async () => {
    const client = await connect();
    const res = await client.callTool({ name: "search", arguments: { wiki: "x", query: "   " } });
    expect(res.isError).toBe(true);
    expect(counted("x", McpToolName.Search)).toEqual({ calls: 1, failed: 0 });
  });

  it("counts nothing for a management tool or for an unknown wiki", async () => {
    const client = await connect();
    await client.callTool({ name: "listWikis", arguments: {} });
    await client.callTool({ name: "createWiki", arguments: { name: "z", subject: "Z." } });
    await client.callTool({ name: "search", arguments: { wiki: "nope", query: "a" } });
    for (const wiki of ["x", "y", "z"]) {
      for (const tool of [McpToolName.ListWikis, McpToolName.CreateWiki, McpToolName.Search]) {
        expect(counted(wiki, tool)).toEqual({ calls: 0, failed: 0 });
      }
    }
  });
});

describe('Endpoint counters in the store (technical/deployment.md, "Endpoint counters")', () => {
  const stored = (wiki: string): unknown[] => {
    const entry = registry.get(wiki);
    if (entry === undefined) throw new Error(`no wiki ${wiki}`);
    return entry.store.db.prepare("SELECT at, tool, ok FROM tool_calls ORDER BY rowid").all();
  };

  it("writes 1 row in the wiki a call names, a rejection included, and none in another wiki", async () => {
    const client = await connect();
    await client.callTool({ name: "search", arguments: { wiki: "x", query: "creeper damage" } });
    await client.callTool({ name: "search", arguments: { wiki: "x", query: "   " } });
    expect(stored("x")).toEqual([
      { at: NOW, tool: "search", ok: 1 },
      { at: NOW, tool: "search", ok: 1 },
    ]);
    expect(stored("y")).toEqual([]);
  });

  it("writes no row for a management tool or an unknown wiki", async () => {
    const client = await connect();
    await client.callTool({ name: "listWikis", arguments: {} });
    await client.callTool({ name: "search", arguments: { wiki: "nope", query: "a" } });
    expect(stored("x")).toEqual([]);
    expect(stored("y")).toEqual([]);
  });
});

describe('tool metadata (technical/lookup.md, "MCP tool contracts")', () => {
  it("marks search, getFact and requestChange as always loaded on the management endpoint, and no other tool", async () => {
    const { tools } = await (await connect()).listTools();
    const marked = tools.filter((t) => t._meta?.["anthropic/alwaysLoad"] === true).map((t) => t.name);
    expect(marked.sort()).toEqual(["getFact", "requestChange", "search"]);
  });

  it("sends the management instructions on connect", async () => {
    expect((await connect()).getInstructions()).toBe(registryInstructions(registry));
  });
});
