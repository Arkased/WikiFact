/** The fraction of the median (the 50th percentile). */
export const P50 = 0.5;

/** The fraction of the 95th percentile. */
export const P95 = 0.95;

/**
 * The p-th percentile of a list by the nearest rank: the value at rank `ceil(p * n)` of the sorted list.
 *
 * @param values - the samples; any order, the function sorts a copy
 * @param p - the fraction in 0..1 (0.95 is the 95th percentile); a value outside the range is clamped to the ends
 * @returns the sample at that rank, or NaN for an empty list
 * @sideEffects none
 */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[rank] ?? Number.NaN;
}

/** The z value of a two-sided 95% interval of the normal distribution. */
const Z_95 = 1.96;

/**
 * The Wilson score interval of a share: the range that holds the true rate of success with the given confidence, for
 * `successes` right answers out of `total`.
 *
 * @param successes - the right answers, 0..total
 * @param total - all answers
 * @param z - the z value of the confidence; default: 95%
 * @returns `[low, high]`, each 0..1; both NaN when there is no answer
 * @sideEffects none
 */
export function wilsonInterval(successes: number, total: number, z: number = Z_95): [number, number] {
  if (total <= 0) return [Number.NaN, Number.NaN];
  const p = successes / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total))) / denominator;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

/**
 * The arithmetic mean of a list.
 *
 * @param values - the samples
 * @returns the mean, or NaN for an empty list
 * @sideEffects none
 */
export function mean(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** The fewest samples with a sample variance. */
const MIN_SAMPLES = 2;

// The square of a number.
const square = (x: number): number => x * x;

/**
 * The sample variance of a list (divisor n - 1).
 *
 * @param values - the samples
 * @returns the variance, or NaN for fewer than 2 samples
 * @sideEffects none
 */
function sampleVariance(values: number[]): number {
  if (values.length < MIN_SAMPLES) return Number.NaN;
  const m = mean(values);
  return values.reduce((sum, v) => sum + square(v - m), 0) / (values.length - 1);
}

/**
 * The 95% Newcombe interval (method 10, the hybrid score interval) of the difference of 2 shares, `p1 - p2`, built from
 * the 2 Wilson intervals of the shares (Newcombe 1998, Statistics in Medicine 17, "Interval estimation for the
 * difference between independent proportions: comparison of eleven methods").
 *
 * @param successes1 - the right answers of the first group, 0..total1
 * @param total1 - all answers of the first group
 * @param successes2 - the right answers of the second group, 0..total2
 * @param total2 - all answers of the second group
 * @returns `[low, high]` of `p1 - p2`, each -1..1; both NaN when a group has no answer
 * @sideEffects none
 */
export function newcombeInterval(
  successes1: number,
  total1: number,
  successes2: number,
  total2: number,
): [number, number] {
  if (total1 <= 0 || total2 <= 0) return [Number.NaN, Number.NaN];
  const p1 = successes1 / total1;
  const p2 = successes2 / total2;
  const [l1, u1] = wilsonInterval(successes1, total1);
  const [l2, u2] = wilsonInterval(successes2, total2);
  const diff = p1 - p2;
  return [diff - Math.sqrt(square(p1 - l1) + square(u2 - p2)), diff + Math.sqrt(square(u1 - p1) + square(p2 - l2))];
}

/**
 * The 95% Welch interval of the difference of 2 means, `mean(first) - mean(second)`: the standard error keeps the 2
 * sample variances apart, and the critical value is the normal 1.96, not the t value of the Welch degrees of freedom, so
 * the interval is a little narrow for very few samples.
 *
 * @param first - the samples of the first group
 * @param second - the samples of the second group
 * @returns `[low, high]` of the difference; both NaN when a group has fewer than 2 samples
 * @sideEffects none
 */
export function welchInterval(first: number[], second: number[]): [number, number] {
  if (first.length < MIN_SAMPLES || second.length < MIN_SAMPLES) return [Number.NaN, Number.NaN];
  const diff = mean(first) - mean(second);
  const half = Z_95 * Math.sqrt(sampleVariance(first) / first.length + sampleVariance(second) / second.length);
  return [diff - half, diff + half];
}

/**
 * Tells whether a difference counts: its interval does not hold 0.
 *
 * @param interval - `[low, high]` of the difference
 * @returns true when the whole interval is above 0 or below 0; false when it holds 0 or is NaN
 * @sideEffects none
 */
export function intervalCounts(interval: [number, number]): boolean {
  const [low, high] = interval;
  return low > 0 || high < 0;
}
