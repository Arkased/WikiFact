// technical/console.md, "Requests": the requests page. One timeline of what happened to the wiki, newest first: a row per change request
// with what it wrote, over `listActivity`. The filters are a toolbar, so the URL holds them; the sort is a link in the
// column header. The page refreshes in place when the status filter follows the queue (`queued` or `running`).
import { z } from "zod";
import {
  ChangeOutcome,
  ConsoleSection,
  RejectReason,
  RequestKind,
  RequestListSort,
  RequestStatus,
  TableCellClass,
  isMember,
} from "../../domain/enums.js";
import { listActivity, type ActivityItem, type IdNames, type ListRequestsOptions } from "../../store/index.js";
import {
  durationText,
  html,
  layout,
  num,
  sectionLabel,
  table,
  time,
  type Cell,
  type HtmlValue,
  type SafeHtml,
  type SortHeader,
} from "../html.js";
import type { PageContext } from "../page.js";
import { changeNames, changeWords, kindLabel, readEdit } from "./operator-edit.js";
import {
  CONTENT_PREVIEW,
  dash,
  dateField,
  enumSelect,
  factLink,
  filterField,
  hrefWith,
  objectPath,
  optionSelect,
  paging,
  parseQuery,
  queryInt,
  queryTime,
  resultMarker,
  segmented,
  sortHeader,
  textField,
  toolbar,
  withWiki,
  writeMarker,
  type AppliedFilter,
} from "./parts/index.js";

/** How often a page that follows the queue reloads, in seconds (technical/console.md, "Architecture"). */
export const QUEUE_REFRESH_SECONDS = 15;

const requestsQuery = z.object({
  status: z.enum(RequestStatus).optional(),
  kind: z.enum(RequestKind).optional(),
  outcome: z.enum(ChangeOutcome).optional(),
  rejectReason: z.enum(RejectReason).optional(),
  fact: z.string().optional(),
  q: z.string().optional(),
  since: queryTime.optional(),
  sort: z.enum(RequestListSort).default(RequestListSort.Received),
  limit: queryInt.optional(),
  cursor: z.string().optional(),
});

type RequestsQuery = z.infer<typeof requestsQuery>;

/** The filters of the toolbar other than the status, which the segmented control shows: parameter and chip label. */
const CHIP_FILTERS: [param: string, label: string][] = [
  ["outcome", "Outcome"],
  ["kind", "Kind"],
  ["rejectReason", "Reject reason"],
  ["fact", "Fact"],
  ["q", "Text"],
  ["since", "Since"],
];

/** The length of `YYYY-MM-DD`. */
const DATE_LENGTH = 10;

// The `YYYY-MM-DD` of a time that the query holds as a date or as unix milliseconds; the text itself when it is neither.
function dateText(text: string): string {
  const ms = /^\d+$/.test(text) ? Number(text) : Date.parse(text);
  return Number.isNaN(ms) ? text : new Date(ms).toISOString().slice(0, DATE_LENGTH);
}

// The words a chip shows for the value of a filter: the plain words of a kind, the date of a time, else the value.
function chipValue(param: string, value: string): string {
  if (param === "kind") return isMember(RequestKind, value) ? kindLabel(value) : value;
  return param === "since" ? dateText(value) : value;
}

function listOptions(q: RequestsQuery): ListRequestsOptions {
  return {
    sort: q.sort,
    ...(q.status === undefined ? {} : { status: q.status }),
    ...(q.kind === undefined ? {} : { kind: q.kind }),
    ...(q.outcome === undefined ? {} : { outcome: q.outcome }),
    ...(q.rejectReason === undefined ? {} : { rejectReason: q.rejectReason }),
    ...(q.fact === undefined ? {} : { factId: q.fact }),
    ...(q.q === undefined ? {} : { text: q.q }),
    ...(q.since === undefined ? {} : { since: q.since }),
    ...(q.limit === undefined ? {} : { limit: q.limit }),
    ...(q.cursor === undefined ? {} : { cursor: q.cursor }),
  };
}

// The status control is a set of links, so the form carries the status and the sort as hidden fields: an Apply keeps
// both.
function statusControl(query: URLSearchParams, current: RequestStatus | undefined): SafeHtml {
  const item = (
    label: string,
    value: RequestStatus | undefined,
  ): { label: string; href: string; current: boolean } => ({
    label,
    href: hrefWith(query, { status: value, cursor: undefined }),
    current: value === current,
  });
  return segmented("Status", [item("All", undefined), ...Object.values(RequestStatus).map((s) => item(s, s))]);
}

