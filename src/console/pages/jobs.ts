// technical/console.md, "Jobs": what runs by itself, and when, as the last section of the Operation page. 1 row per job: each finder of the
// cleanup and the reindex, each with its interval, its last run, its next run as a condition and its result as a link to the request. "Run"
// asks for the note and goes to the preview of an `operatorEdit` request.
import {
  ChangeOutcome,
  ConsoleAction,
  ConsoleSection,
  DialogId,
  CleanupFinder,
  RequestStatus,
  assertNever,
} from "../../domain/enums.js";
import { jobRows, type CleanupJobRow, type JobRequest, type Store } from "../../store/index.js";
import type { ConsoleWiki } from "../deps.js";
import { act, html, sectionLabel, table, time, type Cell, type HtmlValue, type SafeHtml } from "../html.js";
import { actionPath } from "../write-paths.js";
import { noteField } from "./forms.js";
import { dash, dialogAction, objectPath, panel, statusMarker } from "./parts/index.js";

const REINDEX_NAME = "Rebuild the search index";

/** The anchor of the jobs section on the Operation page: the route of Jobs sends the operator to `/health#jobs`. */
export const JOBS_ANCHOR = "jobs";

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * Names a cleanup job, in the words of design/console.md, "Jobs".
 *
 * @param finder - the finder of the job
 * @returns a verb phrase, for example "Merge duplicate facts"
 * @sideEffects none
 */
export function jobName(finder: CleanupFinder): string {
  switch (finder) {
    case CleanupFinder.DuplicateFact:
      return "Merge duplicate facts";
  }
  return assertNever(finder);
}

/**
 * Says when a cleanup job runs next, as a condition: the trigger is dynamic, so the page shows no time.
 *
 * @param row - the state of the finder
 * @returns "after its repairs" for a finder that waits for the repairs of its last run; else "at the next write" for a finder
 *   that the cap cut; "after the current request" when its interval has passed (it starts when the request that runs ends);
 *   else "in N writes"
 * @sideEffects none
 */
export function nextRun(row: Pick<CleanupJobRow, "pending" | "capped" | "interval" | "writesSince">): string {
  if (row.pending) return "after its repairs";
  if (row.capped) return "at the next write";
  const left = Math.max(0, row.interval - row.writesSince);
  return left === 0 ? "after the current request" : `in ${plural(left, "write")}`;
}

// The result of a cleanup request, as 1 word: queued and running as they are, failed as `failing`, done as `repaired`
// when it wrote a fact and `nothing found` when it wrote nothing.
function repairWord(request: JobRequest): SafeHtml {
  switch (request.status) {
    case RequestStatus.Queued:
    case RequestStatus.Running:
    case RequestStatus.Failed:
      return statusMarker(request.status);
    case RequestStatus.Done:
      return request.outcome === ChangeOutcome.Accepted
        ? html`repaired`
        : html`<span class="muted">nothing found</span>`;
  }
  return assertNever(request.status);
}

// The result of the reindex request: the status as it is, `failing` for a failed one.
const reindexWord = (request: JobRequest): SafeHtml => statusMarker(request.status);

// The word of the result, as a link to the request.
function resultCell(wiki: string, request: JobRequest | null, word: (r: JobRequest) => SafeHtml): SafeHtml {
  if (request === null) return dash();
  return html`<a href="${objectPath(wiki, ConsoleSection.Requests, request.id)}">${word(request)}</a>`;
}

function cleanupRow(wiki: string, row: CleanupJobRow, run: SafeHtml | null): (HtmlValue | Cell)[] {
  return [
    jobName(row.finder),
    plural(row.interval, "write"),
    row.lastRunAt === null ? "never" : time(row.lastRunAt),
    nextRun(row),
    resultCell(wiki, row.lastRequest, repairWord),
    ...(run === null ? [] : [act(run)]),
  ];
}

function reindexRow(wiki: string, last: JobRequest | null, run: SafeHtml | null): (HtmlValue | Cell)[] {
  return [
    REINDEX_NAME,
    "manual",
    last === null ? "never" : time(last.receivedAt),
    dash(),
    resultCell(wiki, last, reindexWord),
    ...(run === null ? [] : [act(run)]),
  ];
}

/** The jobs section of the Operation page: the panel, and the dialogs of its buttons for the end of `main`. */
export interface JobsSection {
  panel: SafeHtml;
  /** The dialogs of the "Run" buttons; empty while the console's writes are off. */
  dialogs: SafeHtml;
}

/**
 * Builds the section "Jobs" of the Operation page (technical/console.md, "Jobs"): `section#jobs`.
 *
 * @param wiki - the wiki
 * @param store - the open read-only store of the wiki
 * @param canWrite - true when the console's writes are on: the "Run" buttons and their dialogs show
 * @returns the panel with one row per finder of the cleanup, then the reindex row, and the dialogs
 * @sideEffects none (reads, through `jobRows`)
 */
export function jobsSection(wiki: ConsoleWiki, store: Store, canWrite: boolean): JobsSection {
  const rows = jobRows(store);
  const cleanup = canWrite
    ? dialogAction(
        {
          id: DialogId.RunCleanup,
          label: "Run",
          title: "Run the cleanup",
          action: actionPath(ConsoleAction.RunCleanup, { w: wiki.name }),
          submit: "Preview",
        },
        html`<p class="help">
            Merges duplicate facts now: runs the duplicate-fact check, also when its interval has not passed.
          </p>
          ${noteField()}`,
      )
    : null;
  const reindex = canWrite
    ? dialogAction(
        {
          id: DialogId.Reindex,
          label: "Run",
          title: REINDEX_NAME,
          action: actionPath(ConsoleAction.Reindex, { w: wiki.name }),
          submit: "Preview",
        },
        html`<p class="help">Rebuilds every index table, in queue order.</p>
          ${noteField()}`,
      )
    : null;
  return {
    panel: panel(
      { title: sectionLabel(ConsoleSection.Jobs), id: JOBS_ANCHOR, span: true },
      table(
        ["Job", "Every", "Last run", "Next run", "Result", ...(canWrite ? [""] : [])],
        [
          ...rows.cleanup.map((r) => cleanupRow(wiki.name, r, cleanup?.button ?? null)),
          reindexRow(wiki.name, rows.reindex, reindex?.button ?? null),
        ],
      ),
    ),
    dialogs: html`${cleanup?.dialog ?? null} ${reindex?.dialog ?? null}`,
  };
}
