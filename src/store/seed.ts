import { RequestKind } from "../domain/enums.js";
import { enqueueRequest, finishRequest } from "./queue.js";
import type { ChangeSet, Store } from "./types/index.js";
import { applyChange, type ApplyResult } from "./write.js";

/** What `seedChange` returns: the result of `applyChange` and the id of the request it ran under. */
export type SeedResult = ApplyResult & { requestId: string };

/** The options of `seedChange`. */
export interface SeedOptions {
  /** The clock for the request and the change, in ms. Default: now. */
  now?: number;
  /** The text of the submission request. Default "seed". */
  change?: string;
  /** The justification of the submission request. Default "seed". */
  justification?: string;
  /** The session of the submission request. Default: none. */
  sessionId?: string;
}

/**
 * Writes a change set under a submission request that is already done, without running the update agent.
 *
 * @param store - the open store
 * @param changeSet - the change to write
 * @param opts - the clock (ms) and the request text, for tests and the seeding scripts
 * @returns the `applyChange` result plus `requestId`
 * @sideEffects one insert and one update on the store for the request, then the transaction of `applyChange`;
 *   the embedder runs for the change; reads the clock when `opts.now` is absent
 */
export async function seedChange(store: Store, changeSet: ChangeSet, opts: SeedOptions = {}): Promise<SeedResult> {
  const now = opts.now ?? Date.now();
  const requestId = enqueueRequest(
    store,
    {
      kind: RequestKind.Submission,
      change: opts.change ?? "seed",
      justification: opts.justification ?? "seed",
      sessionId: opts.sessionId,
    },
    now,
  );
  finishRequest(store, requestId, now);
  const res = await applyChange(store, requestId, changeSet, { now });
  return { ...res, requestId };
}
