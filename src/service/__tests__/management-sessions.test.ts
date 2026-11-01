import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { accepted, draft, write } from "../../../__tests__/helpers/store.js";
import { Span } from "../../domain/enums.js";
import { startHttpServer, type HttpHandle } from "../../mcp/http.js";
import { readsPerSearch, spanBounds, type Store } from "../../store/index.js";
import { createWikiRegistry, type WikiRegistry } from "../registry.js";
import { serviceRoute } from "../routes.js";

interface SessionRow {
  id: string;
  call_count: number;
  ended_at: number | null;
}

let dir: string;
let registry: WikiRegistry;
let handle: HttpHandle;
const clients: Client[] = [];

const storeOf = (wiki: string): Store => {
  const entry = registry.get(wiki);
  if (entry === undefined) throw new Error(`no wiki ${wiki}`);
  return entry.store;
};
const sessionRows = (wiki: string): SessionRow[] =>
  storeOf(wiki).db.prepare("SELECT id, call_count, ended_at FROM sessions ORDER BY id").all() as SessionRow[];

async function connect(): Promise<{ client: Client; id: string }> {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${handle.port}/mcp`));
  const client = new Client({ name: "claude-code", version: "2.0" });
  await client.connect(transport);
  clients.push(client);
  if (transport.sessionId === undefined) throw new Error("the server sent no session id");
  return { client, id: transport.sessionId };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "wikifact-mgmt-sessions-"));
  const log = (): void => undefined;
  registry = createWikiRegistry({
    wikisDir: dir,
    host: "127.0.0.1",
    withWorker: false,
    log,
    baseUrl: () => "http://127.0.0.1:7777",
  });
  registry.addWiki("alpha", "The first wiki.");
  registry.addWiki("beta", "The second wiki.");
  handle = await startHttpServer(serviceRoute(registry, log), { host: "127.0.0.1", port: 0, log });
});
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => undefined);
  await new Promise((r) => handle.server.close(r));
  registry.stop();
});

describe('Sessions through the management endpoint (technical/deployment.md, "MCP sessions")', () => {
  it("writes the session row in every wiki at connect, and a session with no tool call has a row in each", async () => {
    const { id } = await connect();
    expect(sessionRows("alpha")).toMatchObject([{ id, call_count: 0, ended_at: null }]);
    expect(sessionRows("beta")).toMatchObject([{ id, call_count: 0, ended_at: null }]);
  });

  it("gives a wiki mounted after the session opened no row, and its calls link to no session", async () => {
    const { client, id } = await connect();
    registry.addWiki("gamma", "The third wiki.");
    await client.callTool({ name: "search", arguments: { wiki: "gamma", query: "x" } });
    expect(sessionRows("gamma")).toEqual([]);
    expect(storeOf("gamma").db.prepare("SELECT session_id FROM searches").all()).toEqual([{ session_id: null }]);
    expect(sessionRows("alpha")).toMatchObject([{ id, call_count: 0 }]);
  });

  it("links the search row and the read row to the session row that the connect wrote, and counts each call", async () => {
    write(storeOf("alpha"), accepted([draft()]), 1_700_000_000_000);
    const { client, id } = await connect();
    expect(sessionRows("alpha")).toMatchObject([{ id, call_count: 0 }]);
    const found = await client.callTool({ name: "search", arguments: { wiki: "alpha", query: "creeper damage" } });
    const ref = (found.structuredContent as { results: { ref: string }[] }).results[0]?.ref ?? "";
    expect(sessionRows("alpha")).toMatchObject([{ id, call_count: 1, ended_at: null }]);
    expect(storeOf("alpha").db.prepare("SELECT session_id FROM searches").all()).toEqual([{ session_id: id }]);
    await client.callTool({ name: "getFact", arguments: { wiki: "alpha", ref } });
    expect(sessionRows("alpha")).toMatchObject([{ id, call_count: 2 }]);
    const reads = readsPerSearch(storeOf("alpha"), spanBounds(storeOf("alpha"), Span.All, 1));
    expect(reads.counts[1]).toBe(1);
    expect(reads.unlinkedReads).toBe(0);
    expect(sessionRows("beta")).toMatchObject([{ id, call_count: 0 }]);
  });

  it("uses the same id in every wiki and ends the rows in all of them on a DELETE, with no tool call", async () => {
    const { id } = await connect();
    expect(sessionRows("alpha")).toMatchObject([{ id, ended_at: null }]);
    expect(sessionRows("beta")).toMatchObject([{ id, ended_at: null }]);
    const res = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
      method: "DELETE",
      headers: { "Mcp-Session-Id": id },
    });
    expect(res.status).toBe(200);
    expect(sessionRows("alpha")[0]?.ended_at).not.toBeNull();
    expect(sessionRows("beta")[0]?.ended_at).not.toBeNull();
  });

  it("ends the row of an archived wiki only in that wiki", async () => {
    write(storeOf("beta"), accepted([draft()]), 1_700_000_000_000);
    const { client } = await connect();
    await client.callTool({ name: "search", arguments: { wiki: "alpha", query: "x" } });
    await client.callTool({ name: "search", arguments: { wiki: "beta", query: "y" } });
    await registry.archiveWiki("alpha");
    expect(sessionRows("beta")[0]?.ended_at).toBeNull();
  });
});
