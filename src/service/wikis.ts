// technical/deployment.md, "Service mode": what the service knows about a wiki without the registry: its URL, its worker, the mode of the
// service and the wiki folders on disk.
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "../config/index.js";
import { Mode } from "../domain/enums.js";
import { hostRefusal } from "../mcp/host.js";
import { STALE_POLL_MS } from "../mcp/warning.js";
import { WIKI_CONFIG_FILE, WIKI_DB_FILE } from "../paths.js";
import { readWorkerStatus } from "../store/index.js";
import { WikiError } from "./errors.js";
import { WIKI_NAME_PATTERN } from "./names.js";
import type { DiscoveredWiki, WikiEntry, WorkerInfo } from "./types.js";

/**
 * Builds the MCP URL of a wiki.
 *
 * @param base - the base URL of the service, without a trailing slash
 * @param name - the wiki name
 * @returns `<base>/wikis/<name>/mcp`
 * @sideEffects none
 */
export function wikiUrl(base: string, name: string): string {
  return `${base}/wikis/${name}/mcp`;
}

/**
 * Reports the worker of a wiki.
 *
 * @param entry - the mounted wiki
 * @param now - the time, in ms since the epoch
 * @returns `running` true when the entry holds a worker child that has not exited, else (a service without
 *   `--with-worker`) when the worker status has a `lastPollAt` within `STALE_POLL_MS`; `lastCall` from the status
 * @sideEffects none (reads the worker status of the store)
 */
export function workerInfo(entry: WikiEntry, now: number): WorkerInfo {
  const status = readWorkerStatus(entry.store);
  const child = entry.worker?.child;
  const running =
    child === undefined
      ? status !== undefined && now - status.lastPollAt <= STALE_POLL_MS
      : child.pid !== undefined && child.exitCode === null && child.signalCode === null;
  return { running, ...(status?.lastCall === undefined ? {} : { lastCall: status.lastCall }) };
}

/**
 * Picks the mode of a service: the mode of its first wiki, or `local` for an empty folder when the host allows it.
 *
 * @param first - the mode of the first wiki, or `undefined` when the folder holds none
 * @param host - the `--host` of the service
 * @returns `first` when given; else `local` on the loopback and `deployed` on any other host, since a local wiki on
 *   another host would be refused at the next start
 * @sideEffects none
 */
export function serviceMode(first: Mode | undefined, host: string): Mode {
  if (first !== undefined) return first;
  return hostRefusal(Mode.Local, host) === undefined ? Mode.Local : Mode.Deployed;
}

/**
 * Finds the wikis of a folder: every subfolder that holds a `wikifact.json`.
 *
 * @param wikisDir - the folder to scan
 * @returns the wikis sorted by name, each with its config loaded; a subfolder without `wikifact.json`, and any
 *   folder whose name starts with `.`, is skipped
 * @throws {WikiError} when the folder does not exist, or a subfolder name does not match `WIKI_NAME_PATTERN`
 * @throws {Error} when a `wikifact.json` or the presets file is invalid
 * @sideEffects reads the folder, each `wikifact.json` and the presets file
 */
export function discoverWikis(wikisDir: string): DiscoveredWiki[] {
  const root = resolve(wikisDir);
  if (!existsSync(root)) throw new WikiError(`the wikis folder ${root} does not exist`);
  const found: DiscoveredWiki[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    // A dot-folder, `.archive/` first among them, is never a wiki.
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const dir = join(root, entry.name);
    if (!existsSync(join(dir, WIKI_CONFIG_FILE))) continue;
    if (!WIKI_NAME_PATTERN.test(entry.name)) {
      throw new WikiError(
        `the folder ${dir} is not a valid wiki name: use 1 to 40 lower-case letters, digits and hyphens`,
      );
    }
    const dbPath = join(dir, WIKI_DB_FILE);
    found.push({ name: entry.name, dir, dbPath, config: loadConfig(dbPath) });
  }
  return found.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
