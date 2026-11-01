import { SearchStep } from "../../src/domain/index.js";
import { profileSearch, type Store } from "../../src/store/index.js";
import { P95, mean, percentile } from "../lib/stats.js";

/** The decimals of the milliseconds in the profile. */
const MS_DECIMALS = 2;

/** The mean and the 95th percentile of one step, in ms. */
interface StepTiming {
  mean_ms: number;
  p95_ms: number;
}

/** The timing of every step. */
export type Profile = Record<SearchStep, StepTiming>;

/**
 * Times each step of the consumer search alone, over the same queries.
 *
 * @param store - the open store
 * @param queries - the queries to run
 * @returns the mean and p95 per step
 * @sideEffects runs the store profile and the embedder on the store; reads the clock
 */
export async function runProfile(store: Store, queries: string[]): Promise<Profile> {
  const acc: Record<SearchStep, number[]> = {
    [SearchStep.Embed]: [],
    [SearchStep.FtsFacts]: [],
    [SearchStep.KnnFacts]: [],
    [SearchStep.Total]: [],
  };
  for (const q of queries) {
    const timings = await profileSearch(store, q);
    for (const step of Object.values(SearchStep)) acc[step].push(timings[step]);
  }
  const out = {} as Profile;
  for (const step of Object.values(SearchStep)) {
    const xs = [...acc[step]].sort((a, b) => a - b);
    out[step] = {
      mean_ms: Number(mean(xs).toFixed(MS_DECIMALS)),
      p95_ms: Number(percentile(xs, P95).toFixed(MS_DECIMALS)),
    };
  }
  return out;
}
