// The result types of the browse reads of technical/console.md, "Store API additions": the lists, the detail pages and time
// comparison. The summary, flags, explain and health types are in `console-summary.ts`. Every type here is
// read-only data for a page; nothing is written and no retrieval is recorded.
import type {
  ChangeOutcome,
  DeletedFilter,
  FactListSort,
  RejectReason,
  RequestKind,
  RequestListSort,
  RequestStatus,
  RetrievalKind,
} from "../../domain/enums.js";
import type { FactVersion } from "./results.js";

/** The paging arguments of a list read: `limit` 1 to 200 (default 50) and the `next` of the previous page. */
export interface PageOptions {
  limit?: number;
  /** An opaque string from the `next` of the previous page; absent for the first page. */
  cursor?: string;
}

/** One page of a list: the items and the cursor of the next page, null at the end. */
export interface Page<T> {
  items: T[];
  next: string | null;
}

/** The filters, the sort and the clock of `listFacts`. */
export interface ListFactsOptions extends PageOptions {
  /** The clock, in ms since the epoch, for the confidence and the usefulness. */
  now: number;
  /** Default: live facts only. */
  deleted?: DeletedFilter;
  /** Keep facts whose confidence is at least this, 0 to 1. */
  minConfidence?: number;
  /** Keep facts whose confidence is at most this, 0 to 1. */
  maxConfidence?: number;
  /** Keep facts with no retrieval row on any version. */
  unread?: boolean;
  /** Keep facts whose current version has a seq above this. */
  changedSince?: number;
  /** Default: newest fact first. */
  sort?: FactListSort;
}

/** One page of the facts list with the size of the whole filtered list (technical/console.md, "Facts"). */
export interface FactListPage extends Page<FactListItem> {
  /** The facts that match the filters, over all pages. */
  total: number;
}

/** One row of the facts list (technical/console.md, "Facts"). */
export interface FactListItem {
  id: string;
  header: string;
  content: string;
  /** 0 to 1; 0 for a deleted fact. */
  confidence: number;
  usefulness: number;
  /** The number of versions of the fact. */
  versions: number;
  /** Creation time of the fact, in ms since the epoch. */
  created: number;
  /** The seq of the current version. */
  lastChangedSeq: number;
  isDeleted: boolean;
}

/** The `changes` row a fact version belongs to. */
interface VersionChange {
  seq: number;
  outcome: ChangeOutcome;
  summary: string;
  requestId: string;
  /** In ms since the epoch. */
  created: number;
}

/** One version on the fact page (technical/console.md, "Fact"): the version, its change, its retrievals and its observed flag. */
export interface FactDetailVersion extends FactVersion {
  change: VersionChange;
  /** Retrieval rows on this version, by kind. */
  retrievals: Record<RetrievalKind, number>;
  /**
   * True when the version reset confidence (technical/lookup.md, "Confidence"): its justification is not empty and its content or
   * `is_deleted` differs from the version before it.
   */
  observed: boolean;
}

/** The fact page (technical/console.md, "Fact"). */
export interface FactDetail {
  id: string;
  isDeleted: boolean;
  confidence: number;
  usefulness: number;
  /** Every version, newest first. */
  versions: FactDetailVersion[];
  /** The live facts whose current version references this fact. */
  dependents: { id: string; header: string }[];
  /** The facts the current version references, with their live state. */
  references: { id: string; header: string; isDeleted: boolean }[];
}

/** The filters and the sort of `listRequests`. */
export interface ListRequestsOptions extends PageOptions {
  status?: RequestStatus;
  kind?: RequestKind;
  /** The outcome of the last `changes` row of the request. */
  outcome?: ChangeOutcome;
  rejectReason?: RejectReason;
  /** Keep requests whose changes wrote a version of this fact. */
  factId?: string;
  /** Keep requests received at or after this time, in ms since the epoch. */
  since?: number;
  /** A case-insensitive substring of the `change` or the `justification`. */
  text?: string;
  /** Default: latest received first. */
  sort?: RequestListSort;
}

/** A `change_requests` row with the `started_at` of schema 2. Times are ms since the epoch. */
export interface RequestRow {
  id: string;
  kind: RequestKind;
  status: RequestStatus;
  change: string | null;
  targets: string[];
  justification: string | null;
  priorQuery: string | null;
  attempts: number;
  receivedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
  /** The submission that a split made this request from; null for every other request. */
  parentId: string | null;
}

/** One row of the Requests list (technical/console.md, "Requests"): the request and what its last change recorded. */
export interface RequestListItem extends RequestRow {
  /** Null while the request has no `changes` row (queued, running, failed). */
  outcome: ChangeOutcome | null;
  rejectReason: RejectReason | null;
  duplicateOf: string | null;
  /** The facts the last change wrote a version of. */
  factIds: string[];
  /** `finishedAt - startedAt`, in ms; null without both times. */
  durationMs: number | null;
}

/** A `current_fact_versions` row cut to the header and the deletion flag of a fact. */
export interface CurrentHeaderRow {
  fact_id: string;
  header: string;
  is_deleted: number;
}

/** A fact a version references, as the page shows it (L6: a header link, never a bare id). */
export interface ReferenceLabel {
  id: string;
  /** The current header of the referenced fact, a deleted fact's last header included; null for an unknown id. */
  header: string | null;
  /** True when the referenced fact exists and its current version is a deletion; false for a live or unknown id. */
  isDeleted: boolean;
}

/** A fact version as a change wrote it, with the version before it for a diff. */
export interface ChangeVersion {
  factId: string;
  version: FactVersion;
  /** Null when this is the first version of the fact. */
  previous: FactVersion | null;
  /** The label of every id in `version.references` and in `previous.references`, keyed by id. */
  referenceLabels: Record<string, ReferenceLabel>;
}

/** One `changes` row on the request page (technical/console.md, "Request"), with its versions. */
export interface RequestChangeDetail {
  seq: number;
  outcome: ChangeOutcome;
  rejectReason: RejectReason | null;
  summary: string;
  /** For a duplicate: the fact it confirmed, with its current header. */
  duplicateOf: { id: string; header: string } | null;
  /** In ms since the epoch. */
  created: number;
  versions: ChangeVersion[];
}

/** The request page (technical/console.md, "Request"). */
export interface RequestDetail {
  request: RequestRow;
  /** The requests that a split made from this one, in claim order, each with its claim and its status; empty for a request that was not split. */
  children: { id: string; change: string | null; status: RequestStatus }[];
  /** Every `changes` row of the request, oldest first: a merge comes before the request's own change. */
  changes: RequestChangeDetail[];
}

/** The filters of `listChanges`. */
export interface ListChangesOptions extends PageOptions {
  outcome?: ChangeOutcome;
  /** The kind of the request that produced the change. */
  kind?: RequestKind;
  /** Keep changes that wrote a version of this fact. */
  factId?: string;
  /** Keep changes with a seq at or above this. */
  fromSeq?: number;
  /** Keep changes with a seq at or below this. */
  toSeq?: number;
}

/** One row of the audit trail, read by the change page (technical/console.md, "Change"). */
export interface ChangeListItem {
  seq: number;
  requestId: string;
  requestKind: RequestKind;
  outcome: ChangeOutcome;
  rejectReason: RejectReason | null;
  summary: string;
  duplicateOf: string | null;
  /** In ms since the epoch. */
  created: number;
  /** The operator's note of an `operatorEdit` request's document; absent for any other kind, or an unreadable document. */
  note?: string;
  versions: { factId: string; header: string; isDeleted: boolean; isNew: boolean }[];
}
