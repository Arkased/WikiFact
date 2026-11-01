// technical/deployment.md, "Service mode": the wiki registry of service mode. One entry per wiki folder: its config, its write connection, the
// deps of its MCP endpoint and, with `--with-worker`, its worker child.
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { loadConfig, parseConfig } from "../config/index.js";
import { LogEvent, LogLevel, Mode, type Quality } from "../domain/enums.js";
import type { Logger } from "../log/index.js";
import { McpSessions } from "../mcp/sessions.js";
import { startWorkerChild, type WorkerChild, type WorkerCommand } from "../mcp/worker-child.js";
import { WIKI_CONFIG_FILE, WIKI_DB_FILE } from "../paths.js";
import {
  closeStore,
  countFacts,
  countLiveFacts,
  countQueued,
  endOpenSessions,
  openStoreFor,
  pruneToolCalls,
  type Store,
} from "../store/index.js";

/** How often the service deletes the `tool_calls` rows older than `TOOL_CALL_RETENTION_MS`, in ms: 1 day. */
export const TOOL_CALL_PRUNE_MS = 86_400_000;
import {
  ARCHIVE_DIR,
  archiveFolderName,
  findArchive,
  listArchives,
  retryWhileLocked,
  type ArchiveInfo,
} from "./archive.js";
import { WikiError } from "./errors.js";
import { createWikiEditor, type WikiEditor } from "./edit.js";
import { WIKI_NAME_PATTERN, findTwin } from "./names.js";
import type {
  ArchivedWiki,
  CreatedWiki,
  DiscoveredWiki,
  RegistrySettings,
  RestoredWiki,
  WikiEntry,
  WikiInfo,
} from "./types.js";
import { serviceMode, wikiUrl, workerInfo } from "./wikis.js";
import { superviseWorker } from "./worker-supervisor.js";
import { JSON_INDENT } from "../constants.js";

export { WikiError };

export { WIKI_NAME_PATTERN };

export { discoverWikis, serviceMode, wikiUrl, workerInfo } from "./wikis.js";
export type { WikiEntry } from "./types.js";

/** The cap of `--max-wikis` when the option is absent. */
const DEFAULT_MAX_WIKIS = 10;

/** How long `archiveWiki` waits for the worker child to exit before it tries the move anyway, in milliseconds. */
const WORKER_EXIT_WAIT_MS = 10_000;

/** The options of `createWikiRegistry`. */
export interface RegistryOptions {
  /** The folder that holds the wiki folders. */
  wikisDir: string;
  /** The `--host` of the service; it decides the mode of a wiki that `createWiki` adds to an empty folder. */
  host: string;
  /** Start a worker child for every wiki, existing and created (`--with-worker`). */
  withWorker: boolean;
  /** The most wikis the service holds (`--max-wikis`); default `DEFAULT_MAX_WIKIS`. */
  maxWikis?: number;
  log: Logger;
  /** The log directory that each worker child gets as its `--log-dir`. */
  logDir?: string;
  /** The base URL of the service, `http://<host>:<port>`, read when a URL is built so that the bound port counts. */
  baseUrl: () => string;
  /** Resolves when the embedder is warm; each wiki's `search` waits for it. Read at each call. Default: no wait. */
  ready?: () => Promise<unknown>;
  /** The program to spawn as the worker child of a database. Default: this binary's `worker` command. */
  workerCommand?: (db: string) => WorkerCommand;
}

/**
 * The wikis of a service and the means to add, list and stop them. The edits of a mounted wiki (`setDescription`,
 * `readRawConfig`, `updateConfig`, `renameWiki`) are those of `WikiEditor` (edit.ts).
 */
