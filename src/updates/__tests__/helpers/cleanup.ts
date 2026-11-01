// Helpers of the cleanup tests: reading the queued repairs, the seq of every finder.
import type { Config } from "../../../config/index.js";
import { ChangeOutcome, CleanupFinder, RequestKind, RequestStatus } from "../../../domain/enums.js";
import {
  CLEANUP_FINDERS,
  enqueueCleanupRepair,
  seedChange,
  type CleanupSeqs,
  type SeedResult,
  type Store,
  type CleanupRepair,
} from "../../../store/index.js";
import { T0, accepted, draft } from "../../../../__tests__/helpers/store.js";

/** A `cleanupRepair` request as the tests read it. */
export interface QueuedRepair {
  status: string;
  change: string;
  received_at: number;
}

/**
 * Reads the `cleanupRepair` requests of a store, oldest first.
 *
 * @param s - the store
 * @returns the status, the document and the receive time of each request
 * @sideEffects none
 */
export const queuedRepairs = (s: Store): QueuedRepair[] =>
  s.db
    .prepare("SELECT status, change, received_at FROM change_requests WHERE kind = ? ORDER BY received_at, rowid")
    .all(RequestKind.CleanupRepair) as QueuedRepair[];

/**
 * Ends the queued `cleanupRepair` requests with no change, as the worker does when it has taken them.
 *
 * @param s - the store
 * @sideEffects sets the status of every queued `cleanupRepair` request to `done`
 */
export function endQueuedRepairs(s: Store): void {
  s.db
    .prepare("UPDATE change_requests SET status = ? WHERE kind = ? AND status = ?")
    .run(RequestStatus.Done, RequestKind.CleanupRepair, RequestStatus.Queued);
}

/**
 * Builds the seq of every finder at one value, with the given finders overridden.
 *
 * @param seq - the value of every finder
 * @param override - the finders that take another value
 * @returns the seqs
 * @sideEffects none
 */
export const seqsAt = (seq: number, override: Partial<CleanupSeqs> = {}): CleanupSeqs =>
  ({ ...Object.fromEntries(CLEANUP_FINDERS.map((f) => [f, seq])), ...override }) as CleanupSeqs;

/**
 * Writes `n` pairs of near-duplicate facts in 1 change; the pairs share no word with each other, so the duplicate fact
 * finder finds exactly `n` candidates (the fake embedder gives close vectors to texts that share words).
 *
 * @param s - the store
 * @param n - the number of pairs
 * @returns the apply result, with the ids of the facts in pair order (2 per pair)
 * @sideEffects writes one change to the store
 */
export const duplicatePairs = (s: Store, n: number): Promise<SeedResult> =>
  seedChange(
    s,
    accepted(
      Array.from({ length: n }, (_, i) => [
        draft({ header: `Pair${i}x one`, content: `Pair${i}x alpha${i}x beta${i}x gamma${i}x delta${i}x.` }),
        draft({ header: `Pair${i}x two`, content: `Pair${i}x alpha${i}x beta${i}x gamma${i}x delta${i}x again.` }),
      ]).flat(),
    ),
    { now: T0 },
  );

const REPAIR_OF: Record<CleanupFinder, CleanupRepair> = {
  [CleanupFinder.DuplicateFact]: { finder: CleanupFinder.DuplicateFact, factIds: ["f1", "f2"] },
};

/**
 * Records 1 repair of a finder: a `cleanupRepair` request that ended with an accepted change.
 *
 * @param s - the store
 * @param finder - the finder of the request
 * @param at - the time of the request and the change, in ms
 * @returns the id of the request
 * @sideEffects one insert of a request and one insert of a change
 */
export function wroteRepair(s: Store, finder: CleanupFinder, at: number): string {
  const id = enqueueCleanupRepair(s, REPAIR_OF[finder], at);
  s.db.prepare("UPDATE change_requests SET status = ? WHERE id = ?").run(RequestStatus.Done, id);
  s.db
    .prepare("INSERT INTO changes(request_id, outcome, reject_reason, summary, created_at) VALUES (?, ?, NULL, 's', ?)")
    .run(id, ChangeOutcome.Accepted, at);
  return id;
}

/**
 * Records 1 write of a client: a `submission` request that ended with an accepted change.
 *
 * @param s - the store
 * @param at - the time of the request and the change, in ms
 * @returns the id of the request
 * @sideEffects one insert of a request and one insert of a change
 */
export function wroteSubmission(s: Store, at: number): string {
  const id = wroteRepair(s, CleanupFinder.DuplicateFact, at);
  s.db.prepare("UPDATE change_requests SET kind = ? WHERE id = ?").run(RequestKind.Submission, id);
  return id;
}

// The worker reads the embedding model, the weights, the caps and the subject. `parseConfig` also reads the presets file,
// which the tests do not depend on.
export const workerConfig = {
  embeddingModel: "test-model",
  weights: {},
  searchCap: 10,
  agentSearchCap: 20,
  subject: "Minecraft",
  // No wait: a queued submission starts its batch at the next poll, as a request ran at once before.
  highVolume: { batchSize: 10, waitMs: 0, concurrency: 1, groupCut: 0 },
} as unknown as Config;
