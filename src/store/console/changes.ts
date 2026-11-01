// The audit trail of technical/console.md, "Store API additions": one page of `changes` rows, newest first, each with the
// versions it wrote.
import { RequestKind, type ChangeOutcome, type RejectReason } from "../../domain/enums.js";
import { parseOperatorEdit } from "../types/operator-edit.js";
import type { ChangeListItem, ListChangesOptions, Page, Store } from "../types/index.js";
import { compareKeys, pageOf } from "./paging.js";

interface Row {
  seq: number;
  request_id: string;
  request_kind: RequestKind;
  outcome: ChangeOutcome;
  reject_reason: RejectReason | null;
  summary: string;
  duplicate_of: string | null;
  created_at: number;
  request_change: string | null;
}

interface VersionRow {
  fact_id: string;
  header: string;
  is_deleted: number;
  before: number;
}

// The note of an operator edit's document; nothing for another kind or a document that does not parse.
function noteOf(r: Row): { note?: string } {
  if (r.request_kind !== RequestKind.OperatorEdit || r.request_change === null) return {};
  try {
    return { note: parseOperatorEdit(r.request_change).note };
  } catch {
    return {};
  }
}

// The filters of `listChanges` as SQL over the change `c` and its request `r`.
function rows(store: Store, opts: ListChangesOptions): Row[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  const add = (sql: string, value: string | number | undefined): void => {
    if (value === undefined) return;
    where.push(sql);
    args.push(value);
  };
  add("c.outcome = ?", opts.outcome);
  add("r.kind = ?", opts.kind);
  add("EXISTS (SELECT 1 FROM fact_versions v WHERE v.seq = c.seq AND v.fact_id = ?)", opts.factId);
  add("c.seq >= ?", opts.fromSeq);
  add("c.seq <= ?", opts.toSeq);
  const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  return store.db
    .prepare(
      `SELECT c.seq, c.request_id, r.kind AS request_kind, c.outcome, c.reject_reason, c.summary, c.duplicate_of,
              c.created_at, r.change AS request_change
       FROM changes c JOIN change_requests r ON r.id = c.request_id ${clause}`,
    )
    .all(...args) as Row[];
}

/**
 * technical/console.md, "Store API additions", `listChanges`: one page of the audit trail, newest first.
 *
 * @param store - the open store
 * @param opts - the filters and the page
 * @returns the page; `items` is empty on an empty wiki or past the end
 * @throws {InvalidPageError} when `limit` or `cursor` is invalid
 * @sideEffects none (reads)
 */
export function listChanges(store: Store, opts: ListChangesOptions = {}): Page<ChangeListItem> {
  const page = pageOf(rows(store, opts), (r) => ({ k: r.seq, id: String(r.seq) }), compareKeys(true), opts);
  const versions = store.db.prepare(
    `SELECT v.fact_id, v.header, v.is_deleted,
            (SELECT COUNT(*) FROM fact_versions x WHERE x.fact_id = v.fact_id AND x.seq < v.seq) AS before
     FROM fact_versions v WHERE v.seq = ? ORDER BY v.id`,
  );
  const items = page.items.map((r): ChangeListItem => ({
    seq: r.seq,
    requestId: r.request_id,
    requestKind: r.request_kind,
    outcome: r.outcome,
    rejectReason: r.reject_reason,
    summary: r.summary,
    duplicateOf: r.duplicate_of,
    created: r.created_at,
    ...noteOf(r),
    versions: (versions.all(r.seq) as VersionRow[]).map((v) => ({
      factId: v.fact_id,
      header: v.header,
      isDeleted: v.is_deleted === 1,
      isNew: v.before === 0,
    })),
  }));
  return { items, next: page.next };
}
