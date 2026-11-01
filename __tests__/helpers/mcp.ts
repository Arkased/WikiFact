import { afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { parseConfig } from "../../src/config/index.js";
import { createManagementServer } from "../../src/mcp/management.js";
import { createServer } from "../../src/mcp/server.js";
import { createWikiRegistry } from "../../src/service/registry.js";
import {
  applyChange,
  closeStore,
  enqueueRequest,
  openStoreFor,
  type ChangeSet,
  type Store,
} from "../../src/store/index.js";
import { count } from "./updates.js";

/** The raw result of an MCP tool call. */
interface ToolResult<T> {
  isError?: boolean;
  structuredContent: T;
  content: { type: string; text: string }[];
}

/** A single-wiki MCP server on an in-memory transport, with a client and the store behind it. */
export interface McpWorld {
  store: Store;
  client: Client;
  /** Calls a tool and returns the raw result with its structured content. */
  call<T = Record<string, unknown>>(name: string, args: Record<string, unknown>): Promise<ToolResult<T>>;
  /** Applies a change set under a fresh queued request, through the async path that fills the vector tables. */
  write(cs: ChangeSet): ReturnType<typeof applyChange>;
  /** Counts the rows of a table. */
  count(table: string, where?: string): number;
  /** Closes the client and the store and removes the folder. */
  close(): Promise<void>;
}

/**
 * Starts the MCP server of one wiki over an in-memory transport.
 *
 * @param subject - the subject of the wiki; default: none
 * @returns the client, the store, and helpers to call tools, write facts and count rows
 * @sideEffects makes a temp folder with a database; `close` removes it
 */
export async function startMcp(subject?: string): Promise<McpWorld> {
  const dir = mkdtempSync(join(tmpdir(), "wikifact-req-mcp-"));
  const dbPath = join(dir, "wiki.sqlite");
  const config = parseConfig({ embeddingModel: "test-model", ...(subject === undefined ? {} : { subject }) });
  const store = openStoreFor(config, dbPath);
  const server = createServer({ dbPath, config, writeStore: store, log: () => undefined });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return {
    store,
    client,
    call: async <T>(name: string, args: Record<string, unknown>) =>
      (await client.callTool({ name, arguments: args })) as ToolResult<T>,
    write: (cs) => applyChange(store, enqueueRequest(store, { change: "c", justification: "j" }), cs),
    count: (table, where) => count(store, table, where),
    close: async () => {
      await client.close();
      closeStore(store);
    },
  };
}

/**
 * Makes the starter of MCP worlds that close after each test. Call it once at the top of a test file.
 *
 * @returns a function that starts a world, as `startMcp` does
 * @sideEffects registers an `afterEach` hook that closes every world the starter made
 */
export function mcpPerTest(): (subject?: string) => Promise<McpWorld> {
  const worlds: McpWorld[] = [];
  afterEach(async () => {
    for (const w of worlds.splice(0)) await w.close();
  });
  return async (subject) => {
    const w = await startMcp(subject);
    worlds.push(w);
    return w;
  };
}

/** A management endpoint on an in-memory transport, over a registry of wikis made in a temp folder. */
export interface ManagementWorld {
  /** Connects a new client, as a consumer does; the server is built for that connection. */
  connect(): Promise<Client>;
  /** Closes the clients, stops the registry and removes the folder. */
  close(): Promise<void>;
}

/**
 * Starts the management endpoint over a registry of the given wikis.
 *
 * @param wikis - the name and subject of each wiki to mount
 * @returns the world; `close` ends it
 * @sideEffects makes a temp folder with a database for each wiki; `close` removes it
 */
export function startManagement(wikis: Record<string, string>): ManagementWorld {
  const dir = mkdtempSync(join(tmpdir(), "wikifact-req-mgmt-"));
  const registry = createWikiRegistry({
    wikisDir: dir,
    host: "127.0.0.1",
    withWorker: false,
    log: () => undefined,
    baseUrl: () => "http://127.0.0.1:7777",
  });
  for (const [name, subject] of Object.entries(wikis)) registry.addWiki(name, subject);
  const clients: Client[] = [];
  return {
    connect: async () => {
      const server = createManagementServer(registry, () => undefined);
      const [a, b] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "test", version: "0" });
      await Promise.all([server.connect(a), client.connect(b)]);
      clients.push(client);
      return client;
    },
    close: async () => {
      for (const c of clients.splice(0)) await c.close();
      registry.stop();
    },
  };
}
