import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CallFailureKind, McpToolName, Mode, Quality, RequestStatus, WorkerChildState } from "../../domain/enums.js";
import { createManagementServer } from "../../mcp/management.js";
import { WIKI_CONFIG_FILE, WIKI_DB_FILE } from "../../paths.js";
import {
  TOOL_CALL_RETENTION_MS,
  enqueueRequest,
  openSession,
  recordToolCall,
  toolCallStats,
  touchSession,
  writeWorkerStatus,
  type WorkerStatus,
} from "../../store/index.js";
import { accepted, draft, factIdOf, write } from "../../../__tests__/helpers/store.js";
import {
  WIKI_NAME_PATTERN,
  WikiError,
  TOOL_CALL_PRUNE_MS,
  createWikiRegistry,
  discoverWikis,
  serviceMode,
  wikiUrl,
  workerInfo,
  type WikiEntry,
  type WikiRegistry,
} from "../registry.js";

const BASE = "http://127.0.0.1:7777";

let dir: string;
let registry: WikiRegistry;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wikifact-registry-"));
  registry = newRegistry();
});
afterEach(() => {
  registry.stop();
});

function newRegistry(host = "127.0.0.1"): WikiRegistry {
  return createWikiRegistry({ wikisDir: dir, host, withWorker: false, log: () => undefined, baseUrl: () => BASE });
}

// The mode that createWiki wrote into the wikifact.json of a wiki.
function writtenMode(name: string): unknown {
  return (JSON.parse(readFileSync(join(dir, name, WIKI_CONFIG_FILE), "utf8")) as { mode: unknown }).mode;
}

// Writes a wiki folder with a wikifact.json the way createWiki does.
function seedFolder(name: string, config: object): void {
  mkdirSync(join(dir, name));
  writeFileSync(join(dir, name, WIKI_CONFIG_FILE), JSON.stringify(config));
}

describe("WIKI_NAME_PATTERN", () => {
  it("takes 1 to 40 lower-case letters, digits and hyphens", () => {
    for (const ok of ["a", "demo", "my-wiki-2", "0", "-", "a".repeat(40)])
      expect(WIKI_NAME_PATTERN.test(ok)).toBe(true);
    for (const bad of ["", "Demo", "my_wiki", "a b", "a/b", "..", "a.b", "é", "a".repeat(41), "a\n"]) {
      expect(WIKI_NAME_PATTERN.test(bad)).toBe(false);
    }
  });
});

