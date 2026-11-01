import { normalizeDeletions, validateShape, writeChangeRow, writeChildren, writeFacts } from "./writeSteps.js";
import { staleness, type FreshCheck } from "./batch.js";
import { saveStagedVectors } from "./stagedVectors.js";
import type { ChangeSet, IndexChange, IndexWriter, Store } from "./types/index.js";

export { MIN_CLAIMS_TO_SPLIT } from "./writeSteps.js";

/** What `applyChange` returns. */
export interface ApplyResult {
  seq: number;
  /** The fact id of each entry in `changeSet.facts`, in order. New facts get an id here. */
  factIds: string[];
  /** The `fact_versions.id` of each entry in `changeSet.facts`, in order. */
  versionIds: number[];
  /** The ids of the child requests that a split change queued, in claim order; empty for every other outcome. */
  childIds: string[];
}

/** The options of `applyChange`. */
export interface ApplyOptions {
  /** The clock for the change, in ms since the epoch. Default: now. */
  now?: number;
  /**
   * The stale check of a request of a batch (technical/updates.md, "High volume mode"): inside the transaction, the write is
   * refused when a fact of the check has a version that another writer made after the gather. Absent: no check.
   */
  fresh?: FreshCheck;
}

/** The options of `applyChangeSync`. */
export type ApplySyncOptions = ApplyOptions & {
  /** What `store.indexWriter.prepare` returned. Absent: the index fills the FTS tables only. */
  prepared?: unknown;
};

/**
 * technical/updates.md, "Write transaction". Writes one change set in one transaction.
 * Step 1: `indexWriter.prepare` (embeddings) runs before the transaction.
 * Steps 2 to 7 run in `applyChangeSync`. Step 6 goes through `indexWriter.write`.
 *
 * @param store - the open store; with `stageTo` set (a request of a batch) the change goes to the `stg_*` tables and its
 *   embeddings to `stg_vectors` through that overlay store, and the live tables are not written
 * @param requestId - the id of the `change_requests` row this change answers
 * @param changeSet - the change to write
 * @param opts - the clock, in ms since the epoch (default now), and the stale check of a request of a batch (default none)
 * @returns the seq of the change, the fact ids and version ids of its drafts (empty lists for a rejected, duplicate
 *   or split change, which writes a `changes` row only), and the ids of the child requests of a split (else empty)
 * @throws {Error} when the change set is malformed (outcome, reject reason, duplicate target, claims of a split,
 *   empty summary, header or content, a deletion draft with references), the request id is unknown, a split names a
 *   request that is itself a child, or a fact or reference it names does not exist; nothing is written
 * @throws {StaleChangeError} when `opts.fresh` is set and another writer changed one of its facts after the gather; nothing is written
 * @sideEffects the embedder runs for the change; then one immediate transaction on the store (on `store.stageTo` when it is
 *   set) writes the `changes` row, the child `change_requests` rows of a split, facts, versions and the index rows
 *   (a store with `stageTo` writes the `stg_*` tables and `stg_vectors` instead, and no index row), and rolls
 *   back on any failure; reads the clock when `opts.now` is absent
 */
export async function applyChange(
  store: Store,
  requestId: string,
  changeSet: ChangeSet,
  opts: ApplyOptions = {},
): Promise<ApplyResult> {
  // A request of a batch writes through the overlay store: the change goes to the staging tables.
  const target = store.stageTo ?? store;
  const normalized = normalizeDeletions(target.db, changeSet);
  const prepared = target.indexWriter.prepare ? await target.indexWriter.prepare(normalized) : undefined;
  return applyChangeSync(target, requestId, normalized, { ...opts, prepared });
}

/**
 * technical/updates.md, "Write transaction", step 2 to 7. Writes one change set in one transaction, without the embedding step.
 *
 * @param store - the open store
 * @param requestId - the id of the `change_requests` row this change answers
 * @param changeSet - the change to write
 * @param opts - the clock (ms since the epoch, default now) and the output of `indexWriter.prepare`; without
 *   `prepared` only the FTS rows are written
 * @returns the seq of the change, and the fact ids and version ids of its drafts
 * @throws {Error} on the same conditions as `applyChange`, and when `prepared` does not match the change set
 * @throws {StaleChangeError} when `opts.fresh` is set and another writer changed one of its facts after the gather; nothing is written
 * @sideEffects one immediate transaction on the store writes the `changes` row, facts, versions and
 *   the index rows, and rolls back on any failure; reads the clock when `opts.now` is absent
 */
export function applyChangeSync(
  store: Store,
  requestId: string,
  changeSet: ChangeSet,
  opts: ApplySyncOptions = {},
): ApplyResult {
  const now = opts.now ?? Date.now();
  const run = store.db.transaction((): ApplyResult => {
    if (opts.fresh) {
      const stale = staleness(store, changeSet, opts.fresh, requestId);
      if (stale !== null) throw stale;
    }
    return writeChangeSteps(store, requestId, changeSet, { now, prepared: opts.prepared });
  });
  return run.immediate();
}

/**
 * technical/updates.md, "Write transaction", step 2 (the shape check) and steps 3 to 6. Writes one change set inside the
 * transaction of the caller (`applyChangeSync`).
 *
 * @param store - the open store, with a transaction open
 * @param requestId - the id of the `change_requests` row this change answers
 * @param changeSet - the change to write
 * @param at - the clock and the embeddings of the change
 * @param at.now - the clock for the change, in ms since the epoch
 * @param at.prepared - what `store.indexWriter.prepare` returned for this change set; undefined: the FTS rows only
 * @returns the seq of the change, and the fact ids, version ids and child request ids it wrote
 * @throws {Error} on the same conditions as `applyChange`; the caller rolls back
 * @sideEffects writes the `changes` row, the child requests of a split, facts, versions and the index rows
 */
function writeChangeSteps(
  store: Store,
  requestId: string,
  changeSet: ChangeSet,
  at: { now: number; prepared: unknown },
): ApplyResult {
  const { now, prepared } = at;
  const { db } = store;
  validateShape(changeSet);
  const cs = normalizeDeletions(db, changeSet);

  // The overlay store of a batch with fix 3 also runs the children that the batch staged: their rows are in the staging tables.
  const req =
    store.overlay === true
      ? db
          .prepare(
            "SELECT 1 FROM main.change_requests WHERE id = ? UNION ALL SELECT 1 FROM main.stg_change_requests WHERE id = ?",
          )
          .get(requestId, requestId)
      : db.prepare("SELECT 1 FROM change_requests WHERE id = ?").get(requestId);
  if (!req) throw new Error(`unknown request ${requestId}`);

  const seq = writeChangeRow(store, requestId, cs, now);
  const childIds = writeChildren(store, requestId, cs, now);
  const { factIds, versionIds, indexVersions } = writeFacts(store, cs, { seq, now });

  // Step 6. The index goes through the hook. The overlay store of a batch keeps the vectors in `stg_vectors` instead: the
  // promotion writes the index rows of the batch in one call.
  const index: IndexWriter["write"] =
    store.overlay === true ? saveStagedVectors : (d, c, p) => store.indexWriter.write(d, c, p);
  const change: IndexChange = { seq, versions: indexVersions };
  index(db, change, prepared);

  return { seq, factIds, versionIds, childIds };
}
