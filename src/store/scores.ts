import { RetrievalKind } from "../domain/enums.js";
import { inList } from "./sql.js";
import type { Store } from "./types/index.js";

/** The weight of an event halves after each half life, so the decay is a power of 2. */
const DECAY_BASE = 2;

/**
 * technical/lookup.md, "Scores": `decay(t) = 2 ^ ( -(now - t) / HALF_LIFE )`. A time after `now` counts as `now`.
 *
 * @param t - the time of the event, in ms
 * @param now - the current time, in ms
 * @param halfLife - the half life, in ms
 * @returns the weight of the event, 0 to 1
 * @sideEffects none
 */
export function decay(t: number, now: number, halfLife: number): number {
  return Math.pow(DECAY_BASE, -Math.max(0, now - t) / halfLife);
}

interface VersionRow {
  id: number;
  seq: number;
  content: string;
  is_deleted: number;
  justification: string;
  created_at: number;
}

/** The columns of a fact version that decide whether it is observed (technical/lookup.md, "Confidence"). */
export type ObservedColumns = Pick<VersionRow, "content" | "is_deleted" | "justification">;

/**
 * technical/lookup.md, "Confidence": tells whether a version is observed, so that its creation is an update event. It is when its
 * justification is not empty and its content or `is_deleted` differs from the version before it; the first version
 * of a fact (no `prev`) is observed when its justification is not empty.
 *
 * @param v - the version
 * @param prev - the version before it, or undefined for the first version
 * @returns true when `v` resets the confidence of its fact
 * @sideEffects none
 */
export function isObservedVersion(v: ObservedColumns, prev: ObservedColumns | undefined): boolean {
  const changed = prev?.content !== v.content || prev.is_deleted !== v.is_deleted;
  return changed && v.justification.trim() !== "";
}

/**
 * technical/lookup.md, "Confidence". Computes the confidence of one fact at time `now`.
 *
 * @param store - the open store
 * @param factId - the fact id
 * @param now - the current time, in ms
 * @returns the confidence, 0 to 1; 0 for an unknown or deleted fact
 * @sideEffects none (reads)
 */
export function confidence(store: Store, factId: string, now: number): number {
  return confidenceInner(store, factId, now, new Set());
}

/** How many ids one `IN (...)` list holds; SQLite caps the bound parameters of a statement at 32,766. */
const IN_CHUNK = 500;

interface RetrievalRow {
  kind: RetrievalKind;
  weight: number;
  at: number;
}

/** A retrieval row with the seq of the version it sits on, for the bulk read. */
type RetrievalOfFact = RetrievalRow & { fact_id: string; seq: number };

// The newest observed version of a fact (technical/lookup.md, "Confidence"): its content or is_deleted differs from the version before
// it, and its justification is not empty. The rows are in seq order.
function newestObserved(versions: VersionRow[]): VersionRow | undefined {
  for (let i = versions.length - 1; i >= 0; i--) {
    const ver = versions[i];
    if (ver !== undefined && isObservedVersion(ver, i > 0 ? versions[i - 1] : undefined)) return ver;
  }
  return undefined;
}

// The confidence of a fact from its newest observed version and the retrievals on it and every version since.
function scoreOf(store: Store, v: VersionRow, rows: RetrievalRow[], now: number): number {
  const w = store.weights;
  let s = w.wUpdate * decay(v.created_at, now, w.halfLifeConf);
  for (const r of rows) {
    const k = r.kind === RetrievalKind.Confirm ? w.wConfirm : w.wRead;
    s += k * r.weight * decay(r.at, now, w.halfLifeConf);
  }
  return 1 - Math.pow(DECAY_BASE, -s);
}

function chunks<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += IN_CHUNK) out.push(items.slice(i, i + IN_CHUNK));
  return out;
}

/**
 * technical/lookup.md, "Confidence". Computes the confidence of several facts in a few queries: the versions and the retrievals of all
 * the ids are read in chunks and scored in code, so a page that scores a whole wiki does not run 3 queries per fact.
 * A fact with no observed version falls back to the single-fact path for its references.
 *
 * @param store - the open store
 * @param factIds - the fact ids; a repeated id is scored once
 * @param now - the current time, in ms
 * @returns the confidence of each id; 0 for an unknown or deleted fact
 * @sideEffects none (reads)
 */
