// Time buckets of the console series (technical/console.md, "Pulse" and "Store API additions"). Days and hours are UTC. The day
// width is `DAY_MS` of `types/config.ts`.

/** One hour, in ms. */
export const HOUR_MS = 60 * 60 * 1000;

/**
 * Rounds a time down to the start of its bucket.
 *
 * @param t - a time, in ms since the epoch
 * @param width - the bucket width, in ms (`DAY_MS` or `HOUR_MS`)
 * @returns the largest multiple of `width` at or before `t`
 * @sideEffects none
 */
export function bucketStart(t: number, width: number): number {
  return Math.floor(t / width) * width;
}

/**
 * Lists the bucket starts that cover a window.
 *
 * @param from - the start of the window, in ms since the epoch, inclusive
 * @param to - the end of the window, in ms since the epoch, exclusive
 * @param width - the bucket width, in ms
 * @returns the starts, ascending; empty when `to` is not after `from`
 * @sideEffects none
 */
export function bucketStarts(from: number, to: number, width: number): number[] {
  const out: number[] = [];
  if (to <= from) return out;
  for (let s = bucketStart(from, width); s < to; s += width) out.push(s);
  return out;
}

/** The fraction of the sample that the 95th percentile covers. */
const P95_RANK = 0.95;

/**
 * The 95th percentile of a sample by the nearest-rank method.
 *
 * @param values - the sample, in any order; may be empty
 * @returns the value at rank `ceil(0.95 * n)`, or undefined for an empty sample
 * @sideEffects none
 */
export function p95(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(P95_RANK * sorted.length) - 1)];
}

/**
 * The mean of a sample.
 *
 * @param values - the sample
 * @returns the mean, or undefined for an empty sample
 * @sideEffects none
 */
export function mean(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  return values.reduce((a, b) => a + b, 0) / values.length;
}
