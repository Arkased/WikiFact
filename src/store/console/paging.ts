// Cursor paging of the console lists (technical/console.md, "Store API additions" and "Routes"). A cursor is the sort key and the id
// of the last row of a page, as base64 of JSON, so a page can be re-read after rows were added.
import { z } from "zod";
import type { Page, PageOptions } from "../types/index.js";

/** The default page size, in rows. */
export const DEFAULT_LIMIT = 50;
/** The largest page, in rows. */
export const MAX_LIMIT = 200;

/** Thrown when `limit` is out of range or a cursor does not decode; the console answers 400. */
export class InvalidPageError extends Error {}

/** The sort key of one row: the value the list sorts by and the row id as the tie-breaker. */
export interface SortKey {
  /** The sort value; null sorts last in either direction. */
  k: number | string | null;
  id: string;
}

const sortKeySchema: z.ZodType<SortKey> = z.object({
  k: z.union([z.number(), z.string(), z.null()]),
  id: z.string(),
});

/**
 * Encodes a sort key as a cursor string.
 *
 * @param key - the key of the last row of a page
 * @returns an opaque string for `PageOptions.cursor`
 * @sideEffects none
 */
export function encodeCursor(key: SortKey): string {
  return Buffer.from(JSON.stringify(key), "utf8").toString("base64url");
}

/**
 * Decodes a cursor string.
 *
 * @param cursor - a string made by `encodeCursor`
 * @returns the sort key it holds
 * @throws {InvalidPageError} when the string is not a cursor
 * @sideEffects none
 */
export function decodeCursor(cursor: string): SortKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new InvalidPageError("the cursor is not valid");
  }
  const res = sortKeySchema.safeParse(parsed);
  if (!res.success) throw new InvalidPageError("the cursor is not valid");
  return res.data;
}

/**
 * Builds the comparator of a list: by `k`, with null last, then by id ascending.
 *
 * @param descending - true when the larger (or later in the alphabet) `k` comes first
 * @returns a comparator for `Array.prototype.sort`
 * @sideEffects none
 */
export function compareKeys(descending: boolean): (a: SortKey, b: SortKey) => number {
  return (a, b) => {
    if (a.k !== b.k) {
      if (a.k === null) return 1;
      if (b.k === null) return -1;
      const less = a.k < b.k;
      return (less ? -1 : 1) * (descending ? -1 : 1);
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };
}

/**
 * Checks a page size.
 *
 * @param limit - the requested size; absent means `DEFAULT_LIMIT`
 * @returns the size to use, 1 to `MAX_LIMIT`
 * @throws {InvalidPageError} when the size is not an integer in 1 to `MAX_LIMIT`
 * @sideEffects none
 */
export function pageLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new InvalidPageError(`limit must be an integer from 1 to ${MAX_LIMIT}`);
  }
  return limit;
}

/**
 * Sorts rows by their key and returns the page after the cursor.
 *
 * @param rows - every row of the list, in any order
 * @param keyOf - the sort key of a row
 * @param compare - the order of the keys, from `compareKeys`
 * @param page - the size and the cursor
 * @returns the page; `next` is the cursor of the following page, null when this is the last one
 * @throws {InvalidPageError} when the limit or the cursor is invalid
 * @sideEffects none
 */
export function pageOf<T>(
  rows: T[],
  keyOf: (row: T) => SortKey,
  compare: (a: SortKey, b: SortKey) => number,
  page: PageOptions,
): Page<T> {
  const limit = pageLimit(page.limit);
  const after = page.cursor === undefined ? undefined : decodeCursor(page.cursor);
  const sorted = [...rows].sort((a, b) => compare(keyOf(a), keyOf(b)));
  const rest = after === undefined ? sorted : sorted.filter((r) => compare(after, keyOf(r)) < 0);
  const items = rest.slice(0, limit);
  const last = items[items.length - 1];
  const next = rest.length > limit && last !== undefined ? encodeCursor(keyOf(last)) : null;
  return { items, next };
}
