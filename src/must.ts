/** A value the pipeline relies on is missing: a broken invariant, not bad input. */
export class InvariantError extends Error {
  /**
   * Builds the error.
   *
   * @param message - what was expected and not found
   * @sideEffects none
   */
  constructor(message: string) {
    super(message);
    this.name = "InvariantError";
  }
}

/**
 * Returns the value, or throws when it is null or undefined.
 *
 * @param value - the value that must be present
 * @param message - what the caller expected, for the error
 * @returns the value, narrowed to not null and not undefined
 * @throws {InvariantError} with `message` when the value is null or undefined (0, "" and false pass)
 * @sideEffects none
 */
export function must<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new InvariantError(message);
  return value;
}

/**
 * Returns the value of a model answer, or throws a plain error when it is null or undefined. The next attempt asks the
 * model again, so this is a failed attempt and not an `InvariantError`.
 *
 * @param value - the part of a model answer that must be present
 * @param message - what the caller expected, for the error
 * @returns the value, narrowed to not null and not undefined
 * @throws {Error} with `message` when the value is null or undefined
 * @sideEffects none
 */
export function mustFromModel<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

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
 * @returns the `code` string of a system error such as `EEXIST`, or undefined when there is none
 * @sideEffects none
 */
export function errnoCode(e: unknown): string | undefined {
  if (typeof e !== "object" || e === null || !("code" in e)) return undefined;
  return typeof e.code === "string" ? e.code : undefined;
}
