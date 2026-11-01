// Finder 4 of the cleanup (technical/cleanup.md, "The finders"): the duplicate fact. Code only: no model call, no write.
import { CleanupFinder, StagedVectorKind } from "../../domain/enums.js";
import { cosineDistance, VEC_CANDIDATES } from "../search/candidates.js";
import type { Store, CleanupRepair } from "../types/index.js";
import type { CleanupLimits } from "./limits.js";
import { isCovered, verdictSubject } from "./state.js";

// A float vector stored in a vec0 table comes back as a blob; the blob may not sit on a 4-byte boundary.
function toVector(blob: Buffer): Float32Array {
  return new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));
}

/** A live fact and how far it is from another one. */
export interface FactNeighbor {
  factId: string;
  /** The cosine distance (`1 - cosine`). */
  distance: number;
}

function hasStagedVersion(store: Store, factId: string): boolean {
  return store.db.prepare("SELECT 1 FROM stg_fact_versions WHERE fact_id = ? LIMIT 1").get(factId) !== undefined;
}

// The live facts of the staging tables with their vectors: the last staged version of each fact, when it is not a deletion.
function stagedLive(store: Store): { factId: string; full: Buffer }[] {
  return (
    store.db
      .prepare(
        `SELECT v.fact_id AS factId, s.embedding AS full
         FROM stg_fact_versions v JOIN stg_vectors s ON s.kind = ? AND s.ref = v.id
         WHERE v.is_deleted = 0 AND v.seq = (SELECT MAX(seq) FROM stg_fact_versions WHERE fact_id = v.fact_id)`,
      )
      .all(StagedVectorKind.Fact) as { factId: string; full: Buffer }[]
  ).map((r) => ({ factId: r.factId, full: r.full }));
}

// The float vector of a live fact: its `current_vec` row, or on the overlay store the vector of its last staged version.
function vectorOf(store: Store, factId: string): Buffer | undefined {
  if (store.overlay === true && hasStagedVersion(store, factId)) {
    return stagedLive(store).find((r) => r.factId === factId)?.full;
  }
  const row = store.db.prepare("SELECT full FROM current_vec WHERE fact_id = ?").get(factId) as
    { full: Buffer } | undefined;
  return row?.full;
}

// The 1-bit KNN over `current_vec` hands `VEC_CANDIDATES` rows to the exact rescore on the float vectors.
function neighborsOf(
  store: Store,
  from: { factId: string; full: Buffer },
  { k, maxDistance }: { k: number; maxDistance: number },
  among?: (factId: string) => boolean,
): FactNeighbor[] {
  const { factId, full } = from;
  const vector = toVector(full);
  const live = store.db
    .prepare("SELECT fact_id AS factId, full FROM current_vec WHERE embedding MATCH vec_quantize_binary(?) AND k = ?")
    .all(full, VEC_CANDIDATES) as { factId: string; full: Buffer }[];
  // On the overlay store of a batch the index tables hold the live wiki only: a fact with a staged version takes its
  // vector from the staging tables.
  const rows =
    store.overlay === true ? [...live.filter((r) => !hasStagedVersion(store, r.factId)), ...stagedLive(store)] : live;
  return rows
    .filter((r) => r.factId !== factId && (among === undefined || among(r.factId)))
    .map((r) => ({ factId: r.factId, distance: cosineDistance(vector, r.full) }))
    .filter((r) => r.distance < maxDistance)
    .sort((a, b) => a.distance - b.distance || (a.factId < b.factId ? -1 : 1))
    .slice(0, k);
}

/**
 * Finds the nearest live facts of a live fact by the float vectors of `current_vec`, nearest first, under a distance.
 *
 * @param store - the open store whose `current_vec` table is read
 * @param factId - the id of the live fact whose neighbors are read
 * @param k - the most neighbors to return
 * @param maxDistance - the cosine distance that a neighbor stays under (`store.config.neighborDistance`)
 * @returns the neighbors; empty when the fact is not live or has no vector
 * @sideEffects none (reads)
 */
