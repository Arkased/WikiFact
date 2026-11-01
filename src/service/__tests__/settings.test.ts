import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Mode } from "../../domain/enums.js";
import { WIKI_CONFIG_FILE } from "../../paths.js";
import { createWikiRegistry, discoverWikis, type WikiRegistry } from "../registry.js";

let dir: string;
let registry: WikiRegistry;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wikifact-settings-"));
});
afterEach(() => {
  registry.stop();
});

describe("registry.settings and entries", () => {
  it("reports the folder, the host, the log directory, the live base URL and the mode of an empty folder", () => {
    let base = "http://127.0.0.1:0";
    registry = createWikiRegistry({
      wikisDir: dir,
      host: "127.0.0.1",
      withWorker: false,
      logDir: join(dir, ".logs"),
      log: () => undefined,
      baseUrl: () => base,
    });
    const s = registry.settings();
    expect(s).toMatchObject({ wikisDir: resolve(dir), host: "127.0.0.1", logDir: join(dir, ".logs") });
    expect(s.mode()).toBe(Mode.Local);
    base = "http://127.0.0.1:7777";
    expect(s.baseUrl()).toBe(base);
    expect(registry.entries()).toEqual([]);
  });

  it("takes the mode of the first wiki, lists the entries sorted and has no logDir key without one", () => {
    for (const name of ["beta", "alpha"]) {
      mkdirSync(join(dir, name));
      writeFileSync(join(dir, name, WIKI_CONFIG_FILE), JSON.stringify({ mode: Mode.Deployed, subject: name }));
    }
    registry = createWikiRegistry({
      wikisDir: dir,
      host: "0.0.0.0",
      withWorker: false,
      log: () => undefined,
      baseUrl: () => "http://0.0.0.0:1",
    });
    for (const w of discoverWikis(dir)) registry.mount(w);
    expect(registry.settings().mode()).toBe(Mode.Deployed);
    expect(registry.settings()).not.toHaveProperty("logDir");
    expect(registry.entries().map((e) => e.name)).toEqual(["alpha", "beta"]);
  });
});
