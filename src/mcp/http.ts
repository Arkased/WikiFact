// The HTTP mode of `serve` (technical/deployment.md, "Install and run", "Service mode" and technical/console.md, "Mount in the service"): Streamable HTTP with one session per client ("MCP sessions"). A route table maps a URL path to
// what answers it: the MCP server of a database (one path for `--db`, many for service mode) or a plain request
// handler, as the console pages are.
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { LogEvent, LogLevel, RouteKind, SessionEndReason } from "../domain/enums.js";
import type { Logger } from "../log/index.js";
import { createServer, type ServerDeps } from "./server.js";
import type { ClientInfo, McpSessions, SessionHandle } from "./sessions.js";

/** The path of the MCP endpoint of a single database. */
export const MCP_PATH = "/mcp";
/** The header that carries the session id, in lower case as Node reads it. */
const SESSION_HEADER = "mcp-session-id";
const STATUS_BAD_REQUEST = 400;
const STATUS_NOT_FOUND = 404;
const STATUS_METHOD_NOT_ALLOWED = 405;
const STATUS_SERVER_ERROR = 500;

/** Builds the MCP server of one new session; the handle counts its calls on the session. */
export type ServerFactory = (session: SessionHandle) => McpServer;

/** Answers one HTTP request itself: it picks its methods, writes the head and ends the response. */
export type RequestHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

/** A path that an MCP server answers; the HTTP layer builds one server and one transport per session. */
export interface McpRoute {
  kind: RouteKind.Mcp;
  factory: ServerFactory;
  /** The open sessions of this path. */
  sessions: McpSessions;
}

/** A path that a plain handler answers (technical/console.md, "Mount in the service"); the handler decides the methods and the status. */
interface HttpRoute {
  kind: RouteKind.Http;
  handle: RequestHandler;
}

/** What a path resolves to. */
type RouteTarget = McpRoute | HttpRoute;

/** Maps a URL path (without the query) to what answers it, or `undefined` for a 404. */
export type Route = (path: string) => RouteTarget | undefined;

/** The options of `startHttpServer`. */
export interface HttpOptions {
  /** The address to bind. */
  host: string;
  /** The TCP port; 0 picks a free one. */
  port: number;
  /** Receives the `LogEvent.Listening` line and a `LogEvent.HttpError` per failed request. */
  log: Logger;
}

/** A listening HTTP server and the address it is bound to. */
export interface HttpHandle {
  server: Server;
  /** The host that the server was asked to bind. */
  host: string;
  /** The bound port; the real one when the option was 0. */
  port: number;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const stream: AsyncIterable<Buffer> = req;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * Wraps a server factory as the target of an MCP path.
 *
 * @param factory - builds the MCP server of one new session
 * @param sessions - the open sessions of the path; the caller closes them when the path goes away
 * @returns the `RouteKind.Mcp` target
 * @sideEffects none
 */
export function mcpTarget(factory: ServerFactory, sessions: McpSessions): McpRoute {
  return { kind: RouteKind.Mcp, factory, sessions };
}

/**
 * Makes the route of a single database: `/mcp` serves the 4 tools of that database.
 *
 * @param deps - what each MCP server needs; the write connection is shared by all sessions
 * @param sessions - the sessions of the database; the caller closes them at shutdown
 * @returns a route that answers `/mcp` and nothing else
 * @sideEffects none; each new session later builds an MCP server through `createServer`
 */
export function singleRoute(deps: ServerDeps, sessions: McpSessions): Route {
  return (path) =>
    path === MCP_PATH ? mcpTarget((session) => createServer(deps, undefined, session), sessions) : undefined;
}

/**
 * Joins routes: the first that knows a path answers it.
 *
 * @param routes - the routes to try, in order
 * @returns a route that returns the first defined target, or `undefined` when none knows the path
 * @sideEffects none
 */
export function firstRoute(routes: Route[]): Route {
  return (path) => {
    for (const route of routes) {
      const target = route(path);
      if (target !== undefined) return target;
    }
    return undefined;
  };
}

function sessionHeader(req: IncomingMessage): string | undefined {
  const value = req.headers[SESSION_HEADER];
  return Array.isArray(value) ? value[0] : value;
}

/** The JSON-RPC code of a server error, which the Streamable HTTP spec has a server use for a bad session. */
const JSONRPC_SERVER_ERROR = -32000;

// A JSON-RPC error body, as the Streamable HTTP spec has a server answer a bad session.
function rejectSession(res: ServerResponse, status: number, message: string): void {
  res
    .writeHead(status, { "Content-Type": "application/json" })
    .end(JSON.stringify({ jsonrpc: "2.0", error: { code: JSONRPC_SERVER_ERROR, message }, id: null }));
}

// The `initialize` request creates the transport and the server of a session. The session is registered when the
// transport accepts the request, so a request that it rejects leaves no row.
async function openSession(route: McpRoute, req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
  const handle = route.sessions.create();
  const client: ClientInfo = isInitializeRequest(body) ? body.params.clientInfo : {};
  const server = route.factory(handle);
  const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => handle.id,
    onsessioninitialized: (id) => route.sessions.register(id, { transport, server }, client),
  });
  // A DELETE closes the transport itself; an end by idle or by shutdown has removed the session before it closes.
  transport.onclose = () => void route.sessions.end(handle.id, SessionEndReason.Delete);
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
  if (route.sessions.transport(handle.id) === undefined) {
    await Promise.allSettled([transport.close(), server.close()]);
  }
}

