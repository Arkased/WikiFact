/**
 * Returns x, or throws when it is null or undefined.
 *
 * @param x - the value to check
 * @returns x, narrowed
 * @throws {Error} when x is null or undefined
 * @sideEffects none
 */
export function must<T>(x: T | undefined | null): T {
  if (x === undefined || x === null) throw new Error("expected a value");
  return x;
}
