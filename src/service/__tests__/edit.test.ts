import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Mode, Quality } from "../../domain/enums.js";
import { WIKI_CONFIG_FILE, WIKI_DB_FILE } from "../../paths.js";
import { enqueueRequest, finishRequest, takeNextRequest } from "../../store/index.js";
import { createWikiEditor } from "../edit.js";
import { serviceRoute } from "../routes.js";
import { WikiError, createWikiRegistry, discoverWikis, type WikiRegistry } from "../registry.js";

const BASE = "http://127.0.0.1:7777";

let dir: string;
let scriptDir: string;
let registry: WikiRegistry;

// A worker child that only stays alive.
function fakeWorker(): (db: string) => { file: string; args: string[] } {
  const script = join(scriptDir, "fake-worker.mjs");
  writeFileSync(script, "setInterval(() => {}, 1000);");
  return () => ({ file: process.execPath, args: [script] });
}

function newRegistry(withWorker = false): WikiRegistry {
  return createWikiRegistry({
    wikisDir: dir,
    host: "127.0.0.1",
    withWorker,
    log: () => undefined,
    baseUrl: () => BASE,
    workerCommand: withWorker ? fakeWorker() : undefined,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wikifact-edit-"));
  scriptDir = mkdtempSync(join(tmpdir(), "wikifact-edit-script-"));
  registry = newRegistry();
});
afterEach(() => {
  registry.stop();
});

const fileOf = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(dir, name, WIKI_CONFIG_FILE), "utf8")) as Record<string, unknown>;

function must<T>(x: T | undefined | null): T {
  if (x === undefined || x === null) throw new Error("expected a value");
  return x;
}

describe("setDescription", () => {
  it("writes the key, rereads it into the config and shows it in listWikis, without a restart", () => {
    registry.addWiki("alpha", "A subject.");
    registry.setDescription("alpha", "  A longer text for the operator.  ");
    expect(fileOf("alpha").description).toBe("A longer text for the operator.");
    expect(fileOf("alpha").subject).toBe("A subject.");
    expect(discoverWikis(dir)[0]?.config.description).toBe("A longer text for the operator.");
    expect(registry.get("alpha")?.config.description).toBe("A longer text for the operator.");
    expect(registry.listWikis()[0]?.description).toBe("A longer text for the operator.");
  });

  it("removes the key for an empty text, so listWikis has none", () => {
    registry.addWiki("alpha", "A subject.");
    registry.setDescription("alpha", "text");
    registry.setDescription("alpha", "  ");
    expect("description" in fileOf("alpha")).toBe(false);
    expect(registry.listWikis()[0]).not.toHaveProperty("description");
  });

  it("refuses an unknown wiki", () => {
    expect(() => registry.setDescription("nope", "x")).toThrow(WikiError);
  });
});

describe("readRawConfig", () => {
  it("returns the keys of the file with no preset and no default merged in", () => {
    registry.addWiki("alpha", "A subject.");
    expect(registry.readRawConfig("alpha")).toEqual({ mode: Mode.Local, subject: "A subject." });
    expect(registry.get("alpha")?.config.questions).not.toEqual({});
  });

  it("refuses an unknown wiki", () => {
    expect(() => registry.readRawConfig("nope")).toThrow(WikiError);
  });
});

