/**
 * Reads the message of a caught value.
 *
 * @param e - whatever was thrown
 * @returns the message of an Error, else the value as text
 * @sideEffects none
 */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Reads the errno code of a caught value.
 *
 * @param e - whatever was thrown
 * @returns the `code` string of a system error such as `ENOENT`, or undefined when there is none
 * @sideEffects none
 */
export function errnoCode(e: unknown): string | undefined {
  if (typeof e !== "object" || e === null || !("code" in e)) return undefined;
  return typeof e.code === "string" ? e.code : undefined;
}
