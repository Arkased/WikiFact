// What the console pages read from the process (technical/console.md, "Mount in the service"): the wikis with their configs and the facts of the
// service. Service mode fills it from the registry; `serve --db --http` fills it from its one wiki. Nothing here
// touches a store: a page opens its own read-only connection and reads the counts and the worker status there.
import { loadPrices, type Config, type PriceTable } from "../config/index.js";
import { ConsoleErrorKind, ServeTarget, type Mode } from "../domain/enums.js";
import type { Logger } from "../log/index.js";
import type { ServerDeps } from "../mcp/server.js";
import type { WorkerChild } from "../mcp/worker-child.js";
import { wikiNameOf } from "../mcp/worker-child.js";
import { packageVersion } from "../paths.js";
import type { ArchiveInfo } from "../service/archive.js";
import { wikiUrl, type WikiEntry, type WikiRegistry } from "../service/registry.js";
import { ConsoleError } from "./errors.js";

/** One wiki as the console sees it: what the process knows without a store read. */
export interface ConsoleWiki {
  name: string;
  config: Config;
  /** The absolute path of the database file. */
  dbPath: string;
  /** The MCP URL of the wiki. */
  url: string;
  subject: string;
  /**
   * True when the service holds a live worker child, false when it held one that ended. Absent when the service runs
   * no child (`--with-worker` absent); the page then reads the worker status for the state.
   */
  childRunning?: boolean;
  /**
   * The restarts of the worker child by the service since it started; absent for a worker that the service does not
   * supervise (technical/deployment.md, "Worker restart").
   */
  workerRestarts?: number;
}

/** The service row of technical/console.md, "Wikis" and "Health". */
export interface ServiceFacts {
  /** The version of this package, as the MCP server reports it. */
  version: string;
  /** When the service started, in ms since the epoch. */
  startedAt: number;
  /** The `--host` the service binds. */
  host: string;
  /** The bound port. */
  port: number;
  mode: Mode;
  /** What `serve` serves: one database or a wikis folder. */
  target: ServeTarget;
  /** The database path (`ServeTarget.Db`) or the wikis folder (`ServeTarget.Wikis`). */
  path: string;
  /** The log directory; absent when the process logs to stderr. */
  logDir?: string;
  /** The archived wikis; empty for a single database. */
  archives: ArchiveInfo[];
}

/**
 * The wiki-level writes of technical/console.md, "Operator actions" and "Direct edits of non-request fields", which only the registry of service mode can do: create, archive,
 * restore, describe, edit the config of and rename a wiki, and read the config file as it is for the form. The methods are those of `WikiRegistry`; each throws a `WikiError` for a refusal.
 */
export type ConsoleWrites = Pick<
  WikiRegistry,
  "addWiki" | "archiveWiki" | "unarchiveWiki" | "setDescription" | "readRawConfig" | "updateConfig" | "renameWiki"
>;

const NOT_IN_SERVICE_MODE = "not in service mode: this server serves one database, and the wikis are not managed here";

function notInServiceMode(): ConsoleError {
  return new ConsoleError(ConsoleErrorKind.Refused, NOT_IN_SERVICE_MODE);
}

/**
 * Makes the writes of `serve --db`, which has no registry.
 *
 * @returns writes that all refuse with a 409 `Refused` error "not in service mode"; a promise one rejects
 * @sideEffects none
 */
export function noWikiWrites(): ConsoleWrites {
  return {
    addWiki: () => {
      throw notInServiceMode();
    },
    setDescription: () => {
      throw notInServiceMode();
    },
    archiveWiki: () => Promise.reject(notInServiceMode()),
    unarchiveWiki: () => Promise.reject(notInServiceMode()),
    readRawConfig: () => {
      throw notInServiceMode();
    },
    updateConfig: () => Promise.reject(notInServiceMode()),
    renameWiki: () => Promise.reject(notInServiceMode()),
  };
}

/** What the console handlers need from the process. */
export interface ConsoleDeps {
  /**
   * Lists the wikis the console shows.
   *
   * @returns one row per mounted wiki, sorted by name
   * @sideEffects none
   */
  listWikis(): ConsoleWiki[];
  /**
   * Finds one wiki.
   *
   * @param name - the wiki name from the URL
   * @returns the wiki, or `undefined` for an unknown name
   * @sideEffects none
   */
  getWiki(name: string): ConsoleWiki | undefined;
  /**
   * Reads the service row.
   *
   * @returns the facts of the process at this moment
   * @sideEffects reads the `.archive/` folder in service mode
   */
  service(): ServiceFacts;
  /** The wiki-level writes; those of `noWikiWrites` in `--db` mode. */
  writes: ConsoleWrites;
  /** The price table of the cost signal (`config/prices.json`). */
  prices: PriceTable;
  /** Receives one `LogEvent.ConsolePage` line per request and one `LogEvent.ConsoleAction` line per action. */
  log: Logger;
  /** Resolves when the embedder is warm; the search page waits for it as a `search` tool call does. Absent: no wait. */
  ready?: () => Promise<unknown>;
}

