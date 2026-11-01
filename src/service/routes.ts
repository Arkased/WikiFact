// technical/deployment.md, "Service mode": the URL layout of the service. `/mcp` is the management endpoint, `/wikis/<name>/mcp` one wiki, and
// `/console/` the operator console (technical/console.md, "Mount in the service").
import { consoleRoute, registryDeps } from "../console/index.js";
import { createManagementServer } from "../mcp/management.js";
import { MCP_PATH, firstRoute, mcpTarget, type Route } from "../mcp/http.js";
import { createServer } from "../mcp/server.js";
import type { Logger } from "../log/index.js";
import type { WikiRegistry } from "./registry.js";

const WIKI_PATH = /^\/wikis\/([^/]+)\/mcp$/;

/**
 * Makes the route table of the service. A wiki that `createWiki` adds later is found at once.
 *
 * @param registry - the wikis of the service
 * @param log - receives the tool lines of the management endpoint and the console lines
 * @returns a route that maps `/mcp` to the management server, `/wikis/<name>/mcp` to the 4 tools of that wiki and
 *   `/console/` to the console pages; any other path, and an unknown wiki, is `undefined`
 * @sideEffects reads `package.json` and the clock once, for the console's service row; each new session later builds
 *   a server, and each console request renders a page
 */
export function serviceRoute(registry: WikiRegistry, log: Logger): Route {
  const mcp: Route = (path) => {
    if (path === MCP_PATH) {
      return mcpTarget((session) => createManagementServer(registry, log, session), registry.managementSessions);
    }
    const name = WIKI_PATH.exec(path)?.[1];
    const entry = name === undefined ? undefined : registry.get(name);
    return entry ? mcpTarget((session) => createServer(entry.deps, entry.name, session), entry.sessions) : undefined;
  };
  return firstRoute([mcp, consoleRoute(registryDeps(registry, log))]);
}

/**
 * Builds the base URL of the service from the bound address.
 *
 * @param host - the bound host; an IPv6 address gets brackets
 * @param port - the bound port
 * @returns `http://<host>:<port>`
 * @sideEffects none
 */
export function serviceBaseUrl(host: string, port: number): string {
  return `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
}