export interface WikiRegistry extends WikiEditor {
  /**
   * Reads the settings the registry was made with.
   *
   * @returns the wikis folder, the host, the log directory, the base URL and the mode
   * @sideEffects none
   */
  settings(): RegistrySettings;
  /**
   * Lists the mounted wikis without reading their stores.
   *
   * @returns the entries sorted by name
   * @sideEffects none
   */
  entries(): WikiEntry[];
  /**
   * Opens the store of a discovered wiki and mounts its endpoint.
   *
   * @param wiki - the wiki found by `discoverWikis`
   * @returns the entry, with a worker child when the registry has `withWorker`
   * @throws {Error} when the database cannot be opened or its meta differs from the config
   * @sideEffects opens the write connection; ends the sessions that a stopped service left open; spawns the worker
   *   child; logs one `LogEvent.WikiMounted` line
   */
  mount(wiki: DiscoveredWiki): WikiEntry;
  /**
   * Adds a wiki: writes the folder and `wikifact.json`, creates the empty database, mounts the endpoint and starts
   * the worker child.
   *
   * @param name - the folder name; it must match `WIKI_NAME_PATTERN`
   * @param subject - the sentence every question gets; not empty
   * @param quality - the preset name; absent leaves the key out of `wikifact.json`
   * @returns the name, the MCP URL and `created`; the same name with the same subject returns the existing wiki with
   *   `created: false`
   * @throws {WikiError} for a bad name, an empty subject, the same name with another subject (the message names the
   *   existing subject), a near-twin of an existing name (the message names that wiki), an existing folder, or a
   *   count at `maxWikis`
   * @sideEffects creates `<wikisDir>/<name>/wikifact.json` and the database; spawns the worker child with
   *   `withWorker`; logs one `LogEvent.WikiCreated` line; removes the folder again when the open fails
   */
  addWiki(name: string, subject: string, quality?: Quality): CreatedWiki;
  /**
   * Unmounts a wiki, stops its worker child and closes its store. An empty wiki is removed, any other is moved to
   * `<wikisDir>/.archive/<name>-<stamp>/`.
   *
   * @param name - the wiki name
   * @returns `{ name, removed: true }` for a wiki with no fact (live or deleted) and 0 queued requests, else
   *   `{ name, archivedTo }` with the archive folder relative to the wikis root
   * @throws {WikiError} for an unknown name
   * @throws {FolderLockedError} when the folder stays locked after every retry (the wiki is mounted again then)
   * @sideEffects waits for the worker child to exit; ends the MCP sessions of the wiki; closes the store; moves or
   *   removes the folder; retries a locked folder a few times with a short delay; logs one `LogEvent.WikiArchived` line
   */
  archiveWiki(name: string): Promise<ArchivedWiki>;
  /**
   * Moves an archived wiki back to `<wikisDir>/<name>/` and mounts it.
   *
   * @param name - a wiki name (the newest archive of it is restored) or a full archive folder name
   * @returns the name, the URL and the archive folder that was restored
   * @throws {WikiError} for an unknown archive, a live wiki with that name, a count at `maxWikis`, or a folder that
   *   stays locked
   * @sideEffects moves the folder; opens the store; spawns the worker child with `withWorker`; logs one
   *   `LogEvent.WikiRestored` line and one `LogEvent.WikiMounted` line
   */
  unarchiveWiki(name: string): Promise<RestoredWiki>;
  /**
   * Lists the archived wikis.
   *
   * @returns one row per archive folder, sorted by name and then newest first
   * @sideEffects reads the `.archive/` folder
   */
  listArchived(): ArchiveInfo[];
  /**
   * Lists the wikis with their sizes.
   *
   * @returns one row per wiki, sorted by name
   * @sideEffects none (reads each store)
   */
  listWikis(): WikiInfo[];
  /**
   * The open sessions of the management endpoint. Each writes its `sessions` row in every wiki mounted at its `initialize`, not in a store of its own.
   */
  readonly managementSessions: McpSessions;
  /**
   * Finds a mounted wiki.
   *
   * @param name - the wiki name
   * @returns the entry, or `undefined` for an unknown name
   * @sideEffects none
   */
  get(name: string): WikiEntry | undefined;
  /**
   * Stops the worker children and closes the stores.
   *
   * @sideEffects kills the children without a restart; ends every MCP session; closes the connections; safe to call
   *   twice
   */
  stop(): void;
}

/**
 * Makes the registry of a service.
 *
 * @param opts - the wikis folder, the host, the worker flag, the logger and the base URL
 * @returns an empty registry; `mount` fills it
 * @sideEffects none; the methods of the registry do the work
 */
