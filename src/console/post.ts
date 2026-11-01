// technical/console.md, "Rules for phase 2": the POST side of the route. It matches the write routes, checks that writes are on, reads the form
// body under a cap, and hands the form to the route's handler.
import type { IncomingMessage } from "node:http";
import { ConsoleErrorKind } from "../domain/enums.js";
import { ACTION_ROUTES } from "./actions.js";
import { originRefusal, writesAllowed } from "./auth.js";
import type { ConsoleDeps } from "./deps.js";
import { ConsoleError } from "./errors.js";
import { SETTINGS_ROUTES } from "./settings.js";
import { matchTemplate } from "./template.js";
import type { WriteAnswer, WriteRoute } from "./write.js";

/** The largest form body the console reads, in bytes. A larger one is a 400. */
export const MAX_FORM_BYTES = 64 * 1024;

const FORM_TYPE = "application/x-www-form-urlencoded";

const WRITE_ROUTES: WriteRoute[] = [...ACTION_ROUTES, ...SETTINGS_ROUTES];

/** A matched write route and the values of its path parameters. */
export interface WriteMatch {
  route: WriteRoute;
  params: Record<string, string>;
}

/**
 * Finds the write route of a path.
 *
 * @param path - the request path without the query
 * @returns the route and its parameters, or `undefined` when no write route has this path
 * @sideEffects none
 */
export function matchWriteRoute(path: string): WriteMatch | undefined {
  for (const route of WRITE_ROUTES) {
    const params = matchTemplate(route.template, path);
    if (params !== undefined) return { route, params };
  }
  return undefined;
}

/**
 * Reads a form body.
 *
 * @param req - the request; its `Content-Type` must be `application/x-www-form-urlencoded`
 * @returns the parsed fields
 * @throws {ConsoleError} `BadQuery` for another content type or a body over `MAX_FORM_BYTES`
 * @sideEffects reads the request stream to its end; a body over the cap is read and dropped
 */
function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const type = req.headers["content-type"] ?? "";
  if (!type.toLowerCase().startsWith(FORM_TYPE)) {
    return Promise.reject(new ConsoleError(ConsoleErrorKind.BadQuery, `a form must be sent as ${FORM_TYPE}`));
  }
  const tooLarge = new ConsoleError(ConsoleErrorKind.BadQuery, `the form is over ${MAX_FORM_BYTES / 1024} KB`);
  if (Number(req.headers["content-length"] ?? 0) > MAX_FORM_BYTES) return Promise.reject(tooLarge);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_FORM_BYTES) chunks.push(chunk);
      else reject(tooLarge);
    });
    req.on("end", () => resolve(new URLSearchParams(Buffer.concat(chunks).toString("utf8"))));
    req.on("error", reject);
  });
}

/**
 * Answers a POST on a write route.
 *
 * @param deps - the console deps; the service facts decide the origin check and whether writes are on
 * @param req - the POST request; its `Origin` and `Sec-Fetch-Site` headers and its form body are read
 * @param path - the request path without the query
 * @returns the preview page or the redirect; `undefined` when no write route has this path
 * @throws {ConsoleError} `Forbidden` for a cross-site request (technical/console.md, "Authentication"), or when writes are off (deployed
 *   mode, or a host that is not the loopback); `BadQuery` for a body that is not a valid form; `NotFound` or
 *   `Refused` from the route
 * @sideEffects reads the request body; does what the route does
 */
export async function handlePost(
  deps: ConsoleDeps,
  req: IncomingMessage,
  path: string,
): Promise<WriteAnswer | undefined> {
  const match = matchWriteRoute(path);
  if (match === undefined) return undefined;
  const refusal = originRefusal(deps.service(), req.headers);
  if (refusal !== undefined) throw new ConsoleError(ConsoleErrorKind.Forbidden, refusal);
  if (!writesAllowed(deps.service())) {
    throw new ConsoleError(
      ConsoleErrorKind.Forbidden,
      'writes are off: the console writes only in local mode on the loopback (technical/console.md, "Authentication")',
    );
  }
  const form = await readForm(req);
  return match.route.handle({ deps, params: match.params }, form);
}
