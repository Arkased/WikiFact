import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accepted, draft, factIdOf, write } from "../../../__tests__/helpers/store.js";
import { parseConfig } from "../../config/index.js";
import { LogEvent, SessionEndReason } from "../../domain/enums.js";
import type { LogLine } from "../../log/index.js";
import { closeStore, openStoreFor, toolCallStats, type Store } from "../../store/index.js";
import { singleRoute, startHttpServer, type HttpHandle } from "../http.js";
import { SESSION_IDLE_MS, SESSION_SWEEP_MS, McpSessions, stdioSession } from "../sessions.js";

const T0 = 1_700_000_000_000;

interface SessionRow {
  id: string;
  client_name: string | null;
  client_version: string | null;
  call_count: number;
  last_call_at: number;
  ended_at: number | null;
}

let dir: string;
let store: Store;
let handle: HttpHandle;
let clock: number;
let sessions: McpSessions;
let logs: LogLine[];
const clients: Client[] = [];

const rows = (): SessionRow[] =>
  store.db.prepare("SELECT * FROM sessions ORDER BY started_at, id").all() as SessionRow[];
const url = (): string => `http://127.0.0.1:${handle.port}/mcp`;

async function connect(name = "claude-code", version = "2.0"): Promise<{ client: Client; id: string }> {
  const transport = new StreamableHTTPClientTransport(new URL(url()));
  const client = new Client({ name, version });
  await client.connect(transport);
  clients.push(client);
  const id = transport.sessionId;
  if (id === undefined) throw new Error("the server sent no session id");
  return { client, id };
}

// A raw JSON-RPC post, for the requests that the client library would never send.
function post(body: object, session?: string): Promise<Response> {
  return fetch(url(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(session === undefined ? {} : { "Mcp-Session-Id": session }),
    },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "wikifact-sessions-"));
  const config = parseConfig({ embeddingModel: "test-model" });
  const dbPath = join(dir, "wiki.sqlite");
  store = openStoreFor(config, dbPath);
  clock = T0;
  logs = [];
  const log = (l: LogLine): void => void logs.push(l);
  sessions = new McpSessions({ store, wiki: "w", log, now: () => clock });
  const deps = { dbPath, config, writeStore: store, log };
  handle = await startHttpServer(singleRoute(deps, sessions), { host: "127.0.0.1", port: 0, log });
});
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => undefined);
  await sessions.close();
  await new Promise((r) => handle.server.close(r));
  closeStore(store);
});