// Splits a base URL into the host and the bound port, so that a port picked at bind time (`--http 0`) is reported.
function addressOf(baseUrl: string): { host: string; port: number } {
  const url = new URL(baseUrl);
  return { host: url.hostname, port: Number(url.port) };
}

// The state of a worker child without a store read: absent when there is no child.
function childRunning(worker: WorkerChild | undefined): { childRunning?: boolean } {
  if (worker === undefined) return {};
  const { child } = worker;
  return { childRunning: child.pid !== undefined && child.exitCode === null && child.signalCode === null };
}

/**
 * Fills the console deps from the registry of service mode.
 *
 * @param registry - the wikis of the service
 * @param log - receives the console lines
 * @returns deps whose wiki list follows the registry, so a wiki that `createWiki` adds later shows at once
 * @sideEffects reads `package.json` once and the clock once, for the service row
 */
export function registryDeps(registry: WikiRegistry, log: Logger): ConsoleDeps {
  const version = packageVersion();
  const prices = loadPrices();
  const startedAt = Date.now();
  const toConsoleWiki = (entry: WikiEntry): ConsoleWiki => ({
    name: entry.name,
    config: entry.config,
    dbPath: entry.dbPath,
    url: wikiUrl(registry.settings().baseUrl(), entry.name),
    subject: entry.config.subject,
    ...childRunning(entry.worker),
    ...(entry.worker === undefined ? {} : { workerRestarts: entry.workerRestarts }),
  });
  return {
    listWikis: () => registry.entries().map(toConsoleWiki),
    getWiki: (name) => {
      const entry = registry.get(name);
      return entry === undefined ? undefined : toConsoleWiki(entry);
    },
    service: () => {
      const settings = registry.settings();
      return {
        version,
        startedAt,
        ...addressOf(settings.baseUrl()),
        mode: settings.mode(),
        target: ServeTarget.Wikis,
        path: settings.wikisDir,
        ...(settings.logDir === undefined ? {} : { logDir: settings.logDir }),
        archives: registry.listArchived(),
      };
    },
    writes: registry,
    prices,
    log,
    // Every entry carries the one warming promise of the service (`ready` of the registry options), so waiting on each
    // entry's hook waits once; an empty registry has nothing to wait for.
    ready: () =>
      Promise.all(registry.entries().flatMap((entry) => (entry.deps.ready === undefined ? [] : [entry.deps.ready()]))),
  };
}

/** What `singleWikiDeps` needs from `serve --db --http`. */
export interface SingleWikiOptions {
  /** The deps of the one MCP endpoint: the database path and the config are read from it. */
  deps: ServerDeps;
  /** The worker child of `--with-worker`, read at each call because it starts after the bind. */
  worker: () => WorkerChild | undefined;
  /** The base URL of the server, `http://<host>:<port>`, read at each call so that the bound port counts. */
  baseUrl: () => string;
  /** The log directory of the process; absent means stderr. */
  logDir?: string;
  /** Receives the console lines. */
  log: Logger;
}

/**
 * Fills the console deps for one database (`serve --db <file> --http PORT`). The wiki is named after its folder, as
 * the worker log files are.
 *
 * @param opts - the MCP deps, the worker child, the base URL and the logger
 * @returns deps with one wiki and no archive
 * @sideEffects reads `package.json` once and the clock once, for the service row
 */
export function singleWikiDeps(opts: SingleWikiOptions): ConsoleDeps {
  const { deps } = opts;
  const version = packageVersion();
  const prices = loadPrices();
  const startedAt = Date.now();
  const name = wikiNameOf(deps.dbPath);
  const wiki = (): ConsoleWiki => ({
    name,
    config: deps.config,
    dbPath: deps.dbPath,
    url: `${opts.baseUrl()}/mcp`,
    subject: deps.config.subject,
    ...childRunning(opts.worker()),
  });
  return {
    listWikis: () => [wiki()],
    getWiki: (n) => (n === name ? wiki() : undefined),
    service: () => ({
      version,
      startedAt,
      ...addressOf(opts.baseUrl()),
      mode: deps.config.mode,
      target: ServeTarget.Db,
      path: deps.dbPath,
      ...(opts.logDir === undefined ? {} : { logDir: opts.logDir }),
      archives: [],
    }),
    writes: noWikiWrites(),
    prices,
    log: opts.log,
    ...(deps.ready === undefined ? {} : { ready: deps.ready }),
  };
}