describe("addWiki", () => {
  it("creates the folder, wikifact.json and the tables, and returns the URL", () => {
    const made = registry.addWiki("minecraft", "A block game.", Quality.Budget);
    expect(made).toEqual({ name: "minecraft", url: `${BASE}/wikis/minecraft/mcp`, created: true });
    expect(made.url).toBe(wikiUrl(BASE, "minecraft"));
    const folder = join(dir, "minecraft");
    expect(JSON.parse(readFileSync(join(folder, WIKI_CONFIG_FILE), "utf8"))).toEqual({
      mode: Mode.Local,
      subject: "A block game.",
      quality: Quality.Budget,
    });
    expect(existsSync(join(folder, WIKI_DB_FILE))).toBe(true);
    const entry = registry.get("minecraft");
    const tables = entry?.store.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('facts', 'change_requests', 'meta')")
      .all();
    expect(tables).toHaveLength(3);
  });

  it("leaves quality out of wikifact.json when none is given", () => {
    registry.addWiki("plain", "A subject.");
    expect(JSON.parse(readFileSync(join(dir, "plain", WIKI_CONFIG_FILE), "utf8"))).toEqual({
      mode: Mode.Local,
      subject: "A subject.",
    });
  });

  it("refuses a bad name, an empty subject and a folder that exists", () => {
    registry.addWiki("one", "S.");
    expect(() => registry.addWiki("One", "S.")).toThrow(/not a valid name/);
    expect(() => registry.addWiki("two", "   ")).toThrow(/subject/);
    mkdirSync(join(dir, "taken"));
    expect(() => registry.addWiki("taken", "S.")).toThrow(/already exists/);
    expect(registry.listWikis().map((w) => w.name)).toEqual(["one"]);
    expect(existsSync(join(dir, "two"))).toBe(false);
  });

  it("is idempotent on the same name and subject", () => {
    const first = registry.addWiki("repeat", "Same subject.");
    const again = registry.addWiki("repeat", "Same subject.");
    expect(first.created).toBe(true);
    expect(again).toEqual({ name: "repeat", url: first.url, created: false });
    expect(registry.listWikis()).toHaveLength(1);
  });

  it("refuses the same name with another subject and names the existing subject", () => {
    registry.addWiki("repeat", "Original subject.");
    expect(() => registry.addWiki("repeat", "Other subject.")).toThrow(/Original subject\./);
    expect(() => registry.addWiki("repeat", "Other subject.")).toThrow(WikiError);
  });

  it("refuses a near-twin name and names the existing wiki", () => {
    registry.addWiki("creepers", "Creepers.");
    registry.addWiki("game-mechanics", "Mechanics.");
    expect(() => registry.addWiki("creeper", "C.")).toThrow(/"creepers"/);
    expect(() => registry.addWiki("gamemechanics", "G.")).toThrow(/"game-mechanics"/);
    expect(registry.addWiki("creepy", "Creepy things.").created).toBe(true);
    expect(existsSync(join(dir, "creeper"))).toBe(false);
  });

  it("takes the mode of the first existing wiki", () => {
    seedFolder("zeta", { mode: Mode.Deployed, subject: "Z." });
    const r = newRegistry();
    for (const w of discoverWikis(dir)) r.mount(w);
    r.addWiki("alpha", "A.");
    expect(writtenMode("alpha")).toBe(Mode.Deployed);
    r.stop();
  });

  it("writes a deployed wiki into an empty folder when the host is not the loopback", () => {
    const r = newRegistry("0.0.0.0");
    r.addWiki("open", "O.");
    expect(writtenMode("open")).toBe(Mode.Deployed);
    r.stop();
  });
});

describe("serviceMode", () => {
  it("copies the first mode, else local on the loopback and deployed elsewhere", () => {
    expect(serviceMode(Mode.Deployed, "127.0.0.1")).toBe(Mode.Deployed);
    expect(serviceMode(undefined, "localhost")).toBe(Mode.Local);
    expect(serviceMode(undefined, "0.0.0.0")).toBe(Mode.Deployed);
  });
});

describe("discoverWikis", () => {
  it("finds the subfolders with a wikifact.json, sorted, and skips the rest", () => {
    seedFolder("b", { subject: "B." });
    seedFolder("a", { subject: "A." });
    mkdirSync(join(dir, "empty"));
    writeFileSync(join(dir, "file.txt"), "x");
    const found = discoverWikis(dir);
    expect(found.map((w) => w.name)).toEqual(["a", "b"]);
    expect(found[0]?.config.subject).toBe("A.");
    expect(found[0]?.dbPath).toBe(join(dir, "a", WIKI_DB_FILE));
  });

  it("throws for a missing folder and for a folder with an invalid name", () => {
    expect(() => discoverWikis(join(dir, "nope"))).toThrow(WikiError);
    seedFolder("Bad_Name", {});
    expect(() => discoverWikis(dir)).toThrow(/not a valid wiki name/);
  });
});

describe("listWikis", () => {
  it("returns name, subject, url, live facts and queued, sorted by name", () => {
    registry.addWiki("beta", "Second.");
    registry.addWiki("alpha", "First.");
    const alpha = registry.get("alpha")?.store;
    if (!alpha) throw new Error("alpha is not mounted");
    const now = 1_700_000_000_000;
    const gone = write(alpha, accepted([draft({ header: "Gone" })]), now);
    write(alpha, accepted([draft({ header: "Kept", content: "Kept content." })]), now + 1);
    const id = gone.factIds[0];
    if (id === undefined) throw new Error("no fact id");
    enqueueRequest(alpha, { change: "c", justification: "j" }, now + 2);
    write(alpha, accepted([draft({ factId: id, header: "Gone", isDeleted: true, justification: "Gone." })]), now + 3);
    enqueueRequest(alpha, { change: "later", justification: "j" }, now + 4);
    const list = registry.listWikis();
    expect(list.map((w) => w.name)).toEqual(["alpha", "beta"]);
    // 3 writes and 2 explicit enqueues: the test helper leaves the row of each write queued.
    expect(list[0]).toEqual({
      name: "alpha",
      subject: "First.",
      url: `${BASE}/wikis/alpha/mcp`,
      liveFacts: 1,
      queued: 5,
      worker: { running: false },
    });
    expect(list[1]).toMatchObject({ name: "beta", liveFacts: 0, queued: 0 });
  });
});

