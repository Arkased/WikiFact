// technical/console.md, "Service health": the "Queue worker" panels of the Operation page (right of its grid): its present (the state with the control of
// the queue, the queue, the rate) above its last 24 hours (the requests processed per hour above the queue length per hour, then the
// failures, the restarts and the time per request).
import { ConsoleAction, ConsoleSection, DialogId, HealthLevel, HealthRow, PauseReason } from "../../domain/enums.js";
import type { RequestListItem } from "../../store/index.js";
import { CHART_WIDTH, lineChart, stackedBars } from "../charts.js";
import { rateLimitPaused, waitText, workerRunning } from "../health.js";
import { durationText, html, num, table, time, type HtmlValue, type SafeHtml } from "../html.js";
import { actionPath } from "../write-paths.js";
import { count, hourLabels, levelOf, untilText, clock, type Facts } from "./health-facts.js";
import { CONFIRM_FIELD, noteField } from "./forms.js";
import {
  column,
  dash,
  dialogAction,
  fold,
  objectPath,
  panel,
  plot,
  quote,
  stats,
  type DialogAction,
} from "./parts/index.js";

/** The error of a failed request is cut to this many characters in the table; the fold holds the rest. */
const ERROR_PREVIEW = 160;

/** What the caption of the processed requests says that "processed" counts. */
const PROCESSED_DEFINITION = "Accepted, duplicate, rejected or failed. A split is not counted: its children are.";

/**
 * Builds the control of the queue (technical/console.md, "Service health"): 1 compact button for the head of "Queue worker, now"
 * that opens a dialog. The dialog is the confirmation, so its form posts `confirm=1`. It reads the key itself, so it changes
 * at the next refresh after the write. Remote mode has no control, as for every write.
 *
 * @param f - what the page reads
 * @returns the button and the dialog; `null` where the console does not write
 * @sideEffects none
 */
export function queueControl(f: Facts): DialogAction | null {
  if (!f.canWrite) return null;
  const w = f.wiki.name;
  if (f.pause === undefined) {
    return dialogAction(
      {
        id: DialogId.PauseQueue,
        label: "Pause",
        title: "Pause the queue",
        action: actionPath(ConsoleAction.PauseQueue, { w }),
        confirmed: true,
      },
      html`<p class="help">
          The worker finishes the request that runs now, then starts no request until you resume. Agents can still send
          change requests: they wait in the queue.
        </p>
        ${noteField("Shown on Operation while the queue is paused")}`,
    );
  }
  return dialogAction(
    {
      id: DialogId.ResumeQueue,
      label: "Resume",
      title: "Resume the queue",
      action: actionPath(ConsoleAction.ResumeQueue, { w }),
      confirmed: true,
    },
    html`<p class="help">
      The worker takes the next of the ${count(f.queued, "queued request", "queued requests")} at its next poll.
    </p>`,
  );
}

/**
 * Builds the button "Run a batch now" (technical/console.md, "Service health"): a form with no dialog and no preview that posts
 * `confirm=1` to the batch route. It is disabled when no submission is queued. Remote mode has no button, as for every write.
 *
 * @param f - what the page reads
 * @returns the button, for the head of "Queue worker, now"; `null` where the console does not write
 * @sideEffects none
 */
export function batchControl(f: Facts): { button: SafeHtml } | null {
  if (!f.canWrite) return null;
  const action = actionPath(ConsoleAction.RunBatch, { w: f.wiki.name });
  const field = html`<input type="hidden" name="${CONFIRM_FIELD}" value="1" />`;
  const button =
    f.queuedSubmissions === 0
      ? html`<button type="submit" disabled>Run a batch now</button>`
      : html`<button type="submit">Run a batch now</button>`;
  return { button: html`<form method="post" action="${action}">${field}${button}</form>` };
}

// What the paused State stat says under the number: the end of the rate limit (with its date when it is not today), or the operator and the time of the pause.
function pausedUnder(f: Facts): string | null {
  const { status, pause } = f;
  if (status !== undefined && rateLimitPaused(status)) {
    const reason = status.pauseReason ?? PauseReason.RateLimit;
    return status.pausedUntil === undefined ? reason : `${reason}, until ${untilText(status.pausedUntil, f.now)}`;
  }
  if (pause !== undefined) return `${PauseReason.Operator}, ${clock(status?.pausedSince ?? pause.at)}`;
  return null;
}

