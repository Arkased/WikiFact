// The requirement tests of docs/requirements/wikis.md: one test for each row, named by the Name cell.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, expect, it, vi } from "vitest";
import { registryDeps } from "../../src/console/deps.js";
import { RequestStatus } from "../../src/domain/enums.js";
import { parse } from "../../src/console/__tests__/helpers/dom.js";
import { post, serveConsole } from "../../src/console/__tests__/helpers/serve.js";
import { EMPTY_NOTE } from "../../src/mcp/instructions.js";
import { createManagementServer } from "../../src/mcp/management.js";
import { WIKI_CONFIG_FILE } from "../../src/paths.js";
import { discoverWikis } from "../../src/service/registry.js";
import { enqueueRequest, writeWorkerStatus, type Store } from "../../src/store/index.js";
import { startMcp } from "../helpers/mcp.js";
import { makeRegistry, type TmpRegistry } from "../helpers/registry.js";
import { T0, accepted, draft, factIdOf, write } from "../helpers/store.js";
import { count } from "../helpers/updates.js";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/**
 * Makes a registry that the test closes at its end.
 *
 * @param opts - the options
 * @param opts.maxWikis - the cap on the wikis
 * @param opts.withWorker - gives each wiki a worker child that only stays alive
 * @returns the registry with its folder
 * @sideEffects makes temp folders; registers a cleanup that stops the registry and removes them
 */
function registryOf(opts: { maxWikis?: number; withWorker?: boolean } = {}): TmpRegistry {
  const r = makeRegistry(opts);
  cleanups.push(() => r.close());
  return r;
}

/**
 * Connects an MCP client to the management server of the registry, which is the one connection of the service.
 *
 * @param r - the registry
 * @returns the connected client
 * @sideEffects registers a cleanup that closes the client
 */
async function connect(r: TmpRegistry): Promise<Client> {
  const server = createManagementServer(r.registry, () => undefined);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  cleanups.push(() => client.close());
  return client;
}

/**
 * Gives the store of a mounted wiki.
 *
 * @param r - the registry
 * @param name - the wiki name
 * @returns the store
 * @throws {Error} when the wiki is not mounted
 * @sideEffects none
 */
function storeOf(r: TmpRegistry, name: string): Store {
  const entry = r.registry.get(name);
  if (!entry) throw new Error(`${name} is not mounted`);
  return entry.store;
}

/**
 * Adds a wiki with one live fact.
 *
 * @param r - the registry
 * @param name - the wiki name
 * @sideEffects creates the wiki and writes a fact
 */
function seedFact(r: TmpRegistry, name: string): void {
  r.registry.addWiki(name, `The ${name} wiki.`);
  write(storeOf(r, name), accepted([draft({ header: "Kept fact" })]), T0);
}

it("One connection", async () => {
  const r = registryOf();
  r.registry.addWiki("alpha", "A.");
  r.registry.addWiki("beta", "B.");
  write(storeOf(r, "alpha"), accepted([draft({ header: "Creeper damage" })]), T0);
  const client = await connect(r);
  const hit = await client.callTool({ name: "search", arguments: { wiki: "alpha", query: "creeper damage" } });
  expect(hit.isError).toBeFalsy();
  expect(JSON.stringify(hit.structuredContent)).toContain("Creeper damage");
  const other = await client.callTool({ name: "search", arguments: { wiki: "beta", query: "creeper damage" } });
  expect(other.structuredContent).toEqual({ searchId: expect.any(String) as unknown, results: [], note: EMPTY_NOTE });

  const queued = await client.callTool({
    name: "requestChange",
    arguments: { wiki: "beta", change: "c", justification: "j" },
  });
  const requestId = (queued.structuredContent as { requestId: string }).requestId;
  expect(r.registry.listWikis().find((w) => w.name === "beta")?.queued).toBe(1);
  const state = await client.callTool({ name: "getRequest", arguments: { wiki: "beta", requestId } });
  expect(state.structuredContent).toMatchObject({ requestId, status: RequestStatus.Queued });
  // The id belongs to beta, so alpha does not know it.
  expect((await client.callTool({ name: "getRequest", arguments: { wiki: "alpha", requestId } })).isError).toBe(true);

  const missing = await client.callTool({ name: "search", arguments: { wiki: "nope", query: "x" } });
  expect(missing.isError).toBe(true);
  expect(JSON.stringify(missing.content)).toContain("nope");
});

it("Subject only", async () => {
  const r = registryOf();
  const client = await connect(r);
  const { tools } = await client.listTools();
  const create = tools.find((t) => t.name === "createWiki");
  expect([...(create?.inputSchema.required ?? [])].sort()).toEqual(["name", "subject"]);
  const made = await client.callTool({
    name: "createWiki",
    arguments: { name: "minecraft", subject: "A block game." },
  });
  expect(made.isError).toBeFalsy();
  expect(made.structuredContent).toMatchObject({ name: "minecraft", created: true });
  expect(r.registry.listWikis().map((w) => [w.name, w.subject])).toEqual([["minecraft", "A block game."]]);
  expect(existsSync(join(r.dir, "minecraft", WIKI_CONFIG_FILE))).toBe(true);
  expect(count(storeOf(r, "minecraft"), "facts")).toBe(0);

  expect(() => r.registry.addWiki("One", "S.")).toThrow();
  expect(() => r.registry.addWiki("two", "   ")).toThrow();
  expect(existsSync(join(r.dir, "two"))).toBe(false);
  expect(r.registry.listWikis().map((w) => w.name)).toEqual(["minecraft"]);
});