describe("worker field", () => {
  const POLL_AGO_MS = 5000;
  const STALE_AGO_MS = 120_000;
  const status = (lastPollAt: number, lastCall?: WorkerStatus["lastCall"]): WorkerStatus => ({
    pid: 1,
    startedAt: lastPollAt - 1000,
    lastPollAt,
    consecutiveFailures: 0,
    ...(lastCall === undefined ? {} : { lastCall }),
  });
  const entryOf = (name: string): WikiEntry => {
    const entry = registry.get(name);
    if (!entry) throw new Error(`${name} is not mounted`);
    return entry;
  };

  it("without a child, is running when the status polled within 60 seconds, and carries the last call", () => {
    registry.addWiki("polled", "Polled.");
    const call = { ok: false as const, kind: CallFailureKind.Credential, message: "401", at: Date.now() };
    writeWorkerStatus(entryOf("polled").store, status(Date.now() - POLL_AGO_MS, call));
    expect(registry.listWikis()[0]?.worker).toEqual({ running: true, lastCall: call });
    writeWorkerStatus(entryOf("polled").store, status(Date.now() - STALE_AGO_MS, { ok: true, at: 1 }));
    expect(registry.listWikis()[0]?.worker).toEqual({ running: false, lastCall: { ok: true, at: 1 } });
  });

  it("with a child, is running while the child lives and not once it has exited", async () => {
    registry.addWiki("child", "Child.");
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const entry: WikiEntry = {
      ...entryOf("child"),
      worker: { child, started: Promise.resolve(WorkerChildState.Running), exited, stop: () => child.kill() },
    };
    // A fresh poll in the status must not count: the child decides.
    expect(workerInfo(entry, Date.now())).toEqual({ running: true });
    child.kill();
    await exited;
    expect(workerInfo(entry, Date.now())).toEqual({ running: false });
  });
});

