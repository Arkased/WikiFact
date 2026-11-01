// technical/deployment.md, "Service mode": the data types of the wiki registry. A leaf module, so that the registry and the editor both import
// them without a cycle.
import type { Config } from "../config/index.js";
import type { Mode } from "../domain/enums.js";
import type { ServerDeps } from "../mcp/server.js";
import type { McpSessions } from "../mcp/sessions.js";
import type { WorkerChild } from "../mcp/worker-child.js";
import type { Store, WorkerCall } from "../store/index.js";

/** A wiki folder found on disk, with its config loaded and its store not yet opened. */
export interface DiscoveredWiki {
  name: string;
  /** The absolute folder of the wiki. */
  dir: string;
  /** The absolute path of the database file. */
  dbPath: string;
  config: Config;
}

/** A mounted wiki. */
export interface WikiEntry extends DiscoveredWiki {
  /** The one write connection of the endpoint: queue rows and retrieval rows. */
  store: Store;
  /** What a fresh MCP server of this wiki needs; each request builds its server from it. */
  deps: ServerDeps;
  /** The worker child, with `--with-worker` and when it was started. It stands for the newest child after a restart. */
  worker?: WorkerChild;
  /** The restarts of the worker child since the service started (technical/deployment.md, "Worker restart"); reset with the service. */
  workerRestarts: number;
  /** The open MCP sessions of the wiki's endpoint. */
  sessions: McpSessions;
}

/** One row of `listWikis`. */
export interface WikiInfo {
  name: string;
  subject: string;
  /** The `description` of `wikifact.json`; absent when it has none. */
  description?: string;
  /** The MCP URL of the wiki. */
  url: string;
  /** Facts whose current version is not a deletion. */
  liveFacts: number;
  /** Requests with status `queued`. */
  queued: number;
  worker: WorkerInfo;
}

/** What `listWikis` says about the worker of a wiki. */
export interface WorkerInfo {
  /** True when the service holds a live worker child, or, without `--with-worker`, when the worker polled recently. */
  running: boolean;
  /** The last model call of the worker, from its status; absent until the worker made a call. */
  lastCall?: WorkerCall;
}

/** The result of `createWiki`. */
export interface CreatedWiki {
  name: string;
  /** The MCP URL of the new wiki. */
  url: string;
  /** `false` when the wiki existed with the same subject. */
  created: boolean;
}

/** The result of `archiveWiki`: `removed` for an empty wiki, else the archive folder relative to the wikis root. */
export interface ArchivedWiki {
  name: string;
  removed?: true;
  archivedTo?: string;
}

/** The result of `unarchiveWiki`. */
export interface RestoredWiki {
  name: string;
  /** The MCP URL of the restored wiki. */
  url: string;
  /** The archive folder that was restored, `<name>-<stamp>`. */
  restoredFrom: string;
  /** Present when several archives share the name: says which one was restored. */
  note?: string;
}

/** The settings a registry was made with, as the console's service row reads them (technical/console.md, "Mount in the service"). */
export interface RegistrySettings {
  /** The absolute wikis folder. */
  wikisDir: string;
  /** The `--host` of the service. */
  host: string;
  /** The log directory of the process; absent means stderr. */
  logDir?: string;
  /** The base URL of the service, read at each call so that the bound port counts. */
  baseUrl: () => string;
  /** The mode of the service: that of its first wiki, else `serviceMode` of an empty folder. */
  mode: () => Mode;
}
