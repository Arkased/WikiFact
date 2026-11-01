// technical/console.md, "Signals, settings and interpretations": the settings of the signals as named constants, and the definition of
// each signal, word for word from design/console.md, "The signals".
import { Signal } from "../domain/enums.js";

/**
 * The size of the "recent" span, in searches (design/console.md, "The span of the signals"). It is the size of the labeled
 * sample of the reads test, so the recent span and the test see the same data.
 */
export const SPAN_RECENT_SEARCHES = 200;

// The thresholds of the readings in `interpretations.ts` (design/console.md, "Data and interpretation"). Each is a first guess, to
// move when the data of a real wiki says otherwise.

/** Additions per search over this: the wiki is new, and the agents add more than they find. */
export const STAGE_NEW_MIN = 1.0;

/** Additions per search under this, with the corrections per search at or over the additions: the wiki is mature, and the agents correct more than they add. */
export const STAGE_MATURE_MAX = 0.2;

/** The share of search misses among the change requests after a search over this: the search does not list the facts the wiki has. */
export const SEARCH_MISS_SHARE = 0.2;

/** The exact definition of each signal, as the page shows it 1 click or hover from the number. */
export const SIGNAL_DEFINITIONS: Record<Signal, string> = {
  [Signal.AdditionsPerSearch]:
    "The count of additions divided by the count of searches so far. An addition is a change request that wrote at least 1 fact version that is the first of its fact.",
  [Signal.CorrectionsPerSearch]:
    "The count of corrections divided by the count of searches so far. A correction is a change request that wrote a version of a fact that already had one, or a deletion.",
  [Signal.ReadsPerSearch]:
    "For each search with results, the count of reads that link to it. The share of those searches with 0, 1, 2, and 3 or more reads. A search that returned no result is not in the histogram.",
  [Signal.NoResultSearches]:
    "The count of searches that returned no result (`result_count` 0), out of the count of searches.",
  [Signal.NoReadSearches]:
    "The count of searches with results that led to 0 linked reads, out of the count of searches with results. A read links to a search by the rule of the histogram.",
  [Signal.SearchMisses]:
    "The change requests sent after a search whose target fact the search did not list: a duplicate of an unlisted fact, or a correction of an unlisted fact. A correction of a listed fact is the loop at work and does not count.",
  [Signal.CostPerWrite]:
    "The cost in dollars of all model calls of the worker, divided by the count of change requests that wrote a fact. Also: the share of this cost spent on change requests that wrote nothing. The cost comes from the tokens of each call and the price table of the service; a model with no price counts at $0.",
};
