// technical/console.md, "Request": the request page. The change text and the justification as stored (requirements/console.md, "Stored text"), the facts of the request,
// the times, every `changes` row with its versions and the word diff of each against the version before, and the trace
// from the worker log in the words of the design documents (requirements/console.md, "Plain words"): a step is named by what it does, never by a question
// id. The page follows a queued or running request.
import { z } from "zod";
import {
  ChangeOutcome,
  CleanupFinder,
  ConsoleErrorKind,
  ConsoleSection,
  GridColumns,
  LogEvent,
  LogProcess,
  RequestKind,
  RunOnceStatus,
  CleanupRepairResult,
  assertNever,
  isMember,
} from "../../domain/enums.js";
import { logBaseName } from "../../log/index.js";
import type { RequestChangeDetail, RequestDetail, RequestRow, Store } from "../../store/index.js";
import { getFact, getRequest, getRequestDetail } from "../../store/index.js";
import { DEFAULT_RETRY_DELAY_MS } from "../../updates/index.js";
import { ConsoleError } from "../errors.js";
import { durationText, html, layout, table, time, type SafeHtml } from "../html.js";
import { MAX_TAIL_LINES, isRawLine, readLogTail, type LogRecord, type LogTailLine } from "../logs.js";
import type { PageContext } from "../page.js";
import { QUEUE_REFRESH_SECONDS, followsQueue } from "./requests.js";
import { versionTimeline } from "./request-versions.js";
import { changeNames, changeWords, editName, editRows, finderName, kindLabel, readEdit } from "./operator-edit.js";
import {
  column,
  empty,
  factLink,
  grid,
  kv,
  notice,
  objectPath,
  outcomeMarker,
  panel,
  parseQuery,
  quote,
  requestLink,
  resultMarker,
  statusMarker,
  withWiki,
  type KvRow,
} from "./parts/index.js";

/** The sentence of the Trace panel when the log holds no line of the request (technical/console.md, "Request"). */
const NO_TRACE =
  "No trace. The log window of 50 MB per file set has rolled past this request, or the worker ran elsewhere.";

const requestQuery = z.object({});

/** The `tokens` object of a `change` line; anything else reads as no counts. */
const tokenFields = z.record(z.string(), z.unknown()).catch({});

// The facts a request names, one per line.
function targetList(store: Store, wiki: string, targets: string[], now: number): SafeHtml {
  const items = targets.map((id): SafeHtml => {
    const fact = getFact(store, id, { now });
    if (fact !== null) {
      const state = fact.isDeleted ? html` <span class="muted">(deleted)</span>` : null;
      return html`fact ${factLink(wiki, id, fact.current.header)}${state}`;
    }
    return html`<code>${id}</code> <span class="muted">(unknown id)</span>`;
  });
  return html`${items.flatMap((item, i) => (i === 0 ? [item] : [html`<br />`, item]))}`;
}

// The rows of the Timing panel: received, started with the wait after it, finished with the duration after it, the
// failed attempts, and the duplicate target, the targets and the prior query when the request has them.
function timingRows(
  wiki: string,
  r: RequestRow,
  links: {
    duplicateOf: { id: string; header: string } | null;
    parent: Pick<RequestRow, "id" | "receivedAt"> | null;
    targets: SafeHtml | null;
  },
): KvRow[] {
  const { duplicateOf, parent, targets } = links;
  // `attempts` counts the failed attempts (technical/updates.md, "Queue and worker"): the worker raises it on an API or model error only.
  const wait = followsQueue(r.status) ? html`, next try in ${durationText(r.attempts * DEFAULT_RETRY_DELAY_MS)}` : null;
  return [
    { term: "Received", value: time(r.receivedAt, { seconds: true }) },
    ...(r.startedAt === null
      ? []
      : [
          {
            term: "Started",
            value: html`${time(r.startedAt, { seconds: true })}, waited ${durationText(r.startedAt - r.receivedAt)}`,
          },
        ]),
    ...(r.finishedAt === null
      ? []
      : [
          {
            term: "Finished",
            value: html`${time(r.finishedAt, { seconds: true })}${r.startedAt === null ? null : html`, took ${durationText(r.finishedAt - r.startedAt)}`}`,
          },
        ]),
    ...(r.attempts === 0 ? [] : [{ term: "Failed attempts", value: html`${r.attempts}${wait}` }]),
    ...(duplicateOf === null
      ? []
      : [{ term: "Duplicate of", value: factLink(wiki, duplicateOf.id, duplicateOf.header) }]),
    ...(parent === null
      ? []
      : [
          {
            term: "Split from",
            value: html`<a href="${objectPath(wiki, ConsoleSection.Requests, parent.id)}"
              >${time(parent.receivedAt)}</a
            >`,
          },
        ]),
    ...(targets === null ? [] : [{ term: "Targets", value: targets }]),
    ...(r.priorQuery === null || r.priorQuery === "" ? [] : [{ term: "Prior query", value: r.priorQuery }]),
  ];
}

