import { seededRandom } from "../../fakes/stub-consumer.js";

/**
 * Takes a random sample without repeats, in the order drawn.
 *
 * @param items - the population
 * @param n - the sample size; a population smaller than `n` is returned whole (shuffled)
 * @param seed - the seed of the generator; the same seed and population give the same sample
 * @returns the sample
 * @sideEffects none
 */
export function sample<T>(items: T[], n: number, seed: number): T[] {
  const rand = seededRandom(seed);
  const pool = [...items];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const a = pool[i];
    const b = pool[j];
    if (a === undefined || b === undefined) continue;
    pool[i] = b;
    pool[j] = a;
  }
  return pool.slice(0, n);
}
