// technical/console.md, "Service health": what the Operation page reads (`Facts`) and the small helpers that its parts share.
import { HealthLevel, HealthRow, McpToolName, enumValues } from "../../domain/enums.js";
import type {
  BatchProgress,
  QueuePause,
  RequestListItem,
  RequestThroughput,
  ToolCallBucket,
  ToolCallStats,
  WorkerStatus,
} from "../../store/index.js";
import type { ConsoleWiki } from "../deps.js";
import type { HealthReport } from "../health.js";
import { html, type SafeHtml } from "../html.js";
import { levelWord } from "./parts/index.js";
import { CLOCK_FIELD_WIDTH } from "../../constants.js";

/** The bar for the time of a search, in ms: the line that the page reads against the p95 of the search time. */
export const SEARCH_BAR_MS = 100;

/** What the page reads. */
export interface Facts {
  wiki: ConsoleWiki;
  report: HealthReport;
  failed: RequestListItem[];
  status: WorkerStatus | undefined;
  /** The `queue_pause` key; absent when the queue runs. */
  pause: QueuePause | undefined;
  /** True when the console's writes are on: the toggle of the queue and the "Run" buttons of the jobs show. */
  canWrite: boolean;
  /** The clock of the request, in ms since the epoch. */
  now: number;
  queued: number;
  /** The estimated wait of the queue, in ms. */
  waitMs: number;
  throughput: RequestThroughput;
  /** The queue length at the end of each of the 24 hours of `throughput.buckets` (`queueLengthSeries`). */
  queueSeries: number[];
  calls: ToolCallStats;
  /** The queued submissions; the button "Run a batch now" is disabled with none. */
  queuedSubmissions: number;
  /** The `batch_progress` key; absent when no batch has run. */
  batch: BatchProgress | undefined;
}

/**
 * Pads a number to 2 digits.
 *
 * @param n - a whole number, 0 or more
 * @returns the number as text with a leading 0 under 10
 * @sideEffects none
 */
function pad2(n: number): string {
  return String(n).padStart(CLOCK_FIELD_WIDTH, "0");
}

/**
 * Formats a time as `HH:mm` in the local time of the server.
 *
 * @param ms - the time, in ms since the epoch
 * @returns the time of day
 * @sideEffects none
 */
export const clock = (ms: number): string => `${pad2(new Date(ms).getHours())}:${pad2(new Date(ms).getMinutes())}`;

/**
 * Formats a time ahead of `now` as `HH:mm` for a time of today and `YYYY-MM-DD HH:mm` for another day, in the local time of
 * the server (a weekly limit of the model pauses the worker for days).
 *
 * @param ms - the time, in ms since the epoch
 * @param now - the clock of the page, in ms since the epoch
 * @returns the time, with its date when the date is not today's
 * @sideEffects none
 */
export function untilText(ms: number, now: number): string {
  const at = new Date(ms);
  const today = new Date(now);
  const sameDay =
    at.getFullYear() === today.getFullYear() && at.getMonth() === today.getMonth() && at.getDate() === today.getDate();
  return sameDay ? clock(ms) : `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())} ${clock(ms)}`;
}

/**
 * Pluralizes a count.
 *
 * @param n - the count
 * @param one - the noun for 1
 * @param many - the noun for any other count
 * @returns "N noun"
 * @sideEffects none
 */
export const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * Finds the level of a health row in the report.
 *
 * @param report - the live health report
 * @param row - the row
 * @returns the level; green when the report has no such row
 * @sideEffects none
 */
export function levelOf(report: HealthReport, row: HealthRow): HealthLevel {
  return report.rows.find((r) => r.row === row)?.level ?? HealthLevel.Green;
}

/**
 * Renders the line under a stat in the color of its level.
 *
 * @param level - the level
 * @param text - the text
 * @returns a `span` with the level word as its class
 * @sideEffects none
 */
export function leveled(level: HealthLevel, text: string): SafeHtml {
  return html`<span class="${levelWord(level)}">${text}</span>`;
}

/**
 * Sums the failed calls of every tool in a bucket.
 *
 * @param bucket - an hourly bucket
 * @returns the failed calls of the hour
 * @sideEffects none
 */
export const failedIn = (bucket: ToolCallBucket): number =>
  enumValues(McpToolName).reduce((sum, tool) => sum + bucket.byTool[tool].failed, 0);

/**
 * Sums the calls of every tool in a bucket.
 *
 * @param bucket - an hourly bucket
 * @returns the calls of the hour
 * @sideEffects none
 */
export const callsIn = (bucket: ToolCallBucket): number =>
  enumValues(McpToolName).reduce((sum, tool) => sum + bucket.byTool[tool].calls, 0);

/**
 * Names the 24 hours of a chart axis.
 *
 * @param startsMs - the start of each hour, in ms since the epoch
 * @returns `HH:00` in the local time of the server, one per hour
 * @sideEffects none
 */
export const hourLabels = (startsMs: number[]): string[] => startsMs.map((ms) => `${pad2(new Date(ms).getHours())}:00`);

/**
 * Rounds a time to whole ms.
 *
 * @param ms - a time, or null
 * @returns the rounded time; null stays null (no search in the window)
 * @sideEffects none
 */
export const rounded = (ms: number | null): number | null => (ms === null ? null : Math.round(ms));
