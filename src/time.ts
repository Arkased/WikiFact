/** Milliseconds in a second, for a duration shown or taken in seconds. */
export const MS_PER_SECOND = 1000;

/** A stamp: the ISO time of `stamp()`, with `-` for the `:` of the time part. */
const STAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z$/;

/**
 * The timestamp for a folder or file name: the ISO time with each `:` replaced by `-`, so that the name is valid on
 * Windows.
 *
 * @param date - the time to format; defaults to now
 * @returns for example `2026-10-10T04-07-29.171Z`
 * @sideEffects reads the clock when `date` is omitted
 */
export function stamp(date: Date = new Date()): string {
  return date.toISOString().replace(/:/g, "-");
}

/**
 * Turns a stamp back into an ISO time.
 *
 * @param value - a string made by `stamp`
 * @returns the ISO time, for example `2026-10-10T04:07:29.171Z`; `undefined` when `value` is not a stamp
 * @sideEffects none
 */
export function unstamp(value: string): string | undefined {
  if (!STAMP_PATTERN.test(value)) return undefined;
  return value.replace(/T(\d{2})-(\d{2})-(\d{2})/, "T$1:$2:$3");
}
