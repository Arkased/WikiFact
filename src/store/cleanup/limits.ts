// The limits of the cleanup (technical/cleanup.md, "Cleanup", open decision O9). All of them are unmeasured: they are the start values
// until the first cleanup runs on the dogfood wiki say how many candidates each finder finds and what a run costs.
import { CleanupFinder } from "../../domain/enums.js";
import { HALF } from "../../constants.js";

/**
 * The most `cleanupRepair` requests one cleanup run queues for each finder, in requests (O9, unmeasured).
 */
export const CLEANUP_CAP = 20;

/**
 * The start interval of each finder, in writes: the seed of `meta.cleanup_every`, which `nextInterval` then moves after each run
 * (O9, from the base rates of the rebuild of October 13, 2026; the live wiki showed them off, October 16, 2026).
 */
export const CLEANUP_EVERY: Record<CleanupFinder, number> = {
  [CleanupFinder.DuplicateFact]: 50,
};

/** The shortest interval of a finder, in writes: the floor of `nextInterval` (design/cleanup.md, "Interval per check"). */
export const CLEANUP_EVERY_MIN = 10;

/** The longest interval of a finder, in writes: the ceiling of `nextInterval`, so a quiet finder still runs now and then. */
export const CLEANUP_EVERY_MAX = 2000;

/** A run with this many repairs or more shortens the interval, in repairs; a run with none lengthens it. */
export const REPAIRS_TO_SHORTEN = 3;

/** The factor by which a run with no repair lengthens the interval of a finder. */
const GROWTH_FACTOR = 2;

/**
 * The interval after a run, from the repairs of that run: no repair doubles it, `REPAIRS_TO_SHORTEN` or more halve
 * it, 1 or 2 keep it, within `CLEANUP_EVERY_MIN` and `CLEANUP_EVERY_MAX`.
 *
 * @param current - the interval of the finder before the run, in writes
 * @param repairs - the `cleanupRepair` requests of the run that ended with a written change
 * @returns the next interval, in writes, whole and within the floor and the ceiling
 * @sideEffects none
 */
export function nextInterval(current: number, repairs: number): number {
  let next = current;
  if (repairs === 0) next = current * GROWTH_FACTOR;
  else if (repairs >= REPAIRS_TO_SHORTEN) next = Math.floor(current / HALF);
  return Math.min(CLEANUP_EVERY_MAX, Math.max(CLEANUP_EVERY_MIN, next));
}

/** The finders in run order (the order of the enum). */
export const CLEANUP_FINDERS: CleanupFinder[] = Object.values(CleanupFinder);

/** The duplicate fact finder compares each live fact with this many nearest facts, in facts. */
export const DUPLICATE_FACT_NEIGHBORS = 3;

/** The limits that `cleanupCandidates` takes; a test sets them small. */
export interface CleanupLimits {
  /** The most candidates of one finder in the result. */
  cap: number;
  /** The nearest facts of each fact, for the duplicate fact finder. */
  duplicateFactNeighbors: number;
}

/** The limits of technical/cleanup.md, "Cleanup" and O9. */
export const DEFAULT_CLEANUP_LIMITS: CleanupLimits = {
  cap: CLEANUP_CAP,
  duplicateFactNeighbors: DUPLICATE_FACT_NEIGHBORS,
};
