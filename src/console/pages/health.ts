// technical/console.md, "Service health": the Operation page, which answers "does the service run". Under the heading: the status line. Then
// the grid of the present (a cols-2 grid, "MCP server, now" left and "Queue worker, now" right, with the Run a batch now and Pause or Resume
// buttons), the grid of the 24 hours, then the section "Jobs". A stat whose number has
// a rule shows it in the level color of its health row; the page holds data and levels, no verdict line. It has no requeue button and
// no restart button. The page refreshes in place every 15 seconds.
import {
  CallFailureKind,
  ConsoleSection,
  GridColumns,
  HealthLevel,
  HealthRow,
  PauseReason,
} from "../../domain/enums.js";
import {
  queueLengthSeries,
  queueStats,
  readBatchProgress,
  countQueuedSubmissions,
  readQueuePause,
  readWorkerStatus,
  requestThroughput,
  toolCallStats,
} from "../../store/index.js";
import { writesAllowed } from "../auth.js";
import {
  estimatedWaitMs,
  failedRequestsIn,
  liveHealth,
  rateLimitPaused,
  WORKER_POLL_MS,
  WORKER_RED_FAILURES,
} from "../health.js";
import { durationText, html, layout, sectionLabel, type SafeHtml } from "../html.js";
import type { PageContext } from "../page.js";
import { batchPanel } from "./health-batch.js";
import { clock, count, levelOf, untilText, type Facts } from "./health-facts.js";
import { historyPanel as mcpHistory, nowPanel as mcpNow } from "./health-mcp.js";
import { historyPanel as workerHistory, batchControl, nowPanel as workerNow, queueControl } from "./health-worker.js";
import { jobsSection } from "./jobs.js";
import { QUEUE_REFRESH_SECONDS } from "./requests.js";
import { column, grid, levelBadge, levelWord, verdicts, withWiki, type Verdict } from "./parts/index.js";

export { SEARCH_BAR_MS } from "./health-facts.js";

// The sentence of a status line: the level word capitalized, then the text.
function say(level: HealthLevel, text: string): Verdict {
  const word = levelWord(level);
  return { level, text: `${word.charAt(0).toUpperCase()}${word.slice(1)}. ${text}` };
}

// ", next try at <time>" for a paused worker, with the date when it is not today; empty when the status has no end time.
const pauseEnd = (f: Facts): string =>
  f.status?.pausedUntil === undefined ? "" : `, next try at ${untilText(f.status.pausedUntil, f.now)}`;

// The worker row as a sentence, in the order of the rule `workerLevel`; null when the row is ok.
function workerSentence(f: Facts): string | null {
  const { wiki, status, now } = f;
  const level = levelOf(f.report, HealthRow.Worker);
  if (level === HealthLevel.Green) return null;
  const waiting = f.queued === 0 ? "" : `, and ${count(f.queued, "request waits", "requests wait")}`;
  if (status === undefined) return `The worker has not polled yet${waiting}.`;
  if (now - status.lastPollAt > WORKER_POLL_MS) {
    return `The worker has not polled for ${durationText(now - status.lastPollAt)}${waiting}.`;
  }
  if (wiki.childRunning === false) return "The worker is stopped.";
  // The key, not the status: the line holds before the worker has seen the key.
  if (f.pause !== undefined) return `The operator paused the queue at ${clock(f.pause.at)}: “${f.pause.note}”`;
  if (rateLimitPaused(status)) {
    return `The worker is paused on a ${status.pauseReason ?? PauseReason.RateLimit}${pauseEnd(f)}${waiting}.`;
  }
  if (status.consecutiveFailures >= WORKER_RED_FAILURES) {
    return `The last ${status.consecutiveFailures} model calls of the worker failed.`;
  }
  const call = status.lastCall;
  if (call !== undefined && !call.ok && call.kind === CallFailureKind.Credential) {
    return "The worker's model refuses its credential.";
  }
  return "The last model call of the worker failed.";
}

