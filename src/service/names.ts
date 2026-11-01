// technical/wikis.md, "Management tools of the service": the near-twin rule for wiki names. `creeper` and `creepers` are one subject spelled twice.

/** The names a wiki may have: 1 to 40 lower-case letters, digits and hyphens. */
export const WIKI_NAME_PATTERN = /^[a-z0-9-]{1,40}$/;

/** The suffix that the normal form drops once. */
const PLURAL_SUFFIX = "s";

/**
 * Reduces a wiki name to its normal form: lower case, hyphens removed, one final `s` removed.
 *
 * @param name - a wiki name
 * @returns the normal form; 2 names with the same normal form are twins
 * @sideEffects none
 */
export function normalForm(name: string): string {
  const flat = name.toLowerCase().replaceAll("-", "");
  return flat.endsWith(PLURAL_SUFFIX) ? flat.slice(0, -PLURAL_SUFFIX.length) : flat;
}

/**
 * Finds the existing wiki that a new name would duplicate.
 *
 * @param name - the name to create
 * @param existing - the names of the wikis that exist
 * @returns the first existing name, other than `name` itself, with the same normal form; `undefined` when none
 * @sideEffects none
 */
export function findTwin(name: string, existing: Iterable<string>): string | undefined {
  const form = normalForm(name);
  for (const other of existing) {
    if (other !== name && normalForm(other) === form) return other;
  }
  return undefined;
}
