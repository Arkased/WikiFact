// technical/console.md, "Operator actions", "Direct edits of non-request fields": the edits of a mounted wiki that the operator console asks for. The description
// and the config keys go to `wikifact.json`; a restart replaces the worker child between two requests; a rename moves the
// folder. The registry (registry.ts) builds one editor over its entries.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { loadConfig, parseConfig, type Config } from "../config/index.js";
import { ConfigEditKey, RequestStatus, enumValues } from "../domain/enums.js";
import type { McpSessions } from "../mcp/sessions.js";
import type { WorkerChild } from "../mcp/worker-child.js";
import { WIKI_CONFIG_FILE, WIKI_DB_FILE } from "../paths.js";
import { closeStore, getRequest, listRunning } from "../store/index.js";
import { MS_PER_SECOND } from "../time.js";
import { retryWhileLocked } from "./archive.js";
import { WikiError } from "./errors.js";
import { WIKI_NAME_PATTERN, findTwin } from "./names.js";
import type { DiscoveredWiki, WikiEntry } from "./types.js";
import { JSON_INDENT } from "../constants.js";

/** The keys of `wikifact.json` that `updateConfig` edits (technical/console.md, "Direct edits of non-request fields"). The worker reads every one of them at start. */
export const CONFIG_EDIT_KEYS: readonly ConfigEditKey[] = enumValues(ConfigEditKey);

const CONFIG_EDIT_SET: ReadonlySet<string> = new Set(CONFIG_EDIT_KEYS);

/**
 * The keys of `wikifact.json` that `updateConfig` refuses, with the reason the error gives and the config form shows
 * (technical/console.md, "Direct edits of non-request fields"). These are not members of `ConfigEditKey`.
 */
const REFUSED_KEYS: Readonly<Record<string, string>> = {
  mode: "a mode change changes the host rules and the transport: edit wikifact.json by hand and restart the service",
  embeddingModel:
    "an embedding model change needs a reindex and a restart: edit wikifact.json by hand, then run `wikifact reindex`",
};

/** How long `restartWorker` waits for the worker to exit after the stop, in ms. */
const WORKER_EXIT_WAIT_MS = 10_000;

/** How often `restartWorker` looks at the request the worker is running, in ms. */
const RUNNING_POLL_MS = 200;

/** How many question timeouts `restartWorker` waits for the running request to finish (technical/console.md, "Operator actions"). */
const RESTART_WAIT_TIMEOUTS = 2;

const rawConfigSchema = z.record(z.string(), z.unknown());

/** What `updateConfig` did. */
export interface ConfigUpdate {
  /** The config after the edit, as the endpoint and the next worker read it. */
  config: Config;
  /** The keys of the patch whose value changed. */
  changed: string[];
  /** True when the worker child was restarted because a key it reads at start changed. */
  restarted: boolean;
}

/** The result of `renameWiki`. */
export interface RenamedWiki {
  /** The old name; its MCP URL is gone. */
  from: string;
  /** The new name. */
  name: string;
  /** The new MCP URL. A session that pinned the old URL must add this one. */
  url: string;
}

/** What the editor needs from the registry. */
export interface EditorContext {
  /** The absolute wikis folder. */
  wikisDir: string;
  /** The mounted wikis by name; the editor reads them and removes a renamed one. */
  entries: Map<string, WikiEntry>;
  /** The management sessions; a rename ends their rows in the old wiki. */
  managementSessions: McpSessions;
  /**
   * Opens the store of a wiki, mounts its endpoint and starts its worker child.
   *
   * @param wiki - the wiki folder to serve, with its config loaded; its name is the key in `entries`
   * @returns the new entry, which is also in `entries`
   * @throws {Error} when the database cannot be opened or its meta differs from the config; nothing is mounted then
   * @sideEffects opens the write connection; adds the entry; spawns the worker child when the service runs one; logs
   *   the mount
   */
  mount(wiki: DiscoveredWiki): WikiEntry;
  /**
   * Starts a worker child for a wiki, restarted when it exits without a request to stop.
   *
   * @param entry - the mounted wiki; its database is the one the child works on
   * @returns the running child
   * @sideEffects spawns a child process
   */
  startChild(entry: WikiEntry): WorkerChild;
  /**
   * Builds the MCP URL of a wiki.
   *
   * @param name - the wiki name, as mounted
   * @returns the URL with the base URL of the service as it is bound now
   * @sideEffects none
   */
  urlOf(name: string): string;
}

