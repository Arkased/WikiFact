// The query of a page (technical/console.md, "Routes"): the parser and its field types, the URL with some parameters changed, and the
// table controls that write the sort and the cursor into it.
import { z } from "zod";
import { html, type SafeHtml, type SortHeader } from "../../html.js";

/**
 * Parses the query string with a zod schema. An empty value, as a blank field of a GET form sends, counts as absent.
 *
 * @param query - the query of the request
 * @param schema - the schema of the page's parameters
 * @returns the parsed query
 * @throws {ZodError} when a parameter does not validate; the route answers 400
 * @sideEffects none
 */
export function parseQuery<S extends z.ZodType>(query: URLSearchParams, schema: S): z.infer<S> {
  const raw: Record<string, string> = {};
  for (const [k, v] of query) if (v !== "") raw[k] = v;
  return schema.parse(raw);
}

/** A query flag: `1` is on, anything else is off. */
export const flag = z
  .string()
  .optional()
  .transform((v) => v === "1");

/** An integer from the query. */
export const queryInt = z.coerce.number().int();

/**
 * A time from the query: unix milliseconds, or a date that `Date.parse` reads (`2026-10-11`, `2026-10-11T08:00`).
 * The value is in ms since the epoch.
 */
export const queryTime: z.ZodType<number, string> = z.string().transform((s, ctx) => {
  const text = s.trim();
  const n = /^\d+$/.test(text) ? Number(text) : Date.parse(text);
  if (Number.isNaN(n)) ctx.addIssue({ code: "custom", message: `"${s}" is not a time` });
  return n;
});

/**
 * Builds the URL of the current page with some parameters changed.
 *
 * @param query - the query of the request
 * @param set - the parameters to set; `undefined` removes one
 * @returns `?a=b&c=d`; `?` alone when nothing is left
 * @sideEffects none
 */
export function hrefWith(query: URLSearchParams, set: Record<string, string | undefined>): string {
  const next = new URLSearchParams(query);
  for (const [k, v] of Object.entries(set)) {
    if (v === undefined) next.delete(k);
    else next.set(k, v);
  }
  return `?${next.toString()}`;
}

/**
 * Describes a table header that sets the sort of the list in the URL (technical/console.md, "Routes"); `table` renders it.
 *
 * @param query - the query of the request
 * @param by - the `sort` value this column stands for
 * @param label - the column label
 * @param current - the sort in force; the header of that column is marked
 * @returns the header; its link drops the cursor, because a new sort starts at the first page
 * @sideEffects none
 */
export function sortHeader(query: URLSearchParams, by: string, label: string, current: string): SortHeader {
  return { label, href: hrefWith(query, { sort: by, cursor: undefined }), sorted: by === current };
}

/**
 * Renders the paging control of a list (technical/console.md, "Parts").
 *
 * @param query - the query of the request
 * @param next - the cursor of the next page, null at the end
 * @returns the `nav.paging` with an `a.button`, or null at the end
 * @sideEffects none
 */
export function paging(query: URLSearchParams, next: string | null): SafeHtml | null {
  if (next === null) return null;
  return html`<nav class="paging"><a class="button" href="${hrefWith(query, { cursor: next })}">Next page</a></nav>`;
}
