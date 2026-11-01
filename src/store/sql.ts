/**
 * Builds the placeholders of an `IN (...)` list.
 *
 * @param n - the number of values to bind; at least 1 for a valid statement
 * @returns `n` question marks joined with commas, for example `?,?,?`; the empty string for 0
 * @sideEffects none
 */
export function inList(n: number): string {
  return Array.from({ length: n }, () => "?").join(",");
}