/** The edits of a mounted wiki. */
export interface WikiEditor {
  /**
   * Sets the description of a wiki in its `wikifact.json`.
   *
   * @param name - the wiki name
   * @param text - the description; an empty text (after trimming) removes the key
   * @throws {WikiError} for an unknown name
   * @sideEffects rewrites `wikifact.json`; updates the config of the mounted entry; the worker is not touched
   */
  setDescription(name: string, text: string): void;
  /**
   * Reads `wikifact.json` as the file holds it, with no preset merged and no default filled in (technical/console.md, "Direct edits of non-request fields").
   *
   * @param name - the wiki name
   * @returns the parsed keys of the file; `{}` when the file does not exist
   * @throws {WikiError} for an unknown name
   * @sideEffects reads `wikifact.json`
   */
  readRawConfig(name: string): Record<string, unknown>;
  /**
   * Edits keys of `wikifact.json` and restarts the worker child when a key it reads at start changed.
   *
   * @param name - the wiki name
   * @param patch - key to new value; `undefined` removes the key (the default applies); the keys are `CONFIG_EDIT_KEYS`
   * @returns the new config, the keys that changed and whether the worker was restarted
   * @throws {WikiError} for an unknown name, `mode` or `embeddingModel` (refused), any other key, or a value that
   *   makes `wikifact.json` invalid; nothing is written then
   * @sideEffects rewrites `wikifact.json`; updates the config of the mounted entry; as `restartWorker` when it restarts
   */
  updateConfig(name: string, patch: Readonly<Record<string, unknown>>): Promise<ConfigUpdate>;
  /**
   * Renames a wiki: stops its worker, moves the folder, mounts the new name and starts the worker again.
   *
   * @param from - the current name
   * @param to - the new name; the rules of `createWiki`
   * @returns the old name, the new name and the new MCP URL
   * @throws {WikiError} for an unknown wiki, a bad name, the same name, a near-twin of another wiki, an existing
   *   folder, a folder that stays locked, or a mount under the new name that fails (the folder is moved back and the
   *   old name is mounted again, then the mount error is rethrown)
   * @sideEffects stops the worker child; ends the MCP sessions of the old name; closes the store; moves the folder;
   *   opens the store; spawns the worker child
   */
  renameWiki(from: string, to: string): Promise<RenamedWiki>;
}

/**
 * Builds the editor over the entries of a registry.
 *
 * @param ctx - the entries and the means to mount, to start a child and to build a URL
 * @returns the editor
 * @sideEffects none; the methods of the editor do the work
 */