// The Split panel of a request that a split made into children (technical/submit.md, "Split of a compound submission"): one row per claim, with the link to its request.
function childrenPanel(wiki: string, children: RequestDetail["children"]): SafeHtml | null {
  if (children.length === 0) return null;
  return panel(
    { title: "Split into" },
    table(
      ["Request", "Claim", "Status"],
      children.map((c) => [requestLink(wiki, c.id), c.change ?? "", statusMarker(c.status)]),
    ),
  );
}

function changePanel(wiki: string, c: RequestChangeDetail, own: boolean): SafeHtml {
  return panel(
    {
      title: own ? "Result" : "Merge before this request",
      note: html`${outcomeMarker(c.outcome, c.rejectReason)} ${time(c.created)}`,
    },
    versionTimeline(wiki, c.versions),
  );
}

function count(v: unknown): string {
  return typeof v === "number" ? String(v) : "?";
}

function word(v: unknown): string {
  return typeof v === "string" ? v : "?";
}

// A number of a log field; anything else reads as 0.
const amount = (v: unknown): number => (typeof v === "number" ? v : 0);

const grouped = (n: number): string => n.toLocaleString("en-US");

// The `change` lines of the worker log as 4 rows, summed over the lines: `tokens`, `duration_ms`, `passes` and `rejudged`
// by what they mean.
function changeRows(lines: LogRecord[]): KvRow[] {
  const sum = (pick: (f: Record<string, unknown>) => unknown): number =>
    lines.reduce((total, line) => total + amount(pick(line.fields)), 0);
  const tokens = (key: string) => (f: Record<string, unknown>) => tokenFields.parse(f.tokens)[key];
  return [
    { term: "Model tokens", value: `${grouped(sum(tokens("input")))} in, ${grouped(sum(tokens("output")))} out` },
    { term: "Duration", value: durationText(sum((f) => f.duration_ms)) },
    { term: "Dependents checked", value: grouped(sum((f) => f.passes)) },
    { term: "Dependents re-judged", value: grouped(sum((f) => f.rejudged)) },
  ];
}

/** The term of a trace row for a line that is not a change, in plain words. */
const TRACE_TERMS: Partial<Record<LogEvent, string>> = {
  [LogEvent.Gather]: "Claim check",
  [LogEvent.Scope]: "Scope match",
  [LogEvent.Judge]: "Judge",
  [LogEvent.ScopeOvermatch]: "Sibling scope",
  [LogEvent.PriorQuery]: "Prior query check",
  [LogEvent.LookupRepair]: "Lookup repair",
  [LogEvent.CleanupRepair]: "Cleanup",
  [LogEvent.AttemptFailed]: "Failed attempt",
};

const traceTerm = (rec: LogRecord): string =>
  (isMember(LogEvent, rec.event) ? TRACE_TERMS[rec.event] : undefined) ?? rec.event ?? "Log line";

/**
 * Says what a line of the worker log means, in the words of the design documents (requirements/console.md, "Plain words").
 *
 * @param wiki - the wiki name, for the links
 * @param rec - the parsed line
 * @returns the sentence
 * @sideEffects none
 */