describe('MCP sessions over HTTP (technical/deployment.md, "MCP sessions")', () => {
  it("opens a sessions row at initialize with the client name and version, and counts each tool call", async () => {
    const { client, id } = await connect("claude-code", "2.0");
    expect(rows()).toMatchObject([{ id, client_name: "claude-code", client_version: "2.0", call_count: 0 }]);
    clock = T0 + 5;
    await client.callTool({ name: "search", arguments: { query: "creeper" } });
    await client.callTool({ name: "search", arguments: { query: "" } });
    expect(rows()).toMatchObject([{ id, call_count: 2, last_call_at: T0 + 5, ended_at: null }]);
    expect(logs).toContainEqual(
      expect.objectContaining({ event: LogEvent.SessionStart, sessionId: id, clientName: "claude-code" }),
    );
  });

  it("gives each client its own session", async () => {
    const a = await connect("a");
    const b = await connect("b");
    expect(a.id).not.toBe(b.id);
    await a.client.callTool({ name: "search", arguments: { query: "x" } });
    expect(rows().map((r) => [r.client_name, r.call_count])).toEqual([
      ["a", 1],
      ["b", 0],
    ]);
  });

  it("writes the session id into the search row, and links nothing by the session", async () => {
    write(store, accepted([draft()]), T0);
    const factId = factIdOf(store);
    const { client, id } = await connect();
    await client.callTool({ name: "search", arguments: { query: "creeper damage" } });
    await client.callTool({ name: "getFact", arguments: { id: factId } });
    const search = store.db.prepare("SELECT session_id, query, result_count FROM searches").all();
    expect(search).toEqual([{ session_id: id, query: "creeper damage", result_count: 1 }]);
    const ranks = store.db.prepare("SELECT kind, target_id, rank FROM search_results").all();
    expect(ranks).toEqual([{ kind: "fact", target_id: factId, rank: 1 }]);
    // A read by id is unlinked, though its session searched the fact.
    expect(store.db.prepare("SELECT ref FROM retrievals").all()).toEqual([{ ref: null }]);
  });

  it("writes the session id into the change request row of requestChange", async () => {
    const { client, id } = await connect();
    await client.callTool({ name: "requestChange", arguments: { change: "A claim.", justification: "I read it." } });
    expect(store.db.prepare("SELECT session_id FROM change_requests").all()).toEqual([{ session_id: id }]);
  });

  it("counts every call in the stored tool calls of the endpoint; a rejection is an answer, not a failed call", async () => {
    const { client } = await connect();
    await client.callTool({ name: "search", arguments: { query: "creeper" } });
    const rejected = await client.callTool({ name: "getFact", arguments: { id: "nope" } });
    expect(rejected.isError).toBe(true);
    expect(toolCallStats(store, Date.now()).lastHour).toMatchObject({ calls: 2, failed: 0 });
    expect(store.db.prepare("SELECT tool, ok FROM tool_calls ORDER BY rowid").all()).toEqual([
      { tool: "search", ok: 1 },
      { tool: "getFact", ok: 1 },
    ]);
  });

  it("answers 404 to an unknown session id and 400 to a request with no session id that is not initialize", async () => {
    expect((await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "unknown-session")).status).toBe(404);
    expect((await post({ jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(400);
  });

  it("ends the session on a DELETE: ended_at is set, the id is gone, and session_end is logged", async () => {
    const { client, id } = await connect();
    await client.callTool({ name: "search", arguments: { query: "creeper" } });
    clock = T0 + 10;
    const res = await fetch(url(), { method: "DELETE", headers: { "Mcp-Session-Id": id } });
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(rows()[0]?.ended_at).toBe(T0 + 10));
    expect((await post({ jsonrpc: "2.0", id: 2, method: "tools/list" }, id)).status).toBe(404);
    expect(logs).toContainEqual(
      expect.objectContaining({ event: LogEvent.SessionEnd, sessionId: id, calls: 1, reason: SessionEndReason.Delete }),
    );
  });

  it("ends an idle session at the time of its last call, and keeps a session that is not idle", async () => {
    const idle = await connect("idle");
    const live = await connect("live");
    await idle.client.callTool({ name: "search", arguments: { query: "x" } });
    const lastCall = clock;
    clock = lastCall + SESSION_IDLE_MS - 1;
    await live.client.callTool({ name: "search", arguments: { query: "y" } });
    await sessions.sweep();
    expect(rows().map((r) => r.ended_at)).toEqual([null, null]);
    clock = lastCall + SESSION_IDLE_MS;
    await sessions.sweep();
    expect(rows().map((r) => [r.client_name, r.ended_at])).toEqual([
      ["idle", lastCall],
      ["live", null],
    ]);
    expect((await post({ jsonrpc: "2.0", id: 3, method: "tools/list" }, idle.id)).status).toBe(404);
    expect(logs).toContainEqual(
      expect.objectContaining({ event: LogEvent.SessionEnd, sessionId: idle.id, reason: SessionEndReason.Idle }),
    );
  });

  it("ends every session with the reason shutdown when the set closes", async () => {
    const { id } = await connect();
    clock = T0 + 20;
    await sessions.close();
    expect(rows()).toMatchObject([{ id, ended_at: T0 + 20 }]);
    expect(logs).toContainEqual(
      expect.objectContaining({ event: LogEvent.SessionEnd, reason: SessionEndReason.Shutdown }),
    );
  });
});

describe("the idle timer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const stubParts = (): { transport: StreamableHTTPServerTransport; server: McpServer } => ({
    transport: { close: () => Promise.resolve() } as unknown as StreamableHTTPServerTransport,
    server: { close: () => Promise.resolve() } as unknown as McpServer,
  });

  it("checks once a minute and ends the sessions that are idle then", async () => {
    vi.useFakeTimers();
    let now = T0;
    const set = new McpSessions({ log: () => undefined, now: () => now });
    const handle1 = set.create();
    set.register(handle1.id, stubParts(), {});
    now = T0 + SESSION_IDLE_MS;
    expect(set.transport(handle1.id)).toBeDefined();
    await vi.advanceTimersByTimeAsync(SESSION_SWEEP_MS);
    expect(set.transport(handle1.id)).toBeUndefined();
    await set.close();
  });

  it("keeps sessions of an endpoint with no store in memory", () => {
    const set = new McpSessions({ log: () => undefined });
    const h = set.create();
    set.register(h.id, stubParts(), {});
    expect(() => h.touch()).not.toThrow();
    return set.close();
  });
});

describe("a stdio session", () => {
  it("is one row with a ULID id, counts calls and ends at the process end", () => {
    const config = parseConfig({ embeddingModel: "test-model" });
    const s = openStoreFor(config, join(dir, "stdio.sqlite"));
    let now = T0;
    const session = stdioSession({ store: s, log: () => undefined, now: () => now });
    session.handle.touch();
    now = T0 + 7;
    session.end();
    session.end();
    const row = s.db.prepare("SELECT * FROM sessions").get() as SessionRow;
    expect(row).toMatchObject({ id: session.handle.id, call_count: 1, ended_at: T0 + 7 });
    expect(row.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    closeStore(s);
  });
});