export function createWikiEditor(ctx: EditorContext): WikiEditor {
  const need = (name: string): WikiEntry => {
    const entry = ctx.entries.get(name);
    if (!entry) throw new WikiError(`no wiki named "${name}"`);
    return entry;
  };

  const readRaw = (dir: string): Record<string, unknown> => {
    const path = join(dir, WIKI_CONFIG_FILE);
    if (!existsSync(path)) return {};
    return rawConfigSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  };

  // A temporary file and a rename, so that a crash leaves the old file whole.
  const writeRaw = (dir: string, raw: Record<string, unknown>): void => {
    const path = join(dir, WIKI_CONFIG_FILE);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(raw, null, JSON_INDENT) + "\n");
    renameSync(tmp, path);
  };

  // Validates the merged file as the worker would read it, before anything is written.
  const validate = (raw: Record<string, unknown>): void => {
    try {
      parseConfig(raw);
    } catch (e) {
      if (!(e instanceof z.ZodError)) throw e;
      const issues = e.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
      throw new WikiError(`wikifact.json would be invalid: ${issues}`);
    }
  };

  const apply = (entry: WikiEntry): Config => {
    const config = loadConfig(entry.dbPath);
    entry.config = config;
    entry.deps = { ...entry.deps, config };
    return config;
  };

  const setDescription = (name: string, text: string): void => {
    const entry = need(name);
    const next = readRaw(entry.dir);
    if (text.trim() === "") delete next.description;
    else next.description = text.trim();
    validate(next);
    writeRaw(entry.dir, next);
    apply(entry);
  };

  const restartWorker = async (name: string): Promise<void> => {
    const entry = need(name);
    const child = entry.worker;
    if (!child) {
      throw new WikiError(
        `the service holds no worker child for "${name}": it started without --with-worker, so the worker runs outside it`,
      );
    }
    const deadline = Date.now() + RESTART_WAIT_TIMEOUTS * entry.config.questionTimeout * MS_PER_SECOND;
    const running = listRunning(entry.store);
    // The request that runs now is the one to wait for; the next one the worker takes is safe to cut (technical/updates.md, "Queue and worker").
    while (
      Date.now() < deadline &&
      running.some((id) => getRequest(entry.store, id)?.status === RequestStatus.Running)
    ) {
      await delay(RUNNING_POLL_MS);
    }
    child.stop();
    await Promise.race([child.exited, delay(WORKER_EXIT_WAIT_MS)]);
    entry.worker = ctx.startChild(entry);
  };

  const updateConfig = async (name: string, patch: Readonly<Record<string, unknown>>): Promise<ConfigUpdate> => {
    const entry = need(name);
    for (const key of Object.keys(patch)) {
      const refusal = REFUSED_KEYS[key];
      if (refusal !== undefined) throw new WikiError(`"${key}" is not edited here: ${refusal}`);
      if (!CONFIG_EDIT_SET.has(key)) {
        throw new WikiError(`"${key}" is not a key that can be edited here (${CONFIG_EDIT_KEYS.join(", ")})`);
      }
    }
    const raw = readRaw(entry.dir);
    const next: Record<string, unknown> = { ...raw };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete next[key];
      else next[key] = value;
    }
    validate(next);
    const changed = Object.keys(patch).filter((k) => JSON.stringify(raw[k]) !== JSON.stringify(next[k]));
    if (changed.length > 0) writeRaw(entry.dir, next);
    const config = apply(entry);
    // Every editable key is read by the worker at start, so any change needs the new child.
    const restarted = changed.length > 0 && entry.worker !== undefined;
    if (restarted) await restartWorker(name);
    return { config, changed, restarted };
  };

  const renameWiki = async (from: string, to: string): Promise<RenamedWiki> => {
    const entry = need(from);
    if (!WIKI_NAME_PATTERN.test(to)) {
      throw new WikiError(`"${to}" is not a valid name: use 1 to 40 lower-case letters, digits and hyphens`);
    }
    if (to === from) throw new WikiError(`the wiki is already named "${to}"`);
    const others = [...ctx.entries.keys()].filter((n) => n !== from);
    if (others.includes(to)) throw new WikiError(`a wiki named "${to}" exists`);
    const twin = findTwin(to, others);
    if (twin !== undefined) {
      throw new WikiError(
        `"${to}" is too close to the existing wiki "${twin}" (same name apart from case, hyphens and a final "s"). Pick a clearly different name.`,
      );
    }
    const dir = join(ctx.wikisDir, to);
    if (existsSync(dir)) throw new WikiError(`a wiki folder named "${to}" already exists`);
    ctx.entries.delete(from);
    if (entry.worker) {
      entry.worker.stop();
      await Promise.race([entry.worker.exited, delay(WORKER_EXIT_WAIT_MS)]);
    }
    await entry.sessions.close();
    ctx.managementSessions.endWiki(from);
    closeStore(entry.store);
    try {
      await retryWhileLocked(() => renameSync(entry.dir, dir), `rename "${from}" to "${to}"`);
    } catch (e) {
      // The folder did not move: serve it again under the old name.
      try {
        ctx.mount({ name: from, dir: entry.dir, dbPath: entry.dbPath, config: entry.config });
      } catch {
        // the next start discovers the folder
      }
      throw e;
    }
    const dbPath = join(dir, WIKI_DB_FILE);
    try {
      ctx.mount({ name: to, dir, dbPath, config: loadConfig(dbPath) });
    } catch (e) {
      // The folder moved but the new name does not mount: put it back and serve it under the old name.
      try {
        await retryWhileLocked(() => renameSync(dir, entry.dir), `move "${to}" back to "${from}"`);
        ctx.mount({ name: from, dir: entry.dir, dbPath: entry.dbPath, config: entry.config });
      } catch {
        // the next start discovers the folder
      }
      throw e;
    }
    return { from, name: to, url: ctx.urlOf(to) };
  };

  const readRawConfig = (name: string): Record<string, unknown> => readRaw(need(name).dir);

  return { setDescription, readRawConfig, updateConfig, renameWiki };
}
