// The request reads of technical/console.md, "Store API additions": the requests list joined with the last change of each,
// and the request page with every change and the versions it wrote.
import { RequestListSort, assertNever, type ChangeOutcome, type RejectReason } from "../../domain/enums.js";
import type {
  ChangeVersion,
  CurrentHeaderRow,
  ListRequestsOptions,
  Page,
  RequestChangeDetail,
  RequestDetail,
  RequestListItem,
  ReferenceLabel,
  RequestRow,
  Store,
} from "../types/index.js";
import { parseTargets } from "../targets.js";
import { compareKeys, pageOf, type SortKey } from "./paging.js";
import { VERSION_COLUMNS, toFactVersions, type VersionRow } from "./versions.js";

interface Row {
  id: string;
  kind: RequestRow["kind"];
  status: RequestRow["status"];
  change: string | null;
  targets: string;
  justification: string | null;
  prior_query: string | null;
  attempts: number;
  received_at: number;
  started_at: number | null;
  finished_at: number | null;
  error: string | null;
  parent_id: string | null;
}

type JoinedRow = Row & {
  outcome: ChangeOutcome | null;
  reject_reason: RejectReason | null;
  duplicate_of: string | null;
  last_seq: number | null;
};

const REQUEST_COLUMNS =
  "r.id, r.kind, r.status, r.change, r.targets, r.justification, (SELECT s.query FROM searches s WHERE s.id = r.search_id) AS prior_query, r.attempts, r.received_at, r.started_at, r.finished_at, r.error, r.parent_id";

function toRequestRow(r: Row): RequestRow {
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    change: r.change,
    targets: parseTargets(r.targets),
    justification: r.justification,
    priorQuery: r.prior_query,
    attempts: r.attempts,
    receivedAt: r.received_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    error: r.error,
    parentId: r.parent_id,
  };
}

// `finished_at - started_at`, or null without both times.
const durationOf = (r: Row): number | null =>
  r.started_at === null || r.finished_at === null ? null : r.finished_at - r.started_at;

// Escapes `%`, `_` and the escape character for a `LIKE ? ESCAPE '\'` pattern that matches the text as a substring.
const likePattern = (text: string): string => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

