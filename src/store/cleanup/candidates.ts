import { CleanupFinder, RequestKind, RequestStatus } from "../../domain/enums.js";
import { parseCleanupRepair, cleanupRepairKey, type Store, type CleanupRepair } from "../types/index.js";
import { findDuplicateFacts } from "./duplicate-facts.js";
import { CLEANUP_FINDERS, DEFAULT_CLEANUP_LIMITS, type CleanupLimits } from "./limits.js";

// The keys of the candidates that a queued or running `cleanupRepair` request holds. A row whose document does not parse
// holds nothing: the worker rejects it.
function heldKeys(store: Store): Set<string> {
  const rows = store.db
    .prepare("SELECT change FROM change_requests WHERE kind = ? AND status IN (?, ?)")
    .all(RequestKind.CleanupRepair, RequestStatus.Queued, RequestStatus.Running) as { change: string | null }[];
  const keys = new Set<string>();
  for (const r of rows) {
    try {
      if (r.change !== null) keys.add(cleanupRepairKey(parseCleanupRepair(r.change)));
    } catch {
      // not a valid candidate: nothing to hold
    }
  }
  return keys;
}

/** The result of `cleanupCandidates`. */
export interface CleanupCandidates {
  /** At most `limits.cap` candidates of each run finder, in finder order. */
  candidates: CleanupRepair[];
  /** The finders that had a candidate their own cap kept out, in finder order. */
  cut: CleanupFinder[];
}

/**
 * design/cleanup.md, "Approach". Finds the cleanup candidates of the given finders, in finder order (the duplicate fact
 * finder is the only one), each in its own rank order. It leaves out a candidate that `cleanup_verdicts` still covers
 * and one that a queued or running `cleanupRepair` request holds, and takes at most `limits.cap` of each finder (a finder
 * over its cap does not take the place of the next one). No model call, no write.
 *
 * @param store - the open store
 * @param limits - the limits of design/cleanup.md, "Cap per check" to override; an absent member takes its default (O9)
 * @param only - the finders to run; all by default. They run in finder order whatever the order given
 * @returns the candidates (at most `limits.cap` of each run finder; empty when the wiki has nothing to repair) and the
 *   finders that their own cap cut
 * @sideEffects none (reads)
 */
export function cleanupCandidates(
  store: Store,
  limits: Partial<CleanupLimits> = {},
  only: CleanupFinder[] = CLEANUP_FINDERS,
): CleanupCandidates {
  const lim: CleanupLimits = { ...DEFAULT_CLEANUP_LIMITS, ...limits };
  const held = heldKeys(store);
  const candidates: CleanupRepair[] = [];
  const cut: CleanupFinder[] = [];
  const finders: Record<CleanupFinder, () => CleanupRepair[]> = {
    [CleanupFinder.DuplicateFact]: () => findDuplicateFacts(store, lim),
  };
  for (const finder of CLEANUP_FINDERS) {
    if (!only.includes(finder)) continue;
    let taken = 0;
    for (const c of finders[finder]()) {
      if (held.has(cleanupRepairKey(c))) continue;
      if (taken >= lim.cap) {
        cut.push(finder);
        break;
      }
      candidates.push(c);
      taken++;
    }
  }
  return { candidates, cut };
}
