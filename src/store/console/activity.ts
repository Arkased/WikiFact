// The activity read of technical/console.md, "Store API additions": the requests list, and per request the fact versions that
// its changes wrote, in one query over the ids of the page.
import { VersionWrite } from "../../domain/enums.js";
import type { ListRequestsOptions, Page, RequestListItem, Store } from "../types/index.js";
import { listRequests } from "./requests.js";

/** One fact version that a request wrote, with the kind of write. */
interface ActivityWrite {
  factId: string;
  /** The header of the version. */
  header: string;
  kind: VersionWrite;
}

/** One row of the Requests list: a request as `listRequests` reads it, and what its changes wrote. */
export interface ActivityItem extends RequestListItem {
  /** The versions of every `changes` row of the request (a merge writes one before the request's own), in write order. */
  wrote: ActivityWrite[];
}

interface WroteRow {
  request_id: string;
  fact_id: string;
  header: string;
  is_deleted: number;
  /** `is_deleted` of the version before, null when the fact has no earlier version. */
  before_deleted: number | null;
}

/** The one fact of an earlier version that decides the kind of write: whether it was a deletion. */
export interface VersionDeletion {
  isDeleted: boolean;
}

/**
 * Says what kind of write a fact version is, against the version of the same fact before it.
 *
 * @param isDeleted - whether the version is a deletion
 * @param previous - the version before it; null when it is the fact's first
 * @returns new without a previous version, deleted after a live one, revived after a deletion, else changed
 * @sideEffects none
 */
export function versionWriteKind(isDeleted: boolean, previous: VersionDeletion | null): VersionWrite {
  if (previous === null) return VersionWrite.New;
  if (isDeleted && !previous.isDeleted) return VersionWrite.Deleted;
  if (!isDeleted && previous.isDeleted) return VersionWrite.Revived;
  return VersionWrite.Changed;
}

function kindOf(r: WroteRow): VersionWrite {
  return versionWriteKind(r.is_deleted === 1, r.before_deleted === null ? null : { isDeleted: r.before_deleted === 1 });
}

/**
 * technical/console.md, "Store API additions", `listActivity`: one page of requests with the filters, the sort and the cursor of
 * `listRequests`, each with the fact versions its changes wrote.
 *
 * @param store - the open store
 * @param opts - the filters, the sort and the page
 * @returns the page; `items` is empty on an empty wiki or past the end; `wrote` is empty for a request that wrote no
 *   version (queued, failed, duplicate, rejected)
 * @throws {InvalidPageError} when `limit` or `cursor` is invalid
 * @sideEffects none (reads)
 */
export function listActivity(store: Store, opts: ListRequestsOptions = {}): Page<ActivityItem> {
  const page = listRequests(store, opts);
  const ids = page.items.map((r) => r.id);
  const byRequest = new Map<string, ActivityWrite[]>();
  if (ids.length > 0) {
    const rows = store.db
      .prepare(
        `SELECT c.request_id, v.fact_id, v.header, v.is_deleted,
                (SELECT p.is_deleted FROM fact_versions p WHERE p.fact_id = v.fact_id AND p.seq < v.seq
                 ORDER BY p.seq DESC LIMIT 1) AS before_deleted
         FROM changes c JOIN fact_versions v ON v.seq = c.seq
         WHERE c.request_id IN (${ids.map(() => "?").join(", ")}) ORDER BY c.seq, v.id`,
      )
      .all(...ids) as WroteRow[];
    for (const r of rows) {
      const list = byRequest.get(r.request_id) ?? [];
      list.push({ factId: r.fact_id, header: r.header, kind: kindOf(r) });
      byRequest.set(r.request_id, list);
    }
  }
  return { items: page.items.map((r) => ({ ...r, wrote: byRequest.get(r.id) ?? [] })), next: page.next };
}
