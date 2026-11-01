// The contract of a page handler (technical/console.md, "Architecture"): it gets the deps, the path parameters and the query, and
// returns the HTML document, or a file for the export route, or throws a `ConsoleError`.
import type { ConsoleDeps } from "./deps.js";

/** What one page handler gets. */
export interface PageContext {
  deps: ConsoleDeps;
  /** The path parameters by name: `w` for the wiki, `id` or `seq` for the object. */
  params: Record<string, string>;
  /** The query string of the request. */
  query: URLSearchParams;
}

/** A file answer (technical/console.md, "Routes", the export route): the route sends it as an attachment with status 200. */
export interface FileAnswer {
  body: string;
  /** The `Content-Type` header. */
  contentType: string;
  /** The file name of the `Content-Disposition` header. */
  fileName: string;
}

/** What a page handler returns: the HTML document, or a file. */
type PageResult = string | FileAnswer;

/** Renders one page: the HTML document or a file, with status 200. Throws a `ConsoleError` (or a `ZodError`) for anything else. */
export type PageHandler = (ctx: PageContext) => PageResult | Promise<PageResult>;
