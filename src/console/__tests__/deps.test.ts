import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig } from "../../config/index.js";
import { ConsoleErrorKind, Mode, ServeTarget } from "../../domain/enums.js";
import { WIKI_CONFIG_FILE, WIKI_DB_FILE } from "../../paths.js";
import { closeStore, openStoreFor, type Store } from "../../store/index.js";
import { singleWikiDeps } from "../deps.js";

let dir: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wikifact-deps-"));
});
afterEach(() => {
  closeStore(store);
});

describe("singleWikiDeps", () => {
  it("names the wiki after its folder, builds the URL from the live base and fills the service row", () => {
    const folder = join(dir, "demo");
    mkdirSync(folder);
    const raw = { mode: Mode.Local, subject: "The demo." };
    writeFileSync(join(folder, WIKI_CONFIG_FILE), JSON.stringify(raw));
    const config = parseConfig(raw);
    const dbPath = join(folder, WIKI_DB_FILE);
    store = openStoreFor(config, dbPath);
    let base = "http://127.0.0.1:0";
    const deps = singleWikiDeps({
      deps: { dbPath, config, writeStore: store },
      worker: () => undefined,
      baseUrl: () => base,
      log: () => undefined,
    });
    base = "http://127.0.0.1:4321";
    const wiki = deps.getWiki("demo");
    expect(wiki).toMatchObject({ name: "demo", dbPath, subject: "The demo.", url: `${base}/mcp` });
    expect(wiki).not.toHaveProperty("childRunning");
    expect(deps.listWikis().map((w) => w.name)).toEqual(["demo"]);
    expect(deps.getWiki("other")).toBeUndefined();
    expect(deps.service()).toMatchObject({
      host: "127.0.0.1",
      port: 4321,
      mode: Mode.Local,
      target: ServeTarget.Db,
      path: dbPath,
      archives: [],
    });
    expect(deps.service()).not.toHaveProperty("logDir");
    expect(deps.service().version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("refuses the wiki-level writes with a 409 not in service mode", async () => {
    const dbPath = join(dir, WIKI_DB_FILE);
    const config = parseConfig({ mode: Mode.Local, subject: "S" });
    store = openStoreFor(config, dbPath);
    const { writes } = singleWikiDeps({
      deps: { dbPath, config, writeStore: store },
      worker: () => undefined,
      baseUrl: () => "http://127.0.0.1:1",
      log: () => undefined,
    });
    const message = "not in service mode";
    expect(() => writes.addWiki("b", "s")).toThrow(message);
    expect(() => writes.setDescription("b", "d")).toThrow(message);
    await expect(writes.archiveWiki("b")).rejects.toThrow(message);
    await expect(writes.unarchiveWiki("b")).rejects.toThrow(message);
    await expect(writes.updateConfig("b", {})).rejects.toThrow(message);
    await expect(writes.renameWiki("b", "c")).rejects.toMatchObject({ kind: ConsoleErrorKind.Refused });
  });
});