describe("sessions and counters of a mounted wiki", () => {
  it("deletes the tool call rows older than the retention once a day", () => {
    const T = 1_800_000_000_000;
    vi.useFakeTimers();
    try {
      vi.setSystemTime(T);
      const reg = newRegistry();
      try {
        reg.addWiki("beta", "Beta.");
        const beta = reg.get("beta");
        if (!beta) throw new Error("beta is not mounted");
        recordToolCall(beta.store, {
          at: T - TOOL_CALL_RETENTION_MS + 1000,
          tool: McpToolName.Search,
          ok: true,
          durationMs: 1,
        });
        const count = (): unknown => beta.store.db.prepare("SELECT COUNT(*) AS n FROM tool_calls").get();
        vi.advanceTimersByTime(TOOL_CALL_PRUNE_MS - 1);
        // 1 ms short of a day: the row is older than the retention now, but the sweep has not run.
        expect(count()).toEqual({ n: 1 });
        vi.advanceTimersByTime(1);
        expect(count()).toEqual({ n: 0 });
      } finally {
        reg.stop();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends the sessions that a stopped service left open, at their last call, when it mounts the wiki", () => {
    const first = newRegistry();
    first.addWiki("alpha", "Alpha.");
    const open = first.get("alpha");
    if (!open) throw new Error("alpha is not mounted");
    const OPENED = 1_000;
    const LAST_CALL = 2_000;
    openSession(open.store, { id: "left-open", startedAt: OPENED });
    touchSession(open.store, "left-open", LAST_CALL);
    first.stop();

    const second = newRegistry();
    try {
      const [found] = discoverWikis(dir);
      if (!found) throw new Error("no wiki found");
      const entry = second.mount(found);
      const row = entry.store.db.prepare("SELECT ended_at FROM sessions WHERE id = 'left-open'").get();
      expect(row).toEqual({ ended_at: LAST_CALL });
      expect(entry.workerRestarts).toBe(0);
      expect(toolCallStats(entry.store, Date.now()).lastHour).toMatchObject({ calls: 0, failed: 0 });
    } finally {
      second.stop();
    }
  });
});

describe("management tools", () => {
  async function connect(): Promise<Client> {
    const server = createManagementServer(registry, () => undefined);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    return client;
  }

  it("sends instructions with the wikis mounted at each connection", async () => {
    registry.addWiki("first", "First things.");
    const before = (await connect()).getInstructions() ?? "";
    expect(before).toContain("first");
    expect(before).toContain("First things.");
    expect(before).not.toContain("Second things.");
    registry.addWiki("second", "Second things.");
    const after = (await connect()).getInstructions() ?? "";
    for (const s of ["first", "First things.", "second", "Second things."]) expect(after).toContain(s);
  });

  it("lists the 4 tools with their annotations, creates a wiki, and answers a clash with a tool error", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "archiveWiki",
      "createWiki",
      "getFact",
      "getRequest",
      "listWikis",
      "requestChange",
      "search",
      "unarchiveWiki",
    ]);
    const hints = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    expect(hints.createWiki).toMatchObject({ idempotentHint: true, destructiveHint: false, openWorldHint: false });
    expect(hints.archiveWiki).toMatchObject({ destructiveHint: true, idempotentHint: true });
    expect(hints.unarchiveWiki).toMatchObject({ destructiveHint: false, idempotentHint: true });
    expect(hints.listWikis).toMatchObject({ readOnlyHint: true });
    const first = await client.callTool({ name: "createWiki", arguments: { name: "fresh", subject: "Fresh." } });
    expect(first.isError).toBeFalsy();
    expect(first.structuredContent).toEqual({ name: "fresh", url: `${BASE}/wikis/fresh/mcp`, created: true });
    const again = await client.callTool({ name: "createWiki", arguments: { name: "fresh", subject: "Fresh." } });
    expect(again.structuredContent).toMatchObject({ created: false });
    const clash = await client.callTool({ name: "createWiki", arguments: { name: "fresh", subject: "Other." } });
    expect(clash.isError).toBe(true);
    const bad = await client.callTool({ name: "createWiki", arguments: { name: "Bad Name", subject: "S." } });
    expect(bad.isError).toBe(true);
    const listed = await client.callTool({ name: "listWikis", arguments: {} });
    expect(listed.structuredContent).toEqual({
      wikis: [
        {
          name: "fresh",
          subject: "Fresh.",
          url: `${BASE}/wikis/fresh/mcp`,
          liveFacts: 0,
          queued: 0,
          worker: { running: false },
        },
      ],
      archived: [],
    });
    const gone = await client.callTool({ name: "archiveWiki", arguments: { name: "fresh" } });
    expect(gone.structuredContent).toEqual({ name: "fresh", removed: true });
    const unknown = await client.callTool({ name: "archiveWiki", arguments: { name: "fresh" } });
    expect(unknown.isError).toBe(true);
    await client.close();
  });

  it("gives the 4 wiki tools a required wiki argument and the descriptions say where its value comes from", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    for (const name of ["search", "getFact", "requestChange", "getRequest"]) {
      const tool = tools.find((t) => t.name === name);
      expect(tool?.inputSchema.required).toContain("wiki");
      expect(tool?.description).toContain("`wiki` is the name of a wiki from `listWikis`");
    }
    for (const name of ["createWiki", "archiveWiki", "unarchiveWiki", "listWikis"]) {
      expect(tools.find((t) => t.name === name)?.inputSchema.properties).not.toHaveProperty("wiki");
    }
    const hints = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    expect(hints.search).toMatchObject({ readOnlyHint: true });
    expect(hints.getFact).toMatchObject({ readOnlyHint: true });
    expect(hints.getRequest).toMatchObject({ readOnlyHint: true });
    expect(hints.requestChange).toMatchObject({ destructiveHint: false, idempotentHint: false });
    await client.close();
  });
});

// A wiki with one live fact, ready to archive.
function seedFact(name: string): void {
  registry.addWiki(name, `The ${name} wiki.`);
  const store = registry.get(name)?.store;
  if (!store) throw new Error("not mounted");
  write(store, accepted([draft({ header: "Kept fact" })]), 1_700_000_000_000);
}