describe("updateConfig", () => {
  it("writes the keys to wikifact.json, keeps the others and updates the mounted config", async () => {
    registry.addWiki("alpha", "A subject.", Quality.Budget);
    const res = await registry.updateConfig("alpha", {
      subject: "New subject.",
      searchCap: 4,
      weights: { wRead: 0.5 },
    });
    expect(res.changed).toEqual(["subject", "searchCap", "weights"]);
    expect(res.restarted).toBe(false);
    expect(fileOf("alpha")).toEqual({
      mode: Mode.Local,
      subject: "New subject.",
      quality: Quality.Budget,
      searchCap: 4,
      weights: { wRead: 0.5 },
    });
    const reread = must(discoverWikis(dir)[0]).config;
    expect(reread).toMatchObject({ subject: "New subject.", searchCap: 4 });
    expect(reread.weights.wRead).toBe(0.5);
    expect(registry.get("alpha")?.config.searchCap).toBe(4);
    expect(registry.get("alpha")?.deps.config.searchCap).toBe(4);
  });

  it("removes a key whose value is undefined and reports no change for a same value", async () => {
    registry.addWiki("alpha", "A subject.");
    await registry.updateConfig("alpha", { searchCap: 4 });
    const same = await registry.updateConfig("alpha", { searchCap: 4 });
    expect(same.changed).toEqual([]);
    await registry.updateConfig("alpha", { searchCap: undefined });
    expect("searchCap" in fileOf("alpha")).toBe(false);
  });

  it("refuses mode and embeddingModel and writes nothing", async () => {
    registry.addWiki("alpha", "A subject.");
    const before = readFileSync(join(dir, "alpha", WIKI_CONFIG_FILE), "utf8");
    await expect(registry.updateConfig("alpha", { mode: Mode.Deployed })).rejects.toThrow(WikiError);
    await expect(registry.updateConfig("alpha", { embeddingModel: "other" })).rejects.toThrow(/reindex/);
    await expect(registry.updateConfig("alpha", { subject: "x", mode: Mode.Deployed })).rejects.toThrow(WikiError);
    await expect(registry.updateConfig("alpha", { colour: "red" })).rejects.toThrow(/not a key/);
    expect(readFileSync(join(dir, "alpha", WIKI_CONFIG_FILE), "utf8")).toBe(before);
  });

  it("refuses a value that would make wikifact.json invalid and writes nothing", async () => {
    registry.addWiki("alpha", "A subject.");
    const before = readFileSync(join(dir, "alpha", WIKI_CONFIG_FILE), "utf8");
    await expect(registry.updateConfig("alpha", { searchCap: -3 })).rejects.toThrow(/invalid.*searchCap/);
    await expect(registry.updateConfig("alpha", { quality: "gold" })).rejects.toThrow(WikiError);
    expect(readFileSync(join(dir, "alpha", WIKI_CONFIG_FILE), "utf8")).toBe(before);
  });

  it("refuses an unknown wiki", async () => {
    await expect(registry.updateConfig("nope", { searchCap: 4 })).rejects.toThrow(WikiError);
  });
});

describe("the restart of the worker by updateConfig", () => {
  it("replaces the child after the running request is done", async () => {
    registry.stop();
    registry = newRegistry(true);
    registry.addWiki("alpha", "A subject.");
    const entry = must(registry.get("alpha"));
    const first = must(entry.worker);
    const store = entry.store;
    enqueueRequest(store, { change: "c", justification: "j" });
    const running = must(takeNextRequest(store));
    let finished = false;
    setTimeout(() => {
      finishRequest(store, running.id);
      finished = true;
    }, 300);
    await registry.updateConfig("alpha", { subject: "Another." });
    expect(finished).toBe(true);
    const second = must(registry.get("alpha")?.worker);
    expect(second).not.toBe(first);
    expect(second.child.pid).not.toBe(first.child.pid);
    await first.exited;
    expect(first.child.exitCode !== null || first.child.signalCode !== null).toBe(true);
    expect(second.child.exitCode).toBeNull();
  });

  it("restarts the child when updateConfig changes a key, and leaves it when nothing changed", async () => {
    registry.stop();
    registry = newRegistry(true);
    registry.addWiki("alpha", "A subject.");
    const first = must(registry.get("alpha")?.worker);
    const same = await registry.updateConfig("alpha", { subject: "A subject." });
    expect(same.restarted).toBe(false);
    expect(registry.get("alpha")?.worker).toBe(first);
    const changed = await registry.updateConfig("alpha", { subject: "Another." });
    expect(changed.restarted).toBe(true);
    expect(registry.get("alpha")?.worker).not.toBe(first);
  });
});