async function handleMcp(route: McpRoute, req: IncomingMessage, res: ServerResponse, log: Logger): Promise<void> {
  if (req.method !== "POST" && req.method !== "DELETE") {
    res.writeHead(STATUS_METHOD_NOT_ALLOWED, { Allow: "POST, DELETE" }).end();
    return;
  }
  try {
    const id = sessionHeader(req);
    if (req.method === "DELETE" && id === undefined) {
      rejectSession(res, STATUS_BAD_REQUEST, "Mcp-Session-Id header is required");
      return;
    }
    const body = req.method === "POST" ? await readBody(req) : undefined;
    if (id === undefined) {
      if (!isInitializeRequest(body)) {
        rejectSession(res, STATUS_BAD_REQUEST, "Mcp-Session-Id header is required");
        return;
      }
      await openSession(route, req, res, body);
      return;
    }
    const transport = route.sessions.transport(id);
    if (transport === undefined) {
      rejectSession(res, STATUS_NOT_FOUND, "Session not found");
      return;
    }
    await transport.handleRequest(req, res, body);
  } catch (e) {
    log({ event: LogEvent.HttpError, level: LogLevel.Error, error: String(e) });
    if (!res.headersSent) res.writeHead(STATUS_BAD_REQUEST).end();
  }
}

// A handler that throws has not answered: the error is logged and the client gets a 500.
async function handleHttp(route: HttpRoute, req: IncomingMessage, res: ServerResponse, log: Logger): Promise<void> {
  try {
    await route.handle(req, res);
  } catch (e) {
    log({ event: LogEvent.HttpError, level: LogLevel.Error, error: String(e) });
    // After the headers went out, the status cannot change; the body still has to end, or the client waits forever.
    if (!res.headersSent) res.writeHead(STATUS_SERVER_ERROR);
    res.end();
  }
}

/**
 * Starts the HTTP server of the MCP endpoints and the console, and logs the address it listens on.
 *
 * @param route - maps a request path to what answers it
 * @param opts - the host, the port and the logger
 * @returns the HTTP server, already listening, with the bound host and port; the caller closes it. A path that the
 *   route does not know gets 404. On an MCP path the `initialize` request opens a session; a request with an unknown
 *   session id gets 404, a request with no session id that is not `initialize` gets 400, a DELETE ends the session,
 *   any other method gets 405 and a body that is not valid JSON gets 400. On a plain handler path the handler answers; when it throws, the client gets 500
 * @throws {Error} when the port cannot be bound
 * @sideEffects binds a TCP port; each `initialize` on an MCP path builds an MCP server and a transport and writes a
 *   `sessions` row; each tool call may open a read connection and write a search, retrieval or queue row; each request on a handler path does what the
 *   handler does; logs through `opts.log`
 */
export async function startHttpServer(route: Route, opts: HttpOptions): Promise<HttpHandle> {
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const target = route(req.url?.split("?")[0] ?? "");
    if (!target) {
      res.writeHead(STATUS_NOT_FOUND).end();
      return;
    }
    switch (target.kind) {
      case RouteKind.Mcp:
        await handleMcp(target, req, res, opts.log);
        break;
      case RouteKind.Http:
        await handleHttp(target, req, res, opts.log);
        break;
    }
  };
  const httpServer = createHttpServer((req, res) => void handle(req, res));
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(opts.port, opts.host, resolve);
  });
  const addr = httpServer.address();
  const port = typeof addr === "object" && addr ? addr.port : opts.port;
  opts.log({ event: LogEvent.Listening, level: LogLevel.Info, transport: "http", host: opts.host, port });
  return { server: httpServer, host: opts.host, port };
}