export function confidences(store: Store, factIds: string[], now: number): Map<string, number> {
  const out = new Map<string, number>();
  const unique = [...new Set(factIds)];
  const versions = new Map<string, VersionRow[]>();
  const retrievals = new Map<string, RetrievalOfFact[]>();
  for (const ids of chunks(unique)) {
    const list = inList(ids.length);
    const vRows = store.db
      .prepare(
        `SELECT fact_id, id, seq, content, is_deleted, justification, created_at FROM fact_versions
         WHERE fact_id IN (${list}) ORDER BY fact_id, seq ASC`,
      )
      .all(...ids) as (VersionRow & { fact_id: string })[];
    for (const r of vRows) {
      const vs = versions.get(r.fact_id);
      if (vs) vs.push(r);
      else versions.set(r.fact_id, [r]);
    }
    const rRows = store.db
      .prepare(
        `SELECT fv.fact_id AS fact_id, fv.seq AS seq, r.kind AS kind, r.weight AS weight, r.at AS at
         FROM retrievals r JOIN fact_versions fv ON fv.id = r.fact_version_id WHERE fv.fact_id IN (${list})`,
      )
      .all(...ids) as RetrievalOfFact[];
    for (const r of rRows) {
      const rs = retrievals.get(r.fact_id);
      if (rs) rs.push(r);
      else retrievals.set(r.fact_id, [r]);
    }
  }
  for (const id of unique) {
    const vs = versions.get(id) ?? [];
    const current = vs[vs.length - 1];
    if (current === undefined || current.is_deleted) {
      out.set(id, 0);
      continue;
    }
    const v = newestObserved(vs);
    if (v === undefined) {
      out.set(id, confidenceInner(store, id, now, new Set()));
      continue;
    }
    const since = v.seq;
    out.set(
      id,
      scoreOf(
        store,
        v,
        (retrievals.get(id) ?? []).filter((r) => r.seq >= since),
        now,
      ),
    );
  }
  return out;
}

function confidenceInner(store: Store, factId: string, now: number, seen: Set<string>): number {
  const { db } = store;
  const versions = db
    .prepare(
      "SELECT id, seq, content, is_deleted, justification, created_at FROM fact_versions WHERE fact_id = ? ORDER BY seq ASC",
    )
    .all(factId) as VersionRow[];
  if (versions.length === 0) return 0;
  const current = versions[versions.length - 1];
  if (current === undefined || current.is_deleted) return 0;

  const v = newestObserved(versions);
  if (!v) {
    // No observed version. The lowest confidence among the current references.
    const refs = db.prepare("SELECT ref_fact_id FROM fact_version_refs WHERE fact_version_id = ?").all(current.id) as {
      ref_fact_id: string;
    }[];
    seen.add(factId);
    let min: number | undefined;
    for (const r of refs) {
      if (seen.has(r.ref_fact_id)) continue; // a cycle adds no evidence
      const c = confidenceInner(store, r.ref_fact_id, now, seen);
      if (min === undefined || c < min) min = c;
    }
    seen.delete(factId);
    return min ?? 0;
  }

  const rows = db
    .prepare(
      `SELECT r.kind AS kind, r.weight AS weight, r.at AS at
       FROM retrievals r JOIN fact_versions fv ON fv.id = r.fact_version_id
       WHERE fv.fact_id = ? AND fv.seq >= ?`,
    )
    .all(factId, v.seq) as RetrievalRow[];
  return scoreOf(store, v, rows, now);
}

/**
 * technical/lookup.md, "Usefulness". Computes the usefulness of facts: all retrievals on all fact versions, both kinds.
 *
 * @param store - the open store
 * @param factIds - the fact ids
 * @param now - the current time, in ms
 * @returns the usefulness of each id; 0 without retrievals
 * @sideEffects none (reads)
 */
export function usefulness(store: Store, factIds: string[], now: number): Map<string, number> {
  const out = new Map<string, number>(factIds.map((id) => [id, 0]));
  const stmt = store.db.prepare(
    `SELECT r.weight AS weight, r.at AS at
     FROM retrievals r JOIN fact_versions fv ON fv.id = r.fact_version_id
     WHERE fv.fact_id = ?`,
  );
  for (const id of factIds) {
    let sum = 0;
    for (const r of stmt.all(id) as { weight: number; at: number }[]) {
      sum += r.weight * decay(r.at, now, store.weights.halfLifeUse);
    }
    out.set(id, sum);
  }
  return out;
}
