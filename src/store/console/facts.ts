// The fact reads of technical/console.md, "Store API additions": the facts list and the fact page. None records a retrieval (design/console.md, "Reads not counted").
import { ChangeOutcome, DeletedFilter, FactListSort, RetrievalKind, assertNever } from "../../domain/enums.js";
import { getDependents } from "../read.js";
import { confidence, confidences, usefulness } from "../scores.js";
import { inList } from "../sql.js";
import type {
  CurrentHeaderRow,
  FactDetail,
  FactDetailVersion,
  FactListItem,
  FactListPage,
  ListFactsOptions,
  Store,
} from "../types/index.js";
import { compareKeys, pageOf, type SortKey } from "./paging.js";
import { observedFlags, toFactVersions, versionRowsOf } from "./versions.js";

interface ListRow {
  version_id: number;
  fact_id: string;
  header: string;
  content: string;
  is_deleted: number;
  seq: number;
  created_at: number;
  versions: number;
}

// The filters of `listFacts` as SQL over the current version `c` of each fact.
function listRows(store: Store, opts: ListFactsOptions): ListRow[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  const deleted = opts.deleted ?? DeletedFilter.Live;
  switch (deleted) {
    case DeletedFilter.Live:
      where.push("c.is_deleted = 0");
      break;
    case DeletedFilter.Deleted:
      where.push("c.is_deleted = 1");
      break;
    case DeletedFilter.All:
      break;
  }
  if (opts.unread) {
    where.push(
      `NOT EXISTS (SELECT 1 FROM retrievals r JOIN fact_versions x ON x.id = r.fact_version_id
                   WHERE x.fact_id = c.fact_id)`,
    );
  }
  if (opts.changedSince !== undefined) {
    where.push("c.seq > ?");
    args.push(opts.changedSince);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  return store.db
    .prepare(
      `SELECT c.id AS version_id, c.fact_id, c.header, c.content, c.is_deleted, c.seq, f.created_at,
              (SELECT COUNT(*) FROM fact_versions x WHERE x.fact_id = c.fact_id) AS versions
       FROM current_fact_versions c JOIN facts f ON f.id = c.fact_id ${clause}`,
    )
    .all(...args) as ListRow[];
}

// The scores of the facts of `rows`, for the filter, the sort or the page.
function scoresOf(store: Store, rows: ListRow[], now: number): { conf: Map<string, number>; use: Map<string, number> } {
  const ids = rows.map((r) => r.fact_id);
  return { conf: confidences(store, ids, now), use: usefulness(store, ids, now) };
}

// The sort key of a row under a sort.
function keyFor(sort: FactListSort, scores: { conf: Map<string, number>; use: Map<string, number> }) {
  return (r: ListRow): SortKey => {
    const id = r.fact_id;
    switch (sort) {
      case FactListSort.Created:
        return { k: r.created_at, id };
      case FactListSort.Changed:
        return { k: r.seq, id };
      case FactListSort.Confidence:
        return { k: scores.conf.get(id) ?? 0, id };
      case FactListSort.Usefulness:
        return { k: scores.use.get(id) ?? 0, id };
      case FactListSort.Versions:
        return { k: r.versions, id };
      case FactListSort.Header:
        return { k: r.header.toLowerCase(), id };
    }
    return assertNever(sort);
  };
}

/**
 * technical/console.md, "Store API additions", `listFacts`: one page of facts with their current version, scores and version count.
 *
 * @param store - the open store
 * @param opts - the clock, the filters (`deleted` defaults to live), the sort (default newest first), the page
 * @returns the page; `items` is empty on an empty wiki or past the end; `total` counts the facts that match every
 *   filter, the confidence range included, over all pages (0 on an empty wiki)
 * @throws {InvalidPageError} when `limit` or `cursor` is invalid
 * @sideEffects none (reads)
 */
export function listFacts(store: Store, opts: ListFactsOptions): FactListPage {
  const sort = opts.sort ?? FactListSort.Created;
  const all = listRows(store, opts);
  const byScore = sort === FactListSort.Confidence || sort === FactListSort.Usefulness;
  const byConfidence = opts.minConfidence !== undefined || opts.maxConfidence !== undefined;
  // Scores of every row are needed only when a score sorts or filters; else the page alone is scored below.
  let scores = byScore || byConfidence ? scoresOf(store, all, opts.now) : undefined;
  const rows = byConfidence
    ? all.filter((r) => {
        const c = scores?.conf.get(r.fact_id) ?? 0;
        return c >= (opts.minConfidence ?? 0) && c <= (opts.maxConfidence ?? 1);
      })
    : all;
  const page = pageOf(
    rows,
    keyFor(sort, scores ?? { conf: new Map(), use: new Map() }),
    compareKeys(sort !== FactListSort.Header),
    opts,
  );
  scores ??= scoresOf(store, page.items, opts.now);
  // The rows already carry every filter, so their count is the total of the same read.
  return { items: toItems(page.items, scores), next: page.next, total: rows.length };
}

// Shapes list rows as items with their scores; the caller gives the scores of every row.
function toItems(rows: ListRow[], scores: { conf: Map<string, number>; use: Map<string, number> }): FactListItem[] {
  return rows.map((r): FactListItem => ({
    id: r.fact_id,
    header: r.header,
    content: r.content,
    confidence: scores.conf.get(r.fact_id) ?? 0,
    usefulness: scores.use.get(r.fact_id) ?? 0,
    versions: r.versions,
    created: r.created_at,
    lastChangedSeq: r.seq,
    isDeleted: r.is_deleted === 1,
  }));
}

/**
 * technical/console.md, "Routes", the export route: every fact with its current version and confidence, in one unpaged
 * read.
 *
 * @param store - the open store
 * @param now - the clock, in ms since the epoch, for the scores
 * @param deleted - true to include the facts whose current version is a deletion
 * @returns every fact, headers A to Z (case-insensitive, ties by id); empty on an empty wiki
 * @sideEffects none (reads)
 */
export function exportFacts(store: Store, now: number, deleted: boolean): FactListItem[] {
  const rows = listRows(store, { now, deleted: deleted ? DeletedFilter.All : DeletedFilter.Live });
  const byHeader = compareKeys(false);
  rows.sort((a, b) =>
    byHeader({ k: a.header.toLowerCase(), id: a.fact_id }, { k: b.header.toLowerCase(), id: b.fact_id }),
  );
  return toItems(rows, scoresOf(store, rows, now));
}

interface ChangeRow {
  seq: number;
  outcome: ChangeOutcome;
  summary: string;
  request_id: string;
  created_at: number;
}

// The headers and live state of facts, by id. Unknown ids are left out.
function headersOf(store: Store, ids: string[]): Map<string, { header: string; isDeleted: boolean }> {
  const out = new Map<string, { header: string; isDeleted: boolean }>();
  if (ids.length === 0) return out;
  const rows = store.db
    .prepare(`SELECT fact_id, header, is_deleted FROM current_fact_versions WHERE fact_id IN (${inList(ids.length)})`)
    .all(...ids) as CurrentHeaderRow[];
  for (const r of rows) out.set(r.fact_id, { header: r.header, isDeleted: r.is_deleted === 1 });
  return out;
}

/**
 * technical/console.md, "Store API additions", `getFactDetail`: the fact page. Every version newest first with its change, its retrieval
 * counts and whether it is observed (technical/lookup.md, "Confidence"), plus the dependents, the references and the scores.
 *
 * @param store - the open store
 * @param id - the fact id
 * @param now - the clock, in ms since the epoch, for the confidence and the usefulness
 * @returns the detail, or null for an unknown id; a deleted fact comes back with `isDeleted: true` and confidence 0
 * @sideEffects none (reads)
 */
export function getFactDetail(store: Store, id: string, now: number): FactDetail | null {
  const rows = versionRowsOf(store, id);
  const current = rows[rows.length - 1];
  if (current === undefined) return null;
  const versions = toFactVersions(store, rows);
  const observed = observedFlags(rows);
  const seqs = rows.map((r) => r.seq);
  const changes = new Map(
    (
      store.db
        .prepare(
          `SELECT seq, outcome, summary, request_id, created_at FROM changes WHERE seq IN (${inList(seqs.length)})`,
        )
        .all(...seqs) as ChangeRow[]
    ).map((c) => [c.seq, c]),
  );
  const versionIds = rows.map((r) => r.id);
  const retrievals = new Map<number, Record<RetrievalKind, number>>();
  const counts = store.db
    .prepare(
      `SELECT fact_version_id AS vid, kind, COUNT(*) AS n FROM retrievals
       WHERE fact_version_id IN (${inList(versionIds.length)}) GROUP BY fact_version_id, kind`,
    )
    .all(...versionIds) as { vid: number; kind: RetrievalKind; n: number }[];
  for (const c of counts) {
    const rec = retrievals.get(c.vid) ?? { [RetrievalKind.Read]: 0, [RetrievalKind.Confirm]: 0 };
    rec[c.kind] = c.n;
    retrievals.set(c.vid, rec);
  }
  const detailVersions = rows.map((r, i): FactDetailVersion => {
    const c = changes.get(r.seq);
    if (c === undefined) throw new Error(`fact ${id}: no changes row for seq ${r.seq}`);
    const version = versions[i];
    if (version === undefined) throw new Error(`fact ${id}: no version at position ${i}`);
    return {
      ...version,
      change: { seq: c.seq, outcome: c.outcome, summary: c.summary, requestId: c.request_id, created: c.created_at },
      retrievals: retrievals.get(r.id) ?? { [RetrievalKind.Read]: 0, [RetrievalKind.Confirm]: 0 },
      observed: observed[i] === true,
    };
  });
  const currentVersion = versions[versions.length - 1];
  const refIds = currentVersion?.references ?? [];
  const refHeaders = headersOf(store, refIds);
  const dependentIds = getDependents(store, id);
  const depHeaders = headersOf(store, dependentIds);
  return {
    id,
    isDeleted: current.is_deleted === 1,
    confidence: confidence(store, id, now),
    usefulness: usefulness(store, [id], now).get(id) ?? 0,
    versions: detailVersions.reverse(),
    dependents: dependentIds.map((d) => ({ id: d, header: depHeaders.get(d)?.header ?? "" })),
    references: refIds.map((r) => {
      const h = refHeaders.get(r);
      return { id: r, header: h?.header ?? "", isDeleted: h?.isDeleted ?? true };
    }),
  };
}