// The filters of `listRequests` as SQL over the request `r` and its last change `c`.
function joinedRows(store: Store, opts: ListRequestsOptions): JoinedRow[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  const eq = (column: string, value: string | number | undefined): void => {
    if (value === undefined) return;
    where.push(`${column} = ?`);
    args.push(value);
  };
  eq("r.status", opts.status);
  eq("r.kind", opts.kind);
  eq("c.outcome", opts.outcome);
  eq("c.reject_reason", opts.rejectReason);
  if (opts.factId !== undefined) {
    where.push(
      `EXISTS (SELECT 1 FROM changes x JOIN fact_versions v ON v.seq = x.seq WHERE x.request_id = r.id AND v.fact_id = ?)`,
    );
    args.push(opts.factId);
  }
  if (opts.since !== undefined) {
    where.push("r.received_at >= ?");
    args.push(opts.since);
  }
  if (opts.text !== undefined && opts.text !== "") {
    where.push("(r.change LIKE ? ESCAPE '\\' OR r.justification LIKE ? ESCAPE '\\')");
    const pattern = likePattern(opts.text);
    args.push(pattern, pattern);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  return store.db
    .prepare(
      `SELECT ${REQUEST_COLUMNS}, c.outcome, c.reject_reason, c.duplicate_of, c.seq AS last_seq
       FROM change_requests r
       LEFT JOIN changes c ON c.seq = (SELECT MAX(seq) FROM changes WHERE request_id = r.id) ${clause}`,
    )
    .all(...args) as JoinedRow[];
}

function keyFor(sort: RequestListSort): (r: JoinedRow) => SortKey {
  return (r) => {
    switch (sort) {
      case RequestListSort.Received:
        return { k: r.received_at, id: r.id };
      case RequestListSort.Finished:
        return { k: r.finished_at, id: r.id };
      case RequestListSort.Duration:
        return { k: durationOf(r), id: r.id };
    }
    return assertNever(sort);
  };
}

/**
 * technical/console.md, "Store API additions", `listRequests`: one page of `change_requests` rows, each joined with its last `changes` row.
 *
 * @param store - the open store
 * @param opts - the filters, the sort (default latest received first) and the page
 * @returns the page; `items` is empty on an empty wiki or past the end
 * @throws {InvalidPageError} when `limit` or `cursor` is invalid
 * @sideEffects none (reads)
 */
export function listRequests(store: Store, opts: ListRequestsOptions = {}): Page<RequestListItem> {
  const sort = opts.sort ?? RequestListSort.Received;
  const page = pageOf(joinedRows(store, opts), keyFor(sort), compareKeys(true), opts);
  const factIds = store.db.prepare("SELECT fact_id FROM fact_versions WHERE seq = ? ORDER BY id");
  const items = page.items.map((r): RequestListItem => ({
    ...toRequestRow(r),
    outcome: r.outcome,
    rejectReason: r.reject_reason,
    duplicateOf: r.duplicate_of,
    factIds: r.last_seq === null ? [] : (factIds.all(r.last_seq) as { fact_id: string }[]).map((f) => f.fact_id),
    durationMs: durationOf(r),
  }));
  return { items, next: page.next };
}

interface ChangeRow {
  seq: number;
  outcome: ChangeOutcome;
  reject_reason: RejectReason | null;
  summary: string;
  duplicate_of: string | null;
  created_at: number;
}

/** A version before its references are labeled. */
type BareVersion = Omit<ChangeVersion, "referenceLabels">;

// Labels every id that the versions reference, in one query over the current versions (L6). A deleted fact keeps its
// last header, and an id without a fact stays unlabeled and reads as unknown.
function labelReferences(store: Store, versions: BareVersion[]): ChangeVersion[] {
  const ids = new Set<string>();
  for (const v of versions) for (const id of [...v.version.references, ...(v.previous?.references ?? [])]) ids.add(id);
  const found = new Map<string, CurrentHeaderRow>();
  if (ids.size > 0) {
    const rows = store.db
      .prepare(
        `SELECT fact_id, header, is_deleted FROM current_fact_versions
         WHERE fact_id IN (SELECT value FROM json_each(?))`,
      )
      .all(JSON.stringify([...ids])) as CurrentHeaderRow[];
    for (const r of rows) found.set(r.fact_id, r);
  }
  const label = (id: string): ReferenceLabel => {
    const row = found.get(id);
    if (row === undefined) return { id, header: null, isDeleted: false };
    return { id, header: row.header, isDeleted: row.is_deleted === 1 };
  };
  return versions.map((v) => ({
    ...v,
    referenceLabels: Object.fromEntries(
      [...v.version.references, ...(v.previous?.references ?? [])].map((id) => [id, label(id)]),
    ),
  }));
}

/**
 * Reads the versions a change wrote, each with the version of the same fact before it and the labels of its references.
 *
 * @param store - the open store
 * @param seq - the seq of the change
 * @returns the versions in write order; `previous` is null for the first version of a fact; `referenceLabels` has one
 *   label per referenced id; a deleted fact has its last header and `isDeleted`, an unknown id a null header
 * @sideEffects none (reads)
 */
export function versionsOfChange(store: Store, seq: number): ChangeVersion[] {
  return labelReferences(store, bareVersionsOfChange(store, seq));
}

function bareVersionsOfChange(store: Store, seq: number): BareVersion[] {
  const rows = store.db
    .prepare(`SELECT ${VERSION_COLUMNS} FROM fact_versions WHERE seq = ? ORDER BY id`)
    .all(seq) as VersionRow[];
  const before = store.db.prepare(
    `SELECT ${VERSION_COLUMNS} FROM fact_versions WHERE fact_id = ? AND seq < ? ORDER BY seq DESC LIMIT 1`,
  );
  const versions = toFactVersions(store, rows);
  return rows.map((r, i): BareVersion => {
    const version = versions[i];
    if (version === undefined) throw new Error(`change ${seq}: no version at position ${i}`);
    const prev = before.get(r.fact_id, seq) as VersionRow | undefined;
    return {
      factId: r.fact_id,
      version,
      previous: prev === undefined ? null : (toFactVersions(store, [prev])[0] ?? null),
    };
  });
}

/**
 * technical/console.md, "Store API additions", `getRequestDetail`: the request page.
 *
 * @param store - the open store
 * @param id - the request id
 * @returns the row with every `changes` row of the request oldest first and the versions each wrote, and the children
 *   of a split in claim order, or null for an unknown id; `changes` is empty while the request has not written one
 * @sideEffects none (reads)
 */
export function getRequestDetail(store: Store, id: string): RequestDetail | null {
  const row = store.db.prepare(`SELECT ${REQUEST_COLUMNS} FROM change_requests r WHERE r.id = ?`).get(id) as
    Row | undefined;
  if (row === undefined) return null;
  const changeRows = store.db
    .prepare(
      `SELECT seq, outcome, reject_reason, summary, duplicate_of, created_at FROM changes
       WHERE request_id = ? ORDER BY seq ASC`,
    )
    .all(id) as ChangeRow[];
  const header = store.db.prepare("SELECT header FROM current_fact_versions WHERE fact_id = ?");
  const bare = changeRows.map((c) => bareVersionsOfChange(store, c.seq));
  // One label query for the whole page, then each change takes its own versions back.
  const labeled = labelReferences(store, bare.flat());
  let at = 0;
  const changes = changeRows.map((c, i): RequestChangeDetail => {
    const dup = c.duplicate_of === null ? undefined : (header.get(c.duplicate_of) as { header: string } | undefined);
    const count = bare[i]?.length ?? 0;
    const versions = labeled.slice(at, at + count);
    at += count;
    return {
      seq: c.seq,
      outcome: c.outcome,
      rejectReason: c.reject_reason,
      summary: c.summary,
      duplicateOf: c.duplicate_of === null ? null : { id: c.duplicate_of, header: dup?.header ?? "" },
      created: c.created_at,
      versions,
    };
  });
  const children = store.db
    .prepare("SELECT id, change, status FROM change_requests WHERE parent_id = ? ORDER BY rowid ASC")
    .all(id) as RequestDetail["children"];
  return { request: toRequestRow(row), children, changes };
}
