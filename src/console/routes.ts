// technical/console.md, "Architecture", `routes.ts`: maps `/console/*` to the page handlers. A table of path templates, no framework.
// It plugs into the `Route` of `src/mcp/http.ts` as its plain-handler case (technical/console.md, "Mount in the service").
import { readFileSync } from "node:fs";
import type { IncomingMessage, OutgoingHttpHeaders } from "node:http";
import { ConsoleErrorKind, ConsoleSection, LogEvent, LogLevel, RouteKind } from "../domain/enums.js";
import type { Route, RequestHandler } from "../mcp/http.js";
import type { ConsoleDeps } from "./deps.js";
import { ConsoleError, STATUS_NOT_FOUND, errorPage, statusOf, toConsoleError } from "./errors.js";
import { CONSOLE_PREFIX, SCRIPT_PATH } from "./html.js";
import type { PageHandler } from "./page.js";
import { handlePost } from "./post.js";
import { matchTemplate } from "./template.js";
import { exportPage } from "./pages/export.js";
import { factPage } from "./pages/fact.js";
import { healthPage } from "./pages/health.js";
import { JOBS_ANCHOR } from "./pages/jobs.js";
import { requestPage } from "./pages/request.js";
import { requestsPage } from "./pages/requests.js";
import { searchPage } from "./pages/search.js";
import { settingsPage } from "./pages/settings.js";
import { overviewPage } from "./pages/overview.js";
import { wikisPage } from "./pages/wikis.js";
import { STYLE_PATH, STYLE_SHEET } from "./style.js";

const STATUS_OK = 200;
const STATUS_MOVED = 301;
const STATUS_SEE_OTHER = 303;
const STATUS_METHOD_NOT_ALLOWED = 405;
const HTML_TYPE = "text/html; charset=utf-8";
const CSS_TYPE = "text/css; charset=utf-8";
const JS_TYPE = "text/javascript; charset=utf-8";
/** The built script, next to this module in `dist/` (technical/console.md, "Code layout and build"); a run from source has no such file. */
const SCRIPT_FILE = new URL("./client/console.js", import.meta.url);

/** The path of the old page "Jobs", which answers 303 to the section "Jobs" of the Operation page. */
const JOBS_TEMPLATE = `/console/w/:w/${ConsoleSection.Jobs}`;

/** The options of `consoleRoute`. */
export interface ConsoleRouteOptions {
  /** The script file to serve in place of the built one; a path that does not exist makes the script route 404. */
  scriptFile?: string;
}

/** One row of the route table:a path template and the handler of the page. */
interface PageRoute {
  /** The path with `:name` for a parameter segment. */
  template: string;
  page: PageHandler;
}

/** The pages of technical/console.md, "Routes", in match order: a fixed segment wins over a parameter at the same place. */
const PAGES: PageRoute[] = [
  { template: "/console/", page: wikisPage },
  { template: "/console/w/:w", page: overviewPage },
  { template: `/console/w/:w/${ConsoleSection.Health}`, page: healthPage },
  { template: "/console/w/:w/search", page: searchPage },
  { template: "/console/w/:w/facts/export", page: exportPage },
  { template: "/console/w/:w/facts/:id", page: factPage },
  { template: "/console/w/:w/requests", page: requestsPage },
  { template: "/console/w/:w/requests/:id", page: requestPage },
  { template: "/console/w/:w/settings", page: settingsPage },
];

/** A matched page and the values of its path parameters. */
export interface PageMatch {
  page: PageHandler;
  params: Record<string, string>;
}

/**
 * Finds the page of a path.
 *
 * @param path - the request path without the query
 * @returns the handler and the parameters, or `undefined` when no template matches
 * @sideEffects none
 */
export function matchConsolePath(path: string): PageMatch | undefined {
  for (const route of PAGES) {
    const params = matchTemplate(route.template, path);
    if (params !== undefined) return { page: route.page, params };
  }
  return undefined;
}

/** What one request ends with. */
interface Answer {
  status: number;
  headers: OutgoingHttpHeaders;
  body: string;
  /** The message of a failure that is not the operator's: it goes to the log line. */
  error?: string;
}

function failure(deps: ConsoleDeps, e: unknown): Answer {
  const err = toConsoleError(e);
  const status = statusOf(err.kind);
  return {
    status,
    headers: { "Content-Type": HTML_TYPE },
    body: errorPage(deps, err, status),
    ...(err.kind === ConsoleErrorKind.Other ? { error: err.message } : {}),
  };
}

