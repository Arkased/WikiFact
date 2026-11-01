// technical/console.md, "Architecture", `errors.ts`: a thrown error becomes a status and an error page.
import { ZodError, z } from "zod";
import { ConsoleErrorKind, assertNever } from "../domain/enums.js";
import { errorMessage } from "../must.js";
import { InvalidPageError } from "../store/index.js";
import type { ConsoleDeps } from "./deps.js";
import { layout } from "./html.js";
import { notice } from "./pages/parts/blocks.js";

/** The HTTP status of a bad query. */
const STATUS_BAD_QUERY = 400;
/** The HTTP status of an unknown path, wiki or id. */
export const STATUS_NOT_FOUND = 404;
/** The HTTP status of a refused write. */
const STATUS_REFUSED = 409;
/** The HTTP status of a write while the console's writes are off. */
const STATUS_FORBIDDEN = 403;
/** The HTTP status of any other failure. */
const STATUS_OTHER = 500;

/** A failure of a console request that a page handler throws; the route renders it as an error page. */
export class ConsoleError extends Error {
  readonly kind: ConsoleErrorKind;

  /**
   * Builds the error.
   *
   * @param kind - what went wrong; it decides the status
   * @param message - the text of the error page, for the operator
   * @sideEffects none
   */
  constructor(kind: ConsoleErrorKind, message: string) {
    super(message);
    this.name = "ConsoleError";
    this.kind = kind;
  }
}

/**
 * Gives the HTTP status of an error kind.
 *
 * @param kind - the error kind
 * @returns 400 for a bad query, 403 for forbidden, 404 for not found, 409 for refused, 500 for the rest
 * @sideEffects none
 */
export function statusOf(kind: ConsoleErrorKind): number {
  switch (kind) {
    case ConsoleErrorKind.BadQuery:
      return STATUS_BAD_QUERY;
    case ConsoleErrorKind.NotFound:
      return STATUS_NOT_FOUND;
    case ConsoleErrorKind.Refused:
      return STATUS_REFUSED;
    case ConsoleErrorKind.Forbidden:
      return STATUS_FORBIDDEN;
    case ConsoleErrorKind.Other:
      return STATUS_OTHER;
  }
  return assertNever(kind);
}

/**
 * Maps whatever a page handler threw to a `ConsoleError`.
 *
 * @param e - the thrown value
 * @returns the value itself when it is a `ConsoleError`; a `BadQuery` error with the zod issues as its message for a
 *   `ZodError`, or with the store's message for an `InvalidPageError` (a bad `limit` or `cursor`); else an `Other`
 *   error with the message of the value
 * @sideEffects none
 */
export function toConsoleError(e: unknown): ConsoleError {
  if (e instanceof ConsoleError) return e;
  if (e instanceof ZodError) return new ConsoleError(ConsoleErrorKind.BadQuery, z.prettifyError(e));
  if (e instanceof InvalidPageError) return new ConsoleError(ConsoleErrorKind.BadQuery, e.message);
  return new ConsoleError(ConsoleErrorKind.Other, errorMessage(e));
}

/**
 * Makes the error of an unknown wiki.
 *
 * @param name - the name from the URL
 * @returns a `NotFound` error that names the wiki
 * @sideEffects none
 */
export function unknownWiki(name: string): ConsoleError {
  return new ConsoleError(ConsoleErrorKind.NotFound, `no wiki named "${name}"`);
}

/**
 * Renders the error page.
 *
 * @param deps - for the wiki list of the left bar
 * @param err - the error to show; its message is escaped
 * @param status - the HTTP status, shown as the heading
 * @returns the HTML document
 * @sideEffects reads the wiki list through the deps; a failure of that read leaves the left bar empty
 */
export function errorPage(deps: ConsoleDeps, err: ConsoleError, status: number): string {
  let wikis: string[] = [];
  try {
    wikis = deps.listWikis().map((w) => w.name);
  } catch {
    // The page is about the first error; a second one must not hide it.
  }
  return layout({ title: `Error ${status}`, wikis }, notice(err.message, true));
}
