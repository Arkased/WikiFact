// The MCP server: the 5 consumer tools of technical/lookup.md, "MCP tool contracts" (see tools.ts) and the store connections of technical/storage.md, "Storage".
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config/index.js";
import { stderrLogger, type Logger } from "../log/index.js";
import { packageVersion } from "../paths.js";
import type { Store } from "../store/index.js";
import { DEFAULT_WIKI_NAME, wikiInstructions } from "./instructions.js";
import type { SessionHandle } from "./sessions.js";
import { registerTools } from "./tools.js";

// Read once at load, so the server reports the installed version.
const VERSION = packageVersion();

export { CORRECTION_DUTY } from "./tools.js";

/** What a server needs: the database, the config and the write connection. */
export interface ServerDeps {
  dbPath: string;
  config: Config;
  /** The server's one write connection: queue rows and retrieval rows only. */
  writeStore: Store;
  /** One JSON line per tool call. Default: stderr. */
  log?: Logger;
  /** Resolves when the embedder is warm; a `search` call waits for it. Default: no wait. */
  ready?: () => Promise<unknown>;
}

/**
 * Builds an MCP server with the 4 tools. One per transport. The connections are not tied to it.
 *
 * @param deps - the database, the config, the write connection and an optional logger
 * @param name - the name of the wiki, for the instructions; default: `wikifact`, for a server of a single wiki
 * @param session - the MCP session of the client, so that each call counts on it and its reads and searches carry the
 *   session id; absent for a server with no session
 * @returns the server, with the instructions of technical/lookup.md, "Server instructions", not yet connected to a transport
 * @sideEffects registers the tool handlers; each tool call later opens a read connection and logs a line
 */
export function createServer(deps: ServerDeps, name: string = DEFAULT_WIKI_NAME, session?: SessionHandle): McpServer {
  const instructions = wikiInstructions({ name, subject: deps.config.subject });
  const server = new McpServer({ name: "wikifact", version: VERSION }, { instructions });
  registerTools(server, { ...deps, log: deps.log ?? stderrLogger(), session });
  return server;
}