function filters(query: URLSearchParams, q: RequestsQuery): SafeHtml {
  const applied: AppliedFilter[] = CHIP_FILTERS.flatMap(([param, label]): AppliedFilter[] => {
    const value = query.get(param);
    if (value === null || value === "") return [];
    return [
      { label, value: chipValue(param, value), href: hrefWith(query, { [param]: undefined, cursor: undefined }) },
    ];
  });
  return toolbar({
    fields: [
      statusControl(query, q.status),
      enumSelect("outcome", "Outcome", ChangeOutcome, q.outcome),
      filterField("q", "Filter by text", q.q),
    ],
    hidden: [...(q.status === undefined ? [] : [{ name: "status", value: q.status }]), { name: "sort", value: q.sort }],
    more: [
      optionSelect(
        "kind",
        "Kind",
        Object.values(RequestKind).map((k) => ({ value: k, label: kindLabel(k) })),
        q.kind,
      ),
      enumSelect("rejectReason", "Reject reason", RejectReason, q.rejectReason),
      textField("fact", "Fact", q.fact),
      dateField("since", "Since", q.since === undefined ? undefined : dateText(String(q.since))),
    ],
    applied,
  });
}

/**
 * Says whether a request is still in the queue, so its page should follow it.
 *
 * @param status - the status of the request
 * @returns true for `queued` and `running`
 * @sideEffects none
 */
export function followsQueue(status: RequestStatus): boolean {
  return status === RequestStatus.Queued || status === RequestStatus.Running;
}

// An operator edit and a cleanup request show in words with links, never as the JSON document (the request page has
// the document). Other text is cut here and by the style sheet; the full text is on the request page (L5).
function changeText(names: IdNames, wiki: string, r: ActivityItem): HtmlValue {
  if (r.change === null) return html`<span class="muted">(repair)</span>`;
  const words = changeWords(names, wiki, r);
  if (words !== undefined) {
    const note = r.kind === RequestKind.OperatorEdit ? readEdit(r.change)?.note : undefined;
    return html`${words}${note === undefined ? null : html`<br /><span class="help">${note}</span>`}`;
  }
  return r.change.length > CONTENT_PREVIEW ? `${r.change.slice(0, CONTENT_PREVIEW)}…` : r.change;
}

// The change text, and under it one line with the facts the request wrote.
function changeCell(names: IdNames, wiki: string, r: ActivityItem): Cell {
  const wrote =
    r.wrote.length === 0
      ? null
      : html`<br /><span class="help"
            >${r.wrote.map((w, i) => html`${i === 0 ? null : ", "}${factLink(wiki, w.factId, w.header)} ${writeMarker(w.kind)}`)}</span
          >`;
  return { cell: html`${changeText(names, wiki, r)}${wrote}`, cls: TableCellClass.Wide };
}

function row(names: IdNames, wiki: string, r: ActivityItem): (HtmlValue | Cell)[] {
  return [
    html`<a href="${objectPath(wiki, ConsoleSection.Requests, r.id)}">${time(r.receivedAt)}</a>`,
    kindLabel(r.kind),
    resultMarker(r.status, r.outcome, r.rejectReason),
    changeCell(names, wiki, r),
    r.durationMs === null ? num(dash()) : num(durationText(r.durationMs)),
  ];
}

/**
 * Renders the requests page at `GET /console/w/:w/requests`.
 *
 * @param ctx - the deps, the wiki in `params.w` and the filters of technical/console.md, "Routes" in the query
 * @returns the HTML document: the toolbar with the applied chips, the table and the next-page control; it refreshes in
 *   place when the status filter is `queued` or `running`
 * @throws {ConsoleError} `NotFound` for an unknown wiki; `ZodError` for a bad query
 * @sideEffects opens and closes one read-only store; reads the clock once; reads the lock file and signals its pid
 *   with 0 for the status pill
 */
export async function requestsPage(ctx: PageContext): Promise<string> {
  const q = parseQuery(ctx.query, requestsQuery);
  return withWiki(ctx, ({ wiki, store, frame }) => {
    const page = listActivity(store, listOptions(q));
    const names = changeNames(store, page.items);
    const sort = (key: RequestListSort, label: string): SortHeader => sortHeader(ctx.query, key, label, q.sort);
    const refresh = q.status !== undefined && followsQueue(q.status) ? { refreshSeconds: QUEUE_REFRESH_SECONDS } : {};
    return layout(
      {
        ...frame,
        section: ConsoleSection.Requests,
        title: sectionLabel(ConsoleSection.Requests),
        ...refresh,
      },
      html`${filters(ctx.query, q)}
      ${table(
        [
          sort(RequestListSort.Received, "Received"),
          "Kind",
          "Result",
          "Change",
          sort(RequestListSort.Duration, "Duration"),
        ],
        page.items.map((r) => row(names, wiki.name, r)),
        { empty: "No request matches the filters." },
      )}
      ${paging(ctx.query, page.next)}`,
    );
  });
}
