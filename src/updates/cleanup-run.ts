// The run of the cleanup (technical/cleanup.md, "Cleanup"): finds the candidates and queues one `cleanupRepair` request for each. No model
// question runs here; the questions run when the worker takes the requests.
import { CleanupFinder, LogEvent, LogLevel } from "../domain/enums.js";
import type { Logger } from "../log/index.js";
import {
  CLEANUP_FINDERS,
  cleanupCandidates,
  countRepairs,
  countWritesSince,
  enqueueCleanupRepairs,
  hasOpenRepairs,
  highestChangeSeq,
  nextInterval,
  readCleanupEvery,
  readCleanupFull,
  readCleanupPending,
  readCleanupSeq,
  REPAIRS_TO_SHORTEN,
  writeCleanupEvery,
  writeCleanupFull,
  writeCleanupPending,
  writeCleanupSeq,
  type CleanupSeqs,
  type Store,
} from "../store/index.js";

// The seq of every finder set to one value.
function allSeqs(seq: number): CleanupSeqs {
  return Object.fromEntries(CLEANUP_FINDERS.map((f) => [f, seq])) as CleanupSeqs;
}

/**
 * Runs the given finders and queues up to `CLEANUP_CAP` `cleanupRepair` requests for each finder, in finder order. It first writes the
 * highest `seq` to `meta.cleanup_seq` for those finders, so a finder that throws waits for its next interval, or for
 * the next write when `meta.cleanup_full` still holds it. Last it writes `meta.cleanup_full`: the entries of the
 * finders that did not run, and the run finders that their own cap cut.
 *
 * @param store - the open store with the write connection
 * @param now - the time of the run and the receive time of the requests, in ms since the epoch
 * @param log - receives the `cleanup_run` line
 * @param finders - the finders to run
 * @returns the number of requests queued
 * @sideEffects writes `meta.cleanup_seq`, `meta.cleanup_full` and `meta.cleanup_pending` (the run finders); reads the store for the finders; one insert per
 *   request in one transaction; logs one `LogEvent.CleanupRun` line with the finders that ran and the count per finder
 */
export function runCleanup(store: Store, now: number, log: Logger, finders: CleanupFinder[]): number {
  const highest = highestChangeSeq(store);
  const ran = CLEANUP_FINDERS.filter((f) => finders.includes(f));
  const seqs = readCleanupSeq(store) ?? allSeqs(highest);
  for (const f of ran) seqs[f] = highest;
  writeCleanupSeq(store, seqs);
  const oldFull = readCleanupFull(store);
  const { candidates, cut } = cleanupCandidates(store, {}, ran);
  writeCleanupFull(store, [...CLEANUP_FINDERS.filter((f) => oldFull.includes(f) && !ran.includes(f)), ...cut]);
  const pending = readCleanupPending(store);
  writeCleanupPending(
    store,
    CLEANUP_FINDERS.filter((f) => pending.includes(f) || ran.includes(f)),
  );
  enqueueCleanupRepairs(store, candidates, now);
  const queued = { [CleanupFinder.DuplicateFact]: 0 };
  for (const c of candidates) queued[c.finder]++;
  log({ event: LogEvent.CleanupRun, level: LogLevel.Info, finders: ran, queued });
  return candidates.length;
}

/**
 * Sets the next interval of each pending finder whose `cleanupRepair` requests have all ended (none `queued` or `running`), from
 * the repairs of its run (design/cleanup.md, "Interval per check"), and takes it off `meta.cleanup_pending`. A finder with a
 * repair that has not ended stays pending and is not due. A finder that the cap cut keeps its place in `meta.cleanup_full`
 * (the drain) only when its run wrote `REPAIRS_TO_SHORTEN` repairs or more ("Cap per check"); otherwise it leaves
 * `cleanup_full` and waits for its interval.
 *
 * @param store - the open store with the write connection
 * @returns the finders that are still pending: the trigger does not run them
 * @sideEffects reads `meta.cleanup_pending`, `meta.cleanup_seq`, `meta.cleanup_full`, the changes and the requests; writes
 *   `meta.cleanup_every`, `meta.cleanup_full` and `meta.cleanup_pending` when a finder settled
 */
function settleIntervals(store: Store): CleanupFinder[] {
  const pending = readCleanupPending(store);
  if (pending.length === 0) return [];
  const open = pending.filter((f) => hasOpenRepairs(store, f));
  const ended = pending.filter((f) => !open.includes(f));
  if (ended.length === 0) return open;
  const seqs = readCleanupSeq(store);
  if (seqs !== undefined) {
    const every = readCleanupEvery(store);
    let full = readCleanupFull(store);
    for (const f of ended) {
      const repairs = countRepairs(store, f, seqs[f]);
      every[f] = nextInterval(every[f], repairs);
      if (repairs < REPAIRS_TO_SHORTEN) full = full.filter((g) => g !== f);
    }
    writeCleanupEvery(store, every);
    writeCleanupFull(store, full);
  }
  writeCleanupPending(store, open);
  return open;
}

/**
 * The trigger of the cleanup (design/cleanup.md, "Interval per check"), called after each step that ends a request and after a poll that found no queued row; the count of queued rows does not gate it. An absent `meta.cleanup_seq` is written with the
 * current highest `seq` for every finder and runs nothing, so a worker that starts on a large wiki starts no
 * backlog, and a fresh store in a test or an eval never runs it. It first sets the next interval of the pending finders whose repairs ended
 * (`settleIntervals`); a finder still pending is not due. A finder is due when the writes above its seq (accepted changes of submissions and operator edits, not of cleanup repairs) number at least its interval in `meta.cleanup_every`, or when the cap cut it in its last run, that run wrote `REPAIRS_TO_SHORTEN` repairs or more (else `settleIntervals` took it out of `meta.cleanup_full`) and a write exists above its seq. The
 * due finders run.
 *
 * @param store - the open store with the write connection
 * @param log - receives the `cleanup_run` line of a run
 * @returns the number of requests queued; undefined when no finder was due
 * @sideEffects reads `meta.cleanup_seq`, `meta.cleanup_full`, `meta.cleanup_every`, the highest `seq` and, per finder, the count of writes above its seq; writes `cleanup_seq` when absent;
 *   writes `cleanup_every`, `cleanup_full` and `cleanup_pending` when a pending finder settled;
 *   as `runCleanup` for a run; reads the clock for the receive time of the requests
 */
export function cleanupIfDue(store: Store, log: Logger): number | undefined {
  const stillPending = settleIntervals(store);
  const seen = readCleanupSeq(store);
  const highest = highestChangeSeq(store);
  if (seen === undefined) {
    writeCleanupSeq(store, allSeqs(highest));
    return undefined;
  }
  const full = readCleanupFull(store);
  const every = readCleanupEvery(store);
  const due = CLEANUP_FINDERS.filter((f) => {
    if (stillPending.includes(f)) return false;
    const writes = countWritesSince(store, seen[f]);
    return writes >= every[f] || (full.includes(f) && writes > 0);
  });
  if (due.length === 0) return undefined;
  return runCleanup(store, Date.now(), log, due);
}