it("Wiki cap", () => {
  const r = registryOf({ maxWikis: 2 });
  r.registry.addWiki("one", "1.");
  r.registry.addWiki("two", "2.");
  expect(() => r.registry.addWiki("three", "3.")).toThrow(/human raises the cap/);
  expect(r.registry.addWiki("two", "2.").created).toBe(false);
  expect(existsSync(join(r.dir, "three"))).toBe(false);
});

it("No loss", async () => {
  const r = registryOf();
  seedFact(r, "minecraft");
  const moved = await r.registry.archiveWiki("minecraft");
  expect(moved.archivedTo).toBeDefined();
  expect(existsSync(join(r.dir, "minecraft"))).toBe(false);
  expect(r.registry.get("minecraft")).toBeUndefined();
  expect(discoverWikis(r.dir)).toEqual([]);

  r.registry.addWiki("queued", "Q.");
  enqueueRequest(storeOf(r, "queued"), { change: "c", justification: "j" }, T0);
  expect((await r.registry.archiveWiki("queued")).archivedTo).toBeDefined();

  // Deleted facts are content: a wiki whose facts are all deleted is moved, not removed.
  seedFact(r, "deleted");
  const deletedStore = storeOf(r, "deleted");
  write(
    deletedStore,
    accepted([draft({ factId: factIdOf(deletedStore), header: "", content: "", isDeleted: true })]),
    T0 + 1000,
  );
  deletedStore.db.prepare("UPDATE change_requests SET status = ?").run(RequestStatus.Done);
  expect(r.registry.listWikis().find((w) => w.name === "deleted")).toMatchObject({ liveFacts: 0, queued: 0 });
  expect((await r.registry.archiveWiki("deleted")).archivedTo).toBeDefined();
  // A wiki with no fact at all and no request is removed.
  r.registry.addWiki("blank", "B.");
  expect(await r.registry.archiveWiki("blank")).toEqual({ name: "blank", removed: true });

  // An agent undoes its own archive, and the facts are still there.
  await r.registry.unarchiveWiki("minecraft");
  expect(r.registry.listWikis().find((w) => w.name === "minecraft")).toMatchObject({ liveFacts: 1 });
  expect(r.registry.listArchived().map((a) => a.name)).toEqual(["deleted", "queued"]);
  await r.registry.unarchiveWiki("queued");
  expect(r.registry.listWikis().find((w) => w.name === "queued")).toMatchObject({ queued: 1 });
});

it("Worker warning", async () => {
  const r = registryOf();
  r.registry.addWiki("quiet", "Quiet.");
  expect(r.registry.listWikis()[0]?.worker).toMatchObject({ running: false });
  // The registry reads the clock to judge the last poll, so the clock is fixed here.
  vi.useFakeTimers({ toFake: ["Date"], now: T0 });
  try {
    writeWorkerStatus(storeOf(r, "quiet"), {
      pid: 1,
      startedAt: T0 - 10_000,
      lastPollAt: T0 - 1000,
      consecutiveFailures: 0,
    });
    expect(r.registry.listWikis()[0]?.worker).toMatchObject({ running: true });
  } finally {
    vi.useRealTimers();
  }

  // With no worker status, requestChange still queues and warns.
  const w = await startMcp();
  cleanups.push(() => w.close());
  const sent = await w.call<{ warning?: string }>("requestChange", { change: "c", justification: "j" });
  expect(sent.isError).toBeFalsy();
  expect(sent.structuredContent.warning).toBeTruthy();
  expect(w.count("change_requests")).toBe(1);
});

it("Direct settings", async () => {
  const r = registryOf({ withWorker: true });
  r.registry.addWiki("alpha", "A subject.");
  r.registry.setDescription("alpha", "What the operator says.");
  await r.registry.renameWiki("alpha", "beta");
  expect(r.registry.listWikis()).toMatchObject([{ name: "beta", description: "What the operator says." }]);

  // A setting changed in the console reaches the file, and restarts the worker that reads it at start.
  const server = await serveConsole(registryDeps(r.registry, () => undefined));
  cleanups.push(() => server.close());
  const before = r.registry.get("beta")?.worker;
  expect(before).toBeDefined();
  const page = parse(await (await fetch(`${server.base}/console/w/beta/settings`)).text());
  const fields: Record<string, string> = { confirm: "1" };
  for (const f of page.formTo("/console/w/beta/settings/config")?.fields ?? [])
    if (f.type === "text") fields[f.name] = f.value;
  const done = await post(server.base, "/console/w/beta/settings/config", { ...fields, subject: "New subject." });
  expect(done.status).toBe(303);
  const file = JSON.parse(readFileSync(join(r.dir, "beta", WIKI_CONFIG_FILE), "utf8")) as { subject: string };
  expect(file.subject).toBe("New subject.");
  expect(r.registry.get("beta")?.worker).not.toBe(before);

  // None of the edits went through the queue.
  expect(count(storeOf(r, "beta"), "change_requests")).toBe(0);
});
