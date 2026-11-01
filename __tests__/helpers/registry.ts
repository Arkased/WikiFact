import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWikiRegistry, type WikiRegistry } from "../../src/service/registry.js";

/** The base URL the registries of the tests report. */
const BASE = "http://127.0.0.1:7777";

/** A registry on a temp folder, and the means to remove both. */
export interface TmpRegistry {
  dir: string;
  registry: WikiRegistry;
  /** Stops the registry and removes its folders. */
  close(): void;
}

/**
 * Makes a registry on a new temp folder.
 *
 * @param opts - what the registry gets beyond the defaults (no cap, no worker children)
 * @param opts.maxWikis - the most wikis the registry accepts; unset means no cap
 * @param opts.withWorker - gives each wiki a worker child that only stays alive
 * @returns the registry, its folder and `close`
 * @sideEffects makes temp folders; `close` stops the children and removes them
 */
export function makeRegistry(opts: { maxWikis?: number; withWorker?: boolean } = {}): TmpRegistry {
  const dir = mkdtempSync(join(tmpdir(), "wikifact-req-wikis-"));
  const scriptDir = mkdtempSync(join(tmpdir(), "wikifact-req-script-"));
  const script = join(scriptDir, "fake-worker.mjs");
  writeFileSync(script, "setInterval(() => {}, 1000);");
  const registry = createWikiRegistry({
    wikisDir: dir,
    host: "127.0.0.1",
    withWorker: opts.withWorker ?? false,
    maxWikis: opts.maxWikis,
    log: () => undefined,
    baseUrl: () => BASE,
    workerCommand: opts.withWorker ? () => ({ file: process.execPath, args: [script] }) : undefined,
  });
  return {
    dir,
    registry,
    close: () => {
      registry.stop();
    },
  };
}