describe("archiveWiki", () => {
  it("removes an empty wiki", async () => {
    registry.addWiki("empty", "E.");
    expect(await registry.archiveWiki("empty")).toEqual({ name: "empty", removed: true });
    expect(existsSync(join(dir, "empty"))).toBe(false);
    expect(registry.get("empty")).toBeUndefined();
    expect(registry.listWikis()).toEqual([]);
    expect(registry.listArchived()).toEqual([]);
  });

  it("moves a wiki with a fact to .archive/, intact, and never mounts it again", async () => {
    seedFact("minecraft");
    const done = await registry.archiveWiki("minecraft");
    expect(done.removed).toBeUndefined();
    expect(done.archivedTo).toMatch(/^\.archive\/minecraft-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z$/);
    const moved = join(dir, done.archivedTo ?? "");
    expect(existsSync(join(moved, WIKI_CONFIG_FILE))).toBe(true);
    expect(statSync(join(moved, WIKI_DB_FILE)).size).toBeGreaterThan(0);
    expect(existsSync(join(dir, "minecraft"))).toBe(false);
    expect(registry.get("minecraft")).toBeUndefined();
    expect(discoverWikis(dir)).toEqual([]);
    expect(registry.listArchived().map((a) => a.name)).toEqual(["minecraft"]);
  });

  it("moves a wiki whose facts are all deleted, with their history", async () => {
    registry.addWiki("gone", "G.");
    const store = registry.get("gone")?.store;
    if (!store) throw new Error("not mounted");
    write(store, accepted([draft({ header: "Kept fact" })]), 1_700_000_000_000);
    write(
      store,
      accepted([draft({ factId: factIdOf(store), header: "", content: "", isDeleted: true })]),
      1_700_000_001_000,
    );
    store.db.prepare("UPDATE change_requests SET status = ?").run(RequestStatus.Done);
    expect(registry.listWikis()[0]).toMatchObject({ liveFacts: 0, queued: 0 });
    const done = await registry.archiveWiki("gone");
    expect(done.removed).toBeUndefined();
    expect(existsSync(join(dir, done.archivedTo ?? "", WIKI_DB_FILE))).toBe(true);
  });

  it("refuses an unknown name", async () => {
    await expect(registry.archiveWiki("nope")).rejects.toThrow(WikiError);
  });

  it("frees the name and lets discovery skip every dot-folder", async () => {
    mkdirSync(join(dir, ".hidden"));
    writeFileSync(join(dir, ".hidden", WIKI_CONFIG_FILE), JSON.stringify({ subject: "H." }));
    expect(discoverWikis(dir)).toEqual([]);
    registry.addWiki("again", "A.");
    await registry.archiveWiki("again");
    expect(registry.addWiki("again", "A.").created).toBe(true);
  });
});

describe("unarchiveWiki", () => {
  it("restores the newest of several archives, or the one named by its folder", async () => {
    seedFact("minecraft");
    const first = (await registry.archiveWiki("minecraft")).archivedTo ?? "";
    // The archive folder is named by the clock: move a fake Date on, so that the second archive is the newer one.
    vi.useFakeTimers({ toFake: ["Date"] });
    let second: string;
    try {
      vi.setSystemTime(Date.now() + 5000);
      seedFact("minecraft");
      second = (await registry.archiveWiki("minecraft")).archivedTo ?? "";
    } finally {
      vi.useRealTimers();
    }
    const newest = await registry.unarchiveWiki("minecraft");
    expect(newest.restoredFrom).toBe(second.replace(".archive/", ""));
    expect(newest.note).toBeDefined();
    await registry.archiveWiki("minecraft");
    const picked = await registry.unarchiveWiki(first.replace(".archive/", ""));
    expect(picked.restoredFrom).toBe(first.replace(".archive/", ""));
  });

  it("refuses an unknown archive and a live wiki with that name", async () => {
    await expect(registry.unarchiveWiki("nope")).rejects.toThrow(/no archive/);
    seedFact("minecraft");
    await registry.archiveWiki("minecraft");
    registry.addWiki("minecraft", "New.");
    await expect(registry.unarchiveWiki("minecraft")).rejects.toThrow(/exists/);
  });
});