export function nearestLiveFacts(store: Store, factId: string, k: number, maxDistance: number): FactNeighbor[] {
  return nearestAmong(store, factId, { k, maxDistance });
}

/**
 * Finds the nearest live facts of a live fact among the facts that a filter accepts: the `k` nearest are taken among the
 * accepted facts, not among all facts and then filtered (the reconciliation of the fixed batch, which pairs a staged fact
 * only with the facts that other requests of the batch staged).
 *
 * @param store - the open store whose `current_vec` table is read
 * @param factId - the id of the live fact whose neighbors are read
 * @param bounds - the limits of the neighbors
 * @param bounds.k - the most neighbors to return
 * @param bounds.maxDistance - the cosine distance that a neighbor stays under
 * @param among - the facts that may be neighbors; absent: all facts
 * @returns the neighbors, nearest first; empty when the fact is not live or has no vector
 * @sideEffects none (reads)
 */
export function nearestAmong(
  store: Store,
  factId: string,
  bounds: { k: number; maxDistance: number },
  among?: (factId: string) => boolean,
): FactNeighbor[] {
  const full = vectorOf(store, factId);
  return full === undefined ? [] : neighborsOf(store, { factId, full }, bounds, among);
}

/**
 * Finds the pairs of near-duplicate live facts (finder 4). For each live fact, takes its `duplicateFactNeighbors` nearest live facts under
 * `store.config.neighborDistance`; one candidate per pair, the older fact first (the one whose first version has the
 * lower `seq`, then the lower id), the closest pair first. A pair that a verdict covers (no newer version of either
 * fact) is dropped.
 *
 * @param store - the open store; its `config.neighborDistance` bounds the distance of a pair
 * @param limits - the cleanup limits; `duplicateFactNeighbors` is how many nearest facts each fact is paired with
 * @returns the pairs, closest first, each with its 2 fact ids, the older first; an empty list when no pair is under
 *   the distance, or every pair is covered by a verdict
 * @sideEffects none (reads)
 */
export function findDuplicateFacts(store: Store, limits: CleanupLimits): CleanupRepair[] {
  const live = store.db
    .prepare(
      `SELECT cv.fact_id AS factId, cv.full AS full
       FROM current_fact_versions c JOIN current_vec cv ON cv.fact_id = c.fact_id
       WHERE c.is_deleted = 0 ORDER BY cv.fact_id`,
    )
    .all() as { factId: string; full: Buffer }[];
  const firstSeq = new Map(
    (
      store.db.prepare("SELECT fact_id AS factId, MIN(seq) AS seq FROM fact_versions GROUP BY fact_id").all() as {
        factId: string;
        seq: number;
      }[]
    ).map((r) => [r.factId, r.seq]),
  );
  const isOlder = (a: string, b: string): boolean => {
    const sa = firstSeq.get(a) ?? 0;
    const sb = firstSeq.get(b) ?? 0;
    return sa !== sb ? sa < sb : a < b;
  };
  const pairs = new Map<string, { ids: [string, string]; distance: number }>();
  for (const f of live) {
    for (const n of neighborsOf(store, f, {
      k: limits.duplicateFactNeighbors,
      maxDistance: store.config.neighborDistance,
    })) {
      const ids: [string, string] = isOlder(f.factId, n.factId) ? [f.factId, n.factId] : [n.factId, f.factId];
      const key = ids.join(" ");
      const seen = pairs.get(key);
      if (seen === undefined || n.distance < seen.distance) pairs.set(key, { ids, distance: n.distance });
    }
  }
  return [...pairs.entries()]
    .sort(([ka, a], [kb, b]) => a.distance - b.distance || (ka < kb ? -1 : 1))
    .filter(([, p]) => !isCovered(store, CleanupFinder.DuplicateFact, verdictSubject(p.ids)))
    .map(([, p]): CleanupRepair => ({ finder: CleanupFinder.DuplicateFact, factIds: p.ids }));
}