export function traceWords(wiki: string, rec: LogRecord): SafeHtml {
  const f = rec.fields;
  const words = isMember(LogEvent, rec.event) ? TRACE_WORDS[rec.event] : undefined;
  if (words === undefined) return html`${rec.event ?? "?"} <code>${JSON.stringify(f)}</code>`;
  return words(wiki, f);
}

function repairResultName(result: CleanupRepairResult): string {
  switch (result) {
    case CleanupRepairResult.Stale:
      return "found the candidate stale";
    case CleanupRepairResult.NoChange:
      return "judged the candidate and made no change";
  }
  return assertNever(result);
}

// The `cleanup_repair` line: a cleanupRepair request that wrote nothing (technical/cleanup.md, "Cleanup").
function cleanupRepairWords(_wiki: string, f: Record<string, unknown>): SafeHtml {
  const finder = isMember(CleanupFinder, f.finder) ? finderName(f.finder) : "the cleanup";
  const result = isMember(CleanupRepairResult, f.result) ? repairResultName(f.result) : "made no change";
  return html`${finder} ${result}: ${word(f.reason)}`;
}

/** The lines of the worker log that carry a request id (technical/deployment.md, "Logging", `src/log/line.ts`), each in words. */
const TRACE_WORDS: Partial<Record<LogEvent, (wiki: string, f: Record<string, unknown>) => SafeHtml>> = {
  [LogEvent.Gather]: (_wiki, f) =>
    html`the claim check dropped a target that is no fact: <code>${word(f.droppedTarget)}</code>`,
  [LogEvent.Scope]: (wiki, f) =>
    html`the scope match named a fact that was not a candidate, dropped: ${factLink(wiki, word(f.droppedMatch))}`,
  [LogEvent.Judge]: (wiki, f) =>
    html`the judge named a related fact that was not gathered, dropped: ${factLink(wiki, word(f.droppedWrongRelated))}`,
  [LogEvent.ScopeOvermatch]: (wiki, f) =>
    html`the judge found the matched fact to be a sibling scope, so the claim became a new fact; the existing fact:
    ${factLink(wiki, word(f.existingFactId))}; reason: ${word(f.reason)}`,
  [LogEvent.PriorQuery]: (wiki, f) => {
    const repair = typeof f.repairRequestId === "string" ? html`; repair request ${f.repairRequestId}` : null;
    const fact = typeof f.factId === "string" ? html`; fact ${factLink(wiki, f.factId)}` : null;
    const error = typeof f.error === "string" ? html`; error: ${f.error}` : null;
    return html`the prior query check: ${word(f.result)}${repair}${fact}${error}`;
  },
  [LogEvent.LookupRepair]: (_wiki, f) => html`the lookup repair was skipped: ${word(f.skipped)}`,
  [LogEvent.CleanupRepair]: cleanupRepairWords,
  [LogEvent.AttemptFailed]: (_wiki, f) => {
    const end =
      f.status === RunOnceStatus.Failed ? "the request failed for good" : "the request went back to the queue";
    return html`attempt ${count(f.attempt)} failed, ${end}: ${word(f.error)}`;
  },
};

// The trace as a key-value list, oldest line first: the change lines as 4 summed rows, every other line as 1 row.
function traceRows(wiki: string, lines: LogTailLine[]): KvRow[] {
  const records = lines.filter((l): l is LogRecord => !isRawLine(l));
  const changes = records.filter((r) => r.event === LogEvent.Change);
  const others = lines.flatMap((line): KvRow[] => {
    if (isRawLine(line)) return [{ term: "Log line", value: html`<code>${line.raw}</code>` }];
    if (line.event === LogEvent.Change) return [];
    return [{ term: traceTerm(line), value: traceWords(wiki, line) }];
  });
  return [...(changes.length === 0 ? [] : changeRows(changes)), ...others];
}

// The lines of the worker log that carry the request; no line is older than the request itself, so the read stops at
// its receive time instead of walking the whole file set.
function tracePanel(wiki: string, request: RequestRow, logDir: string | undefined): SafeHtml {
  const tail = readLogTail(logDir, logBaseName(LogProcess.Worker, wiki), {
    request: request.id,
    limit: MAX_TAIL_LINES,
    since: request.receivedAt,
  });
  if (tail.note !== undefined) return panel({ title: "Trace" }, empty(`No trace: ${tail.note}.`));
  if (tail.items.length === 0) return panel({ title: "Trace" }, empty(NO_TRACE));
  return panel({ title: "Trace" }, kv(traceRows(wiki, tail.items.reverse())));
}