/**
 * Builds the panel "Queue worker, now": the state, the queue and the rate, with the controls in the head.
 *
 * @param f - what the page reads
 * @param controls - the controls from `batchControl` then `queueControl`; their buttons go in the head in that order, none
 *   where the console does not write
 * @returns the panel, the right cell of the first row of the grid
 * @sideEffects none
 */
export function nowPanel(f: Facts, controls: ({ button: SafeHtml } | null)[]): SafeHtml {
  const { wiki, status } = f;
  const paused =
    workerRunning(wiki, status, f.now) && ((status !== undefined && rateLimitPaused(status)) || f.pause !== undefined);
  const polled = status === undefined ? "no poll yet" : `polled ${durationText(f.now - status.lastPollAt)} ago`;
  const buttons = controls.flatMap((c) => (c === null ? [] : [c.button]));
  return panel(
    { title: "Queue worker, now", ...(buttons.length === 0 ? {} : { aside: buttons }) },
    stats([
      {
        label: "State",
        value: paused ? "paused" : workerRunning(wiki, status, f.now) ? "running" : "stopped",
        level: levelOf(f.report, HealthRow.Worker),
        under: (paused ? pausedUnder(f) : null) ?? polled,
      },
      // No request runs while the key exists, so a wait would be false.
      { label: "Queue", value: f.queued, under: f.pause === undefined ? waitText(f.waitMs) : "on hold" },
      { label: "Rate", value: f.throughput.lastHour, under: "per hour" },
    ]),
  );
}

// The error of a failed request, cut to a short text with the whole text in a fold.
function errorCell(error: string | null): HtmlValue {
  if (error === null) return dash();
  if (error.length <= ERROR_PREVIEW) return error;
  return html`${error.slice(0, ERROR_PREVIEW)}… ${fold("Full error", quote(error))}`;
}

function failedTable(wiki: string, failed: RequestListItem[]): SafeHtml {
  return table(
    ["Received", "Failed at", "Attempts", "Error"],
    failed.map((r) => [
      html`<a href="${objectPath(wiki, ConsoleSection.Requests, r.id)}">${time(r.receivedAt)}</a>`,
      r.finishedAt === null ? dash() : time(r.finishedAt),
      num(r.attempts),
      errorCell(r.error),
    ]),
  );
}

/**
 * Builds the panel "Queue worker, 24 hours": two charts on 1 time axis, then the failures with their table (only when there is 1), the restarts and the time per request.
 *
 * @param f - what the page reads
 * @returns the panel, the right cell of the second row of the grid
 * @sideEffects none
 */
export function historyPanel(f: Facts): SafeHtml {
  const { buckets } = f.throughput;
  const labels = hourLabels(buckets.map((b) => b.startMs));
  const width = CHART_WIDTH.half;
  const restarts = f.wiki.workerRestarts;
  const { meanMs } = f.throughput;
  return panel(
    { title: "Queue worker, 24 hours" },
    column([
      plot(
        "Change requests processed per hour",
        stackedBars(
          labels,
          [{ name: "requests", values: buckets.map((b) => b.accepted + b.duplicate + b.rejected + b.failed) }],
          { width, empty: "No request in 24 hours", xTitle: "hour", yTitle: "requests" },
        ),
        { definition: PROCESSED_DEFINITION },
      ),
      plot(
        "Queue length per hour",
        lineChart(labels, [{ name: "queued", values: f.queueSeries }], {
          width,
          empty: "No request waited in 24 hours",
          xTitle: "hour",
          yTitle: "requests",
          inSlots: true,
        }),
      ),
      stats([
        {
          label: "Failed change requests",
          value: f.failed.length,
          level: levelOf(f.report, HealthRow.FailedRequests),
        },
        {
          label: "Restarts",
          value: restarts ?? dash(),
          ...(restarts === undefined ? {} : { level: restarts === 0 ? HealthLevel.Green : HealthLevel.Yellow }),
          under: restarts === undefined ? "outside the service" : "since start",
        },
        { label: "Per change request", value: meanMs === null ? dash() : durationText(meanMs) },
      ]),
      f.failed.length === 0 ? null : failedTable(f.wiki.name, f.failed),
    ]),
  );
}
