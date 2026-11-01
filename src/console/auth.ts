// technical/console.md, "Authentication" and "Mount in the service": who may write. One function decides, from the mode and the host of the service.
import type { IncomingHttpHeaders } from "node:http";
import { Mode } from "../domain/enums.js";
import { hostRefusal } from "../mcp/host.js";
import type { ServiceFacts } from "./deps.js";

/**
 * Says whether the console's write routes are on. They are on in local mode on the loopback, where the MCP endpoint
 * next to the console already accepts `requestChange` and `createWiki` from any local process. In deployed mode they
 * are off until the bearer token of future.md exists; no form is shown and every POST is 403.
 *
 * @param service - the service facts: the mode and the bound host
 * @returns true in local mode on `127.0.0.1` or `localhost`; false otherwise
 * @sideEffects none
 */
export function writesAllowed(service: Pick<ServiceFacts, "mode" | "host">): boolean {
  // The loopback rule of the HTTP transport is the one definition of "loopback" (technical/deployment.md, "Local mode").
  return service.mode === Mode.Local && hostRefusal(Mode.Local, service.host) === undefined;
}

const LOOPBACK_NAMES = ["127.0.0.1", "localhost", "[::1]"];
const DEFAULT_HTTP_PORT = 80;
const DEFAULT_HTTPS_PORT = 443;

function originMatches(origin: string, service: Pick<ServiceFacts, "host" | "port">): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    // "null" and other opaque origins name no host of ours.
    return false;
  }
  const defaultPort = url.protocol === "https:" ? DEFAULT_HTTPS_PORT : DEFAULT_HTTP_PORT;
  const port = url.port === "" ? defaultPort : Number(url.port);
  if (port !== service.port) return false;
  // A service bound to one loopback name is also reached by the others: the address bar decides which the browser sends.
  const names = LOOPBACK_NAMES.includes(service.host) ? LOOPBACK_NAMES : [service.host];
  return names.includes(url.hostname);
}

/**
 * Refuses a cross-site POST (technical/console.md, "Authentication"): a browser sends a form POST from any site, so a page on another site
 * could submit a console form to the loopback port.
 *
 * @param service - the service facts: the bound host and port the `Origin` must name
 * @param headers - the request headers; `Sec-Fetch-Site` and `Origin` are read
 * @returns the reason to refuse with 403 when `Sec-Fetch-Site` is `cross-site`, or when `Origin` is present and its
 *   host or port differs from the service's (another loopback name of a loopback service is the same host);
 *   `undefined` when the request passes, which includes a request with neither header
 * @sideEffects none
 */
export function originRefusal(
  service: Pick<ServiceFacts, "host" | "port">,
  headers: Pick<IncomingHttpHeaders, "origin" | "sec-fetch-site">,
): string | undefined {
  if (headers["sec-fetch-site"] === "cross-site") {
    return "a cross-site request: the console takes forms from its own pages only";
  }
  const origin = headers.origin;
  if (origin !== undefined && !originMatches(origin, service)) {
    return `the request comes from ${origin}, which is not this service (${service.host}:${service.port})`;
  }
  return undefined;
}
