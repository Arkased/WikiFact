// technical/console.md, "The list of interpretations": the only place that holds an interpretation, 1 entry per row of the table in
// design/console.md, "Data and interpretation". An entry reads the current numbers and says 1 sentence about them, or `null` when the
// data cannot say anything. A test result changes 1 entry: its `status`, in the same change that holds the result. An entry whose
// test fails is deleted; the signal and its definition stay.
import { HealthLevel, InterpretationId, InterpretationStatus, Signal } from "../domain/enums.js";
import type { GrowthStretch, SearchMisses } from "../store/index.js";
import { SEARCH_MISS_SHARE, STAGE_MATURE_MAX, STAGE_NEW_MIN } from "./signals.js";

/** The current numbers that the readings read. A block gives the numbers it shows; an entry whose number is missing says nothing. */
export interface InterpretationData {
  /** The additions, the corrections and the searches over all searches. */
  stage?: Pick<GrowthStretch, "searches" | "additions" | "corrections">;
  /** The search misses over the span. */
  misses?: SearchMisses;
}

/** What someone says a signal means, with how sure the saying is. */
export interface Interpretation {
  id: InterpretationId;
  /** The signal that the interpretation reads. */
  of: Signal;
  /** The sentence about the current data, or `null` when the data cannot say anything. */
  read: (data: InterpretationData) => string | null;
  status: InterpretationStatus;
  /** The name of the test and its section in the design; `null` while no test exists. A `Tested` entry has one. */
  test: string | null;
}

// A reading leads with a verdict word, then says what the data means for the operator. The number stays out: the stat shows it.

function readStage(data: InterpretationData): string | null {
  const stage = data.stage;
  if (stage === undefined || stage.searches === 0) return null;
  const a = stage.additions / stage.searches;
  const c = stage.corrections / stage.searches;
  if (a > STAGE_NEW_MIN)
    return "Growing fast. Agents add far more than they find: quality should rise as the gaps fill.";
  if (a < STAGE_MATURE_MAX && c >= a)
    return "Mature. Agents correct more than they add: quality holds, and the wiki has what they search for.";
  return "Growing. Agents add and correct in step: quality should rise slowly.";
}

// The level of the number of each signal that has a reading rule: the color on the page and the verdict word of the reading both come
// from the same function, so they never disagree. Each takes the count and the divisor (above 0) of the share the stat shows.

/**
 * The level of "Facts the search missed": failing over `SEARCH_MISS_SHARE`, else ok.
 *
 * @param missed - the change requests that the search missed
 * @param afterSearch - the change requests sent after a search, above 0
 * @returns `Red` over the threshold, `Green` at or under it
 * @sideEffects none
 */
export function searchMissLevel(missed: number, afterSearch: number): HealthLevel {
  return missed / afterSearch > SEARCH_MISS_SHARE ? HealthLevel.Red : HealthLevel.Green;
}

/**
 * The level of "Searches with no result": ok at 0, warning over 0.
 *
 * @param noResult - the searches that returned no result
 * @returns `Green` at 0, else `Yellow`
 * @sideEffects none
 */
export function noResultLevel(noResult: number): HealthLevel {
  return noResult === 0 ? HealthLevel.Green : HealthLevel.Yellow;
}

function readPoorSearches(data: InterpretationData): string | null {
  const misses = data.misses;
  if (misses === undefined || misses.afterSearch === 0) return null;
  if (searchMissLevel(misses.missed, misses.afterSearch) === HealthLevel.Red)
    return "Poor. The search misses facts the wiki has, and agents find them another way.";
  return "Good. The search finds the facts the wiki has.";
}

/** Every interpretation the console shows, in the order of design/console.md, "Data and interpretation". */
export const INTERPRETATIONS: readonly Interpretation[] = [
  {
    id: InterpretationId.Stage,
    of: Signal.AdditionsPerSearch,
    read: readStage,
    status: InterpretationStatus.Assumed,
    test: null,
  },
  {
    id: InterpretationId.PoorSearches,
    of: Signal.SearchMisses,
    read: readPoorSearches,
    status: InterpretationStatus.Assumed,
    test: null,
  },
];