export function createWikiRegistry(opts: RegistryOptions): WikiRegistry {
  const wikisDir = resolve(opts.wikisDir);
  const maxWikis = opts.maxWikis ?? DEFAULT_MAX_WIKIS;
  const entries = new Map<string, WikiEntry>();
  let stopped = false;
  let pruneTimer: ReturnType<typeof setInterval> | undefined;

  // The daily sweep of the old `tool_calls` rows of every mounted wiki; a store that fails is skipped until the next day.
  const pruneAll = (): void => {
    for (const e of entries.values()) {
      try {
        pruneToolCalls(e.store, Date.now());
      } catch {
        // closed or locked
      }
    }
  };

  // `createWiki` copies the mode of the first wiki (technical/deployment.md, "Service mode").
  const newWikiMode = (): Mode => serviceMode(entries.values().next().value?.config.mode, opts.host);

  const managementSessions = new McpSessions({
    log: opts.log,
    wikiStores: () => [...entries].map(([name, e]): [string, Store] => [name, e.store]),
  });

  const startChild = (entry: WikiEntry): WorkerChild =>
    superviseWorker({
      wiki: entry.name,
      log: opts.log,
      countRestart: () => ++entry.workerRestarts,
      start: () =>
        startWorkerChild({
          db: entry.dbPath,
          log: opts.log,
          logDir: opts.logDir,
          command: opts.workerCommand?.(entry.dbPath),
        }),
    });

  const mount = (wiki: DiscoveredWiki): WikiEntry => {
    const store = openStoreFor(wiki.config, wiki.dbPath);
    // A service that stopped without ending its sessions left rows open; none of them can still be live.
    endOpenSessions(store, Date.now());
    pruneToolCalls(store, Date.now());
    pruneTimer ??= setInterval(pruneAll, TOOL_CALL_PRUNE_MS).unref();
    const entry: WikiEntry = {
      ...wiki,
      store,
      workerRestarts: 0,
      sessions: new McpSessions({ store, wiki: wiki.name, log: opts.log }),
      deps: {
        dbPath: wiki.dbPath,
        config: wiki.config,
        writeStore: store,
        log: opts.log,
        ready: opts.ready,
      },
    };
    if (opts.withWorker) entry.worker = startChild(entry);
    entries.set(wiki.name, entry);
    opts.log({
      event: LogEvent.WikiMounted,
      level: LogLevel.Info,
      name: wiki.name,
      mode: wiki.config.mode,
      url: wikiUrl(opts.baseUrl(), wiki.name),
    });
    return entry;
  };

  const addWiki = (name: string, subject: string, quality?: Quality): CreatedWiki => {
    if (!WIKI_NAME_PATTERN.test(name)) {
      throw new WikiError(`"${name}" is not a valid name: use 1 to 40 lower-case letters, digits and hyphens`);
    }
    if (subject.trim() === "") throw new WikiError("subject must not be empty");
    const existing = entries.get(name);
    if (existing) {
      if (existing.config.subject.trim() === subject.trim()) {
        return { name, url: wikiUrl(opts.baseUrl(), name), created: false };
      }
      throw new WikiError(
        `a wiki named "${name}" exists with another subject: "${existing.config.subject}". Use that wiki, or pick a different name.`,
      );
    }
    const twin = findTwin(name, entries.keys());
    if (twin !== undefined) {
      throw new WikiError(
        `"${name}" is too close to the existing wiki "${twin}" (same name apart from case, hyphens and a final "s"). Use "${twin}", or pick a clearly different name.`,
      );
    }
    if (entries.size >= maxWikis) {
      throw new WikiError(
        `the service holds ${entries.size} wikis, the cap (--max-wikis ${maxWikis}). A human raises the cap with serve --max-wikis N and restarts the service.`,
      );
    }
    const dir = join(wikisDir, name);
    if (existsSync(dir)) throw new WikiError(`a wiki folder named "${name}" already exists`);
    const raw = { mode: newWikiMode(), subject, ...(quality === undefined ? {} : { quality }) };
    const config = parseConfig(raw);
    try {
      // Not recursive: a folder created meanwhile by another process fails here and is not overwritten.
      mkdirSync(dir);
    } catch {
      throw new WikiError(`a wiki folder named "${name}" already exists`);
    }
    try {
      writeFileSync(join(dir, WIKI_CONFIG_FILE), JSON.stringify(raw, null, JSON_INDENT) + "\n");
      mount({ name, dir, dbPath: join(dir, WIKI_DB_FILE), config });
    } catch (e) {
      entries.get(name)?.worker?.stop();
      entries.delete(name);
      rmSync(dir, { recursive: true, force: true });
      throw e;
    }
    const url = wikiUrl(opts.baseUrl(), name);
    opts.log({ event: LogEvent.WikiCreated, level: LogLevel.Info, name, url });
    return { name, url, created: true };
  };

  const archiveWiki = async (name: string): Promise<ArchivedWiki> => {
    const entry = entries.get(name);
    if (!entry) throw new WikiError(`no wiki named "${name}"`);
    entries.delete(name);
    if (entry.worker) {
      entry.worker.stop();
      await Promise.race([entry.worker.exited, delay(WORKER_EXIT_WAIT_MS)]);
    }
    const empty = countFacts(entry.store) === 0 && countQueued(entry.store) === 0;
    await entry.sessions.close();
    managementSessions.endWiki(name);
    closeStore(entry.store);
    const archiveFolder = archiveFolderName(name);
    try {
      if (empty) {
        await retryWhileLocked(() => rmSync(entry.dir, { recursive: true, force: true }), `remove "${name}"`);
      } else {
        mkdirSync(join(wikisDir, ARCHIVE_DIR), { recursive: true });
        await retryWhileLocked(
          () => renameSync(entry.dir, join(wikisDir, ARCHIVE_DIR, archiveFolder)),
          `archive "${name}"`,
        );
      }
    } catch (e) {
      // The folder is still there: serve it again rather than leave it half-gone.
      try {
        mount({ name, dir: entry.dir, dbPath: entry.dbPath, config: entry.config });
      } catch {
        // the next start discovers the folder
      }
      throw e;
    }
    const archivedTo = empty ? undefined : `${ARCHIVE_DIR}/${archiveFolder}`;
    opts.log({
      event: LogEvent.WikiArchived,
      level: LogLevel.Info,
      name,
      removed: empty,
      ...(archivedTo ? { archivedTo } : {}),
    });
    return empty ? { name, removed: true } : { name, archivedTo };
  };

  const unarchiveWiki = async (name: string): Promise<RestoredWiki> => {
    const found = findArchive(wikisDir, name);
    if (!found) {
      throw new WikiError(`no archive named "${name}". listWikis shows the archives that can be restored.`);
    }
    const { archive, sameName } = found;
    const dir = join(wikisDir, archive.name);
    if (entries.has(archive.name) || existsSync(dir)) {
      throw new WikiError(`a wiki named "${archive.name}" exists. Archive it first if you want the archived one back.`);
    }
    if (entries.size >= maxWikis) {
      throw new WikiError(
        `the service holds ${entries.size} wikis, the cap (--max-wikis ${maxWikis}). A human raises the cap with serve --max-wikis N and restarts the service.`,
      );
    }
    await retryWhileLocked(
      () => renameSync(join(wikisDir, ARCHIVE_DIR, archive.folder), dir),
      `restore "${archive.folder}"`,
    );
    const dbPath = join(dir, WIKI_DB_FILE);
    mount({ name: archive.name, dir, dbPath, config: loadConfig(dbPath) });
    const url = wikiUrl(opts.baseUrl(), archive.name);
    opts.log({
      event: LogEvent.WikiRestored,
      level: LogLevel.Info,
      name: archive.name,
      from: archive.folder,
      url,
    });
    const note =
      sameName > 1
        ? `${sameName} archives share the name "${archive.name}"; restored the ${found.archive.folder === name ? "one you named" : "newest"}, ${archive.folder}. The others stay in .archive/.`
        : undefined;
    return { name: archive.name, url, restoredFrom: archive.folder, ...(note ? { note } : {}) };
  };

  const listWikis = (): WikiInfo[] =>
    [...entries.values()]
      .map((e) => ({
        name: e.name,
        subject: e.config.subject,
        ...(e.config.description === undefined ? {} : { description: e.config.description }),
        url: wikiUrl(opts.baseUrl(), e.name),
        liveFacts: countLiveFacts(e.store),
        queued: countQueued(e.store),
        worker: workerInfo(e, Date.now()),
      }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const editor = createWikiEditor({
    wikisDir,
    entries,
    managementSessions,
    mount,
    startChild,
    urlOf: (name) => wikiUrl(opts.baseUrl(), name),
  });

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (pruneTimer !== undefined) clearInterval(pruneTimer);
    pruneTimer = undefined;
    void managementSessions.close();
    for (const e of entries.values()) {
      e.worker?.stop();
      // The end of each session writes its row before the store closes: `close` does its writes before it first waits.
      void e.sessions.close();
      try {
        closeStore(e.store);
      } catch {
        // already closed
      }
    }
  };

  return {
    ...editor,
    settings: () => ({
      wikisDir,
      host: opts.host,
      ...(opts.logDir === undefined ? {} : { logDir: opts.logDir }),
      baseUrl: opts.baseUrl,
      mode: newWikiMode,
    }),
    entries: () => [...entries.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    mount,
    addWiki,
    archiveWiki,
    unarchiveWiki,
    listArchived: () => listArchives(wikisDir),
    listWikis,
    managementSessions,
    get: (name) => entries.get(name),
    stop,
  };
}