// A POST on a write route (technical/console.md, "Rules for phase 2"): the preview page, or a 303 to the page the write changed. A POST on any
// other path falls through to the 405 below.
async function answerPost(deps: ConsoleDeps, req: IncomingMessage, path: string): Promise<Answer | undefined> {
  try {
    const posted = await handlePost(deps, req, path);
    if (posted === undefined) return undefined;
    if ("location" in posted) return { status: STATUS_SEE_OTHER, headers: { Location: posted.location }, body: "" };
    return { status: STATUS_OK, headers: { "Content-Type": HTML_TYPE }, body: posted.html };
  } catch (e) {
    return failure(deps, e);
  }
}

// The text of the built script, or undefined in a run from source where `tsc` has not built it.
function readScript(file: string | URL): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch (e) {
    if (e instanceof Error && "code" in e && e.code === "ENOENT") return undefined;
    throw e;
  }
}

async function answer(deps: ConsoleDeps, req: IncomingMessage, url: URL, script: string | undefined): Promise<Answer> {
  const path = url.pathname;
  if (req.method === "POST") {
    const posted = await answerPost(deps, req, path);
    if (posted !== undefined) return posted;
  }
  if (req.method !== "GET") return { status: STATUS_METHOD_NOT_ALLOWED, headers: { Allow: "GET" }, body: "" };
  if (path === CONSOLE_PREFIX.slice(0, -1))
    return { status: STATUS_MOVED, headers: { Location: CONSOLE_PREFIX }, body: "" };
  if (path === STYLE_PATH) return { status: STATUS_OK, headers: { "Content-Type": CSS_TYPE }, body: STYLE_SHEET };
  if (path === SCRIPT_PATH)
    return script === undefined
      ? { status: STATUS_NOT_FOUND, headers: {}, body: "" }
      : { status: STATUS_OK, headers: { "Content-Type": JS_TYPE }, body: script };
  // The page "Jobs" is the last section of the Operation page (technical/console.md, "Jobs"): the old address leads there.
  const jobs = matchTemplate(JOBS_TEMPLATE, path);
  if (jobs !== undefined) {
    return {
      status: STATUS_SEE_OTHER,
      headers: { Location: `${CONSOLE_PREFIX}w/${jobs.w}/${ConsoleSection.Health}#${JOBS_ANCHOR}` },
      body: "",
    };
  }
  try {
    const match = matchConsolePath(path);
    if (match === undefined) throw new ConsoleError(ConsoleErrorKind.NotFound, `no page at ${path}`);
    const result = await match.page({ deps, params: match.params, query: url.searchParams });
    if (typeof result === "string") return { status: STATUS_OK, headers: { "Content-Type": HTML_TYPE }, body: result };
    // The export route answers with a file, not a page (technical/console.md, "Routes").
    return {
      status: STATUS_OK,
      headers: {
        "Content-Type": result.contentType,
        "Content-Disposition": `attachment; filename="${result.fileName}"`,
      },
      body: result.body,
    };
  } catch (e) {
    return failure(deps, e);
  }
}

/**
 * Makes the route of the console: every path under `/console/`, and `/console` itself.
 *
 * @param deps - the wikis and the service facts the pages read
 * @param opts - `scriptFile`: the path of the script to serve; default the built `client/console.js` next to this module
 * @returns a route whose handler answers GET with a page, the style sheet, the script (404 when the build has not
 *   produced it), or an error page (404 for an unknown path or wiki), 301 for `/console` without the slash, POST on a write route (technical/console.md, "Rules for phase 2") with the preview page
 *   (200), a 303 redirect, or an error page (400, 403, 404, 409), and 405 for any other method; `undefined` for a
 *   path outside the prefix
 * @sideEffects reads the built script file once; the handler logs one `LogEvent.ConsolePage` line per request (level `error` on a 500, else `info`)
 *   and does what the page or the write does
 */
export function consoleRoute(deps: ConsoleDeps, opts: ConsoleRouteOptions = {}): Route {
  const script = readScript(opts.scriptFile ?? SCRIPT_FILE);
  const handle: RequestHandler = async (req, res) => {
    const t0 = performance.now();
    // The origin is not used: only the path and the query of the request line matter.
    const url = new URL(req.url ?? "/", "http://console");
    const out = await answer(deps, req, url, script);
    res.writeHead(out.status, out.headers).end(out.body);
    // A 500 is a failed request (technical/deployment.md, "Logging"); every other answer, a 404 included, is the operator's doing.
    deps.log({
      event: LogEvent.ConsolePage,
      level: out.error === undefined ? LogLevel.Info : LogLevel.Error,
      path: url.pathname,
      status: out.status,
      durationMs: Math.round(performance.now() - t0),
      ...(out.error === undefined ? {} : { error: out.error }),
    });
  };
  const bare = CONSOLE_PREFIX.slice(0, -1);
  return (path) => (path === bare || path.startsWith(CONSOLE_PREFIX) ? { kind: RouteKind.Http, handle } : undefined);
}
