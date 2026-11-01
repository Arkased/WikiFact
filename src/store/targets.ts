// The `change_requests.targets` column: a JSON array of ids, parsed at every read site with one schema.
import { z } from "zod";

const targetsSchema = z.array(z.string());

/**
 * Parses the `targets` column of a `change_requests` row.
 *
 * @param json - the stored JSON text
 * @returns the ids, in stored order; empty for `[]`
 * @throws {Error} when the text is not a JSON array of strings
 * @sideEffects none
 */
export function parseTargets(json: string): string[] {
  const parsed = targetsSchema.safeParse(JSON.parse(json));
  if (!parsed.success) throw new Error(`change_requests.targets is not a JSON array of ids: ${json}`);
  return parsed.data;
}