// The Submission panel: the change text and the justification as stored (requirements/console.md, "Stored text"); an operator edit as its document, and an
// operator edit or a cleanup request also in words with links (`words`).
function submissionPanel(r: RequestRow, words: SafeHtml | undefined): SafeHtml {
  const edit = r.kind === RequestKind.OperatorEdit ? readEdit(r.change) : undefined;
  if (edit !== undefined) {
    const [head, ...rest] = editRows(edit);
    const said: KvRow[] = words === undefined ? [] : [{ term: "Change", value: words }];
    return panel({ title: "Submission" }, kv([...(head === undefined ? [] : [head]), ...said, ...rest]));
  }
  const text =
    r.change === null || r.change === ""
      ? empty("No text: a lookup repair has no change text.")
      : words === undefined
        ? quote(r.change)
        : html`<p>${words}</p>`;
  const justification =
    r.justification === null || r.justification === "" ? null : quote(r.justification, "Justification");
  return panel({ title: "Submission" }, html`${text}${justification}`);
}

/**
 * Renders the request page at `GET /console/w/:w/requests/:id`.
 *
 * @param ctx - the deps, the wiki in `params.w` and the request in `params.id`
 * @returns the HTML document; it refreshes in place while the request is queued or running
 * @throws {ConsoleError} `NotFound` for an unknown wiki or request
 * @sideEffects opens and closes one read-only store; reads the clock once; reads the lock file and signals its pid
 *   with 0 for the status pill; reads the worker log files back to the request's receive time
 */
export async function requestPage(ctx: PageContext): Promise<string> {
  parseQuery(ctx.query, requestQuery);
  const id = ctx.params.id ?? "";
  return withWiki(ctx, ({ wiki, store, now, frame }) => {
    const detail = getRequestDetail(store, id);
    if (detail === null) throw new ConsoleError(ConsoleErrorKind.NotFound, `no request "${id}" in ${wiki.name}`);
    const r = detail.request;
    const parent = r.parentId === null ? null : getRequest(store, r.parentId);
    const last = detail.changes.at(-1);
    const edit = r.kind === RequestKind.OperatorEdit ? readEdit(r.change) : undefined;
    const words = changeWords(changeNames(store, [r]), wiki.name, r);
    const refresh = followsQueue(r.status) ? { refreshSeconds: QUEUE_REFRESH_SECONDS } : {};
    const targets = r.targets.length === 0 ? null : targetList(store, wiki.name, r.targets, now);
    const results = detail.changes.map((c, i) => changePanel(wiki.name, c, i === detail.changes.length - 1));
    // A rejected request stores the reason of the rejection in the same column as a failure's error.
    const rejected = last?.outcome === ChangeOutcome.Rejected;
    const failure =
      r.error === null ? null : panel({ title: rejected ? "Reason" : "Error" }, notice(r.error, !rejected));
    const noResult =
      detail.changes.length === 0 && r.error === null ? panel({ title: "Result" }, empty("No change yet.")) : null;
    return layout(
      {
        ...frame,
        section: ConsoleSection.Requests,
        title: "Request",
        badge: resultMarker(r.status, last?.outcome ?? null, last?.rejectReason ?? null),
        lead: html`${kindLabel(r.kind)}${edit === undefined ? null : html` (${editName(edit.edit)})`}, received
        ${time(r.receivedAt)}`,
        ...refresh,
      },
      html`${grid(GridColumns.MainSide, [
        column([
          submissionPanel(r, words),
          failure,
          childrenPanel(wiki.name, detail.children),
          ...results,
          noResult,
          tracePanel(wiki.name, r, ctx.deps.service().logDir),
        ]),
        column([
          panel(
            { title: "Timing" },
            kv(timingRows(wiki.name, r, { duplicateOf: last?.duplicateOf ?? null, parent, targets })),
          ),
        ]),
      ])}`,
    );
  });
}