// The failed requests row as a sentence; null when the row is ok.
function failedRequestsSentence(f: Facts): string | null {
  const level = levelOf(f.report, HealthRow.FailedRequests);
  if (level === HealthLevel.Green) return null;
  const last = f.failed[0]?.finishedAt;
  const lastAt = last === null || last === undefined ? "" : `, the last at ${clock(last)}`;
  const tail = level === HealthLevel.Red ? " The next request will fail too." : "";
  return `${count(f.failed.length, "request", "requests")} failed in the last 24 hours${lastAt}.${tail}`;
}

// The failed calls row as a sentence; null when the row is ok.
function failedCallsSentence(f: Facts): string | null {
  const { calls: hour, failed } = f.calls.lastHour;
  const level = levelOf(f.report, HealthRow.FailedCalls);
  if (level === HealthLevel.Green) return null;
  return level === HealthLevel.Red
    ? `${failed} of ${hour} tool calls failed in the last hour.`
    : `${count(failed, "tool call", "tool calls")} failed in the last hour.`;
}

// The status line under the heading: 1 line per row that is not ok, in its level color; nothing when every row is ok.
function statusLines(f: Facts): SafeHtml {
  const lines: Verdict[] = [];
  for (const row of f.report.rows) {
    if (row.level === HealthLevel.Green) continue;
    const text =
      row.row === HealthRow.Worker
        ? workerSentence(f)
        : row.row === HealthRow.FailedRequests
          ? failedRequestsSentence(f)
          : failedCallsSentence(f);
    if (text !== null) lines.push(say(row.level, text));
  }
  return lines.length === 0 ? html`` : verdicts(lines, true);
}

/**
 * Renders the Operation page at `GET /console/w/:w/health`.
 *
 * @param ctx - the deps and the wiki in `params.w`
 * @returns the HTML document, refreshed in place every 15 seconds: under the heading with its verdict badge, the status line
 *   (1 line per row that is not ok, nothing when every row is ok); the grid of the present, a `cols-2` grid with "MCP server, now"
 *   left and "Queue worker, now" right, whose head holds the button "Run a batch now" and the "Pause" button ("Resume"
 *   while the store has the `queue_pause` key); the grid of
 *   the 24 hours ("MCP server" and "Queue worker" history); then the section "Jobs" (`#jobs`) at full width. A stat with a rule shows
 *   its number in the level color; the page holds no verdict line. The buttons "Run a batch now", "Pause"/"Resume" and the "Run"
 *   buttons of the jobs, with their dialogs at the end of the page, show only when the console's writes are on
 * @throws {ConsoleError} `NotFound` for an unknown wiki
 * @sideEffects one read-only connection, opened and closed; reads the clock once; reads the lock file and signals its
 *   pid with 0; reads the stored tool calls of the wiki's endpoint
 */
export async function healthPage(ctx: PageContext): Promise<string> {
  return withWiki(ctx, ({ wiki, store, now, frame }) => {
    const report = liveHealth(store, wiki, now);
    const queue = queueStats(store);
    const canWrite = writesAllowed(ctx.deps.service());
    const facts: Facts = {
      wiki,
      report,
      failed: failedRequestsIn(store, now),
      status: readWorkerStatus(store),
      pause: readQueuePause(store),
      canWrite,
      now,
      queued: queue.queued,
      waitMs: estimatedWaitMs(queue),
      throughput: requestThroughput(store, now),
      queueSeries: queueLengthSeries(store, now),
      calls: toolCallStats(store, now),
      queuedSubmissions: countQueuedSubmissions(store),
      batch: readBatchProgress(store),
    };
    const pause = queueControl(facts);
    const batch = batchControl(facts);
    const jobs = jobsSection(wiki, store, canWrite);
    return layout(
      {
        ...frame,
        section: ConsoleSection.Health,
        title: sectionLabel(ConsoleSection.Health),
        badge: levelBadge(report.verdict),
        refreshSeconds: QUEUE_REFRESH_SECONDS,
      },
      column([
        statusLines(facts),
        grid(GridColumns.Two, [mcpNow(facts), workerNow(facts, [batch, pause])]),
        batchPanel(facts),
        grid(GridColumns.Two, [mcpHistory(facts), workerHistory(facts)]),
        jobs.panel,
        pause?.dialog ?? null,
        jobs.dialogs,
      ]),
    );
  });
}