describe("renameWiki", () => {
  it("moves the folder, mounts the new name with its data and makes the old name 404", async () => {
    registry.addWiki("alpha", "A subject.");
    registry.setDescription("alpha", "Kept across the rename.");
    const entry = must(registry.get("alpha"));
    enqueueRequest(entry.store, { change: "c", justification: "j" });
    const route = serviceRoute(registry, () => undefined);
    expect(route("/wikis/alpha/mcp")).toBeDefined();

    const renamed = await registry.renameWiki("alpha", "beta");
    expect(renamed).toEqual({ from: "alpha", name: "beta", url: `${BASE}/wikis/beta/mcp` });
    expect(existsSync(join(dir, "alpha"))).toBe(false);
    expect(existsSync(join(dir, "beta", WIKI_DB_FILE))).toBe(true);
    expect(registry.get("alpha")).toBeUndefined();
    expect(registry.entries().map((e) => e.name)).toEqual(["beta"]);
    expect(route("/wikis/alpha/mcp")).toBeUndefined();
    expect(route("/wikis/beta/mcp")).toBeDefined();
    const listed = registry.listWikis();
    expect(listed).toMatchObject([{ name: "beta", queued: 1, description: "Kept across the rename." }]);
    expect(discoverWikis(dir).map((w) => w.name)).toEqual(["beta"]);
  });

  it("stops the worker child and starts a new one under the new name", async () => {
    registry.stop();
    registry = newRegistry(true);
    registry.addWiki("alpha", "A subject.");
    const first = must(registry.get("alpha")?.worker);
    await registry.renameWiki("alpha", "beta");
    await first.exited;
    const second = must(registry.get("beta")?.worker);
    expect(second.child.pid).not.toBe(first.child.pid);
    expect(second.child.exitCode).toBeNull();
  });

  it("moves the folder back, mounts the old name again and rethrows when the new name does not mount", async () => {
    registry.addWiki("alpha", "A subject.");
    registry.setDescription("alpha", "Survives the failed rename.");
    let failures = 1;
    const editor = createWikiEditor({
      wikisDir: dir,
      entries: new Map(registry.entries().map((e) => [e.name, e])),
      managementSessions: registry.managementSessions,
      mount: (wiki) => {
        if (wiki.name === "beta" && failures-- > 0) throw new Error("cannot open beta");
        return registry.mount(wiki);
      },
      startChild: () => {
        throw new Error("no worker child in this test");
      },
      urlOf: (name) => `${BASE}/wikis/${name}/mcp`,
    });
    await expect(editor.renameWiki("alpha", "beta")).rejects.toThrow("cannot open beta");
    expect(existsSync(join(dir, "alpha", WIKI_DB_FILE))).toBe(true);
    expect(existsSync(join(dir, "beta"))).toBe(false);
    expect(registry.get("alpha")?.config.description).toBe("Survives the failed rename.");
    expect(registry.get("beta")).toBeUndefined();
    expect(discoverWikis(dir).map((w) => w.name)).toEqual(["alpha"]);
  });

  it("refuses a bad name, the same name, an existing wiki, a twin and an existing folder", async () => {
    registry.addWiki("alpha", "A.");
    registry.addWiki("beta", "B.");
    mkdirSync(join(dir, "taken"));
    await expect(registry.renameWiki("alpha", "Bad_Name")).rejects.toThrow(/not a valid name/);
    await expect(registry.renameWiki("alpha", "alpha")).rejects.toThrow(/already named/);
    await expect(registry.renameWiki("alpha", "beta")).rejects.toThrow(/exists/);
    await expect(registry.renameWiki("alpha", "betas")).rejects.toThrow(/too close/);
    await expect(registry.renameWiki("alpha", "taken")).rejects.toThrow(/already exists/);
    await expect(registry.renameWiki("nope", "gamma")).rejects.toThrow(WikiError);
    expect(registry.entries().map((e) => e.name)).toEqual(["alpha", "beta"]);
    expect(existsSync(join(dir, "alpha", WIKI_DB_FILE))).toBe(true);
  });
});
