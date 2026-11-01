// A wiki on disk for the page tests: a store the test seeds through the Store API, and the `ConsoleDeps` a page
// handler reads, built by hand. The page opens its own read-only connection on the same file (technical/console.md, "Architecture").
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../../../config/index.js";
import { Mode, ServeTarget } from "../../../domain/enums.js";
import { WIKI_DB_FILE } from "../../../paths.js";
import { closeStore, openStoreFor, type Store } from "../../../store/index.js";
import { T0 } from "../../../../__tests__/helpers/store.js";
import { FAKE_PRICES } from "../../../../__tests__/helpers/prices.js";
import type { Logger } from "../../../log/index.js";
import { noWikiWrites, type ConsoleDeps, type ConsoleWiki, type ConsoleWrites } from "../../deps.js";
import type { PageContext } from "../../page.js";

/** The options of `openTmpWiki`. */
export interface TmpWikiOptions {
  /** The `childRunning` of the wiki; absent for a service without a worker child. */
  childRunning?: boolean;
  /** False for a service that logs to stderr: the service row has no `logDir`. Default true. */
  withLogDir?: boolean;
  /** The mode of the service row. Default local. */
  mode?: Mode;
  /** The bound host of the service row. Default the loopback. */
  host?: string;
  /** The restarts of the worker child by the service; absent for a worker the service does not supervise. */
  workerRestarts?: number;
  /** The wiki-level writes. Default `noWikiWrites`. */
  writes?: ConsoleWrites;
  /** The target of the service row. Default a wikis folder. */
  target?: ServeTarget;
  /** Receives the lines the deps log. Default none. */
  log?: Logger;
}

/** A wiki on disk with the deps of a page test. */
export interface TmpWiki {
  dir: string;
  /** The log directory of the service row; exists and is empty at the start. */
  logDir: string;
  /** The write connection for the seed. */
  store: Store;
  wiki: ConsoleWiki;
  deps: ConsoleDeps;
  /** Builds a page context for this wiki, with `w` set. */
  ctx(params?: Record<string, string>, query?: string): PageContext;
  /** Closes the store and removes the folder. */
  close(): void;
}

/**
 * Creates a wiki in a temp folder.
 *
 * @param name - the wiki name
 * @param opts - the child state and whether the service has a log directory
 * @returns the wiki, its store and deps
 */
export function openTmpWiki(name = "alpha", opts: TmpWikiOptions = {}): TmpWiki {
  const dir = mkdtempSync(join(tmpdir(), "wikifact-c4-"));
  const logDir = join(dir, "logs");
  mkdirSync(logDir);
  const config = parseConfig({ mode: Mode.Local, subject: "The test wiki." });
  const dbPath = join(dir, WIKI_DB_FILE);
  const store = openStoreFor(config, dbPath);
  const wiki: ConsoleWiki = {
    name,
    config,
    dbPath,
    url: `http://127.0.0.1:1/wikis/${name}/mcp`,
    subject: config.subject,
    ...(opts.childRunning === undefined ? {} : { childRunning: opts.childRunning }),
    ...(opts.workerRestarts === undefined ? {} : { workerRestarts: opts.workerRestarts }),
  };
  const withLogDir = opts.withLogDir ?? true;
  const deps: ConsoleDeps = {
    listWikis: () => [wiki],
    getWiki: (n) => (n === name ? wiki : undefined),
    service: () => ({
      version: "0.0.0-test",
      startedAt: T0,
      host: opts.host ?? "127.0.0.1",
      port: 1,
      mode: opts.mode ?? Mode.Local,
      target: opts.target ?? ServeTarget.Wikis,
      path: dir,
      ...(withLogDir ? { logDir } : {}),
      archives: [],
    }),
    writes: opts.writes ?? noWikiWrites(),
    prices: FAKE_PRICES,
    log: opts.log ?? (() => undefined),
  };
  return {
    dir,
    logDir,
    store,
    wiki,
    deps,
    ctx: (params = {}, query = "") => ({ deps, params: { w: name, ...params }, query: new URLSearchParams(query) }),
    close: () => {
      closeStore(store);
    },
  };
}
