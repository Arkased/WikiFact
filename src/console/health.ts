// technical/console.md, "Service health": the rules and the thresholds of the 3 live rows of the health table, as functions. The rule
// functions are pure and take numbers; `liveHealth` gathers their inputs from the store, the lock file, the child state and the
// stored tool calls. The verdict of a wiki is its worst row. The queue is load and has no row. The failed requests and failed calls thresholds are first
// guesses (technical/console.md, "Service health"); their revision is in future.md.
import {
  CallFailureKind,
  HealthLevel,
  HealthRow,
  PauseReason,
  RequestListSort,
  RequestStatus,
  WorkerState,
} from "../domain/enums.js";
import { STALE_POLL_MS } from "../mcp/warning.js";
import type { QueueStats, RequestListItem, Store, ToolCallCount, WorkerCall, WorkerStatus } from "../store/index.js";
import { MAX_LIMIT, listRequests, readQueuePause, readWorkerStatus, toolCallStats } from "../store/index.js";
import { looksCredential } from "../updates/questions/errors.js";
import { MS_PER_SECOND } from "../time.js";
import type { ConsoleWiki } from "./deps.js";
import { durationText } from "./html.js";

/** A worker that has not polled for this long is not running, in ms (the same bound as the `requestChange` warning). */
export const WORKER_POLL_MS = STALE_POLL_MS;
/** Consecutive failed model calls that make the worker row red. */
export const WORKER_RED_FAILURES = 3;
/** The duration assumed per queued request when no done request has a measured duration, in ms (30 seconds). */
export const QUEUE_DEFAULT_REQUEST_MS = 30_000;
/** The window of the failed requests row, in ms (24 hours). */
export const HEALTH_WINDOW_MS = 24 * 60 * 60_000;
/** The calls in the last hour from which a high share of failed calls makes the failed calls row red (technical/console.md, "Service health"). */
export const FAILED_CALLS_RED_MIN = 5;
/** The share of failed calls, from 0 to 1, at or over which the failed calls row is red once there are `FAILED_CALLS_RED_MIN` calls. */
export const FAILED_CALLS_RED_SHARE = 0.5;

const ORDER: Record<HealthLevel, number> = { [HealthLevel.Green]: 0, [HealthLevel.Yellow]: 1, [HealthLevel.Red]: 2 };

/** One row of the health table: its level and the numbers behind it, in words. */
interface HealthRowReport {
  row: HealthRow;
  level: HealthLevel;
  detail: string;
}

/** The health of a wiki: the 3 live rows of technical/console.md, "Service health" and the worst of their levels. */
export interface HealthReport {
  verdict: HealthLevel;
  rows: HealthRowReport[];
}

/** What the worker rule looks at. */
export interface WorkerRuleInput {
  /** True when the worker status has a poll inside `WORKER_POLL_MS`. */
  polled: boolean;
  lastCall?: WorkerCall;
  consecutiveFailures: number;
  /** True when the service held a worker child that ended (`ConsoleWiki.childRunning === false`). */
  childEnded: boolean;
  /** True while the worker status says `paused` (a wait on its own timer) or the store has the `queue_pause` key (the operator paused the queue). */
  paused?: boolean;
}

/**
 * Picks the worst of some levels.
 *
 * @param levels - the levels; empty is green
 * @returns red over yellow over green
 * @sideEffects none
 */
export function worstLevel(levels: HealthLevel[]): HealthLevel {
  return levels.reduce((worst, l) => (ORDER[l] > ORDER[worst] ? l : worst), HealthLevel.Green);
}

/**
 * Tells whether the worker of a wiki runs, with one meaning on every page: the child state when the service holds a
 * worker child, else a poll inside `WORKER_POLL_MS` (as `workerInfo` of the registry reads it).
 *
 * @param wiki - the wiki, for its child state
 * @param status - the worker status as stored; absent when no worker has run on the database
 * @param now - the clock, in ms since the epoch
 * @returns true when the child is live, or, without a child, when the last poll is inside the window
 * @sideEffects none
 */
export function workerRunning(wiki: ConsoleWiki, status: WorkerStatus | undefined, now: number): boolean {
  return wiki.childRunning ?? (status !== undefined && now - status.lastPollAt <= WORKER_POLL_MS);
}

/**
 * The worker row of technical/console.md, "Health".
 *
 * @param input - the poll state, the last call, the failure count and the child state
 * @returns red without a poll or when the child ended; yellow while the worker is paused (a rate limit is a wait, not
 *   a fault) or the operator paused the queue; red on a credential failure or at `WORKER_RED_FAILURES` or more failures; yellow when the last call
 *   failed otherwise; else green
 * @sideEffects none
 */
export function workerLevel(input: WorkerRuleInput): HealthLevel {
  if (!input.polled || input.childEnded) return HealthLevel.Red;
  if (input.paused === true) return HealthLevel.Yellow;
  if (input.consecutiveFailures >= WORKER_RED_FAILURES) return HealthLevel.Red;
  const call = input.lastCall;
  if (call === undefined || call.ok) return HealthLevel.Green;
  return call.kind === CallFailureKind.Credential ? HealthLevel.Red : HealthLevel.Yellow;
}

/**
 * The estimated wait of the queue: `queued * mean duration`, with `QUEUE_DEFAULT_REQUEST_MS` per request when no
 * mean exists.
 *
 * @param stats - the queue stats
 * @returns the wait, in ms; 0 for an empty queue
 * @sideEffects none
 */
export function estimatedWaitMs(stats: QueueStats): number {
  return stats.queued * (stats.meanDurationMs ?? QUEUE_DEFAULT_REQUEST_MS);
}

/**
 * The failed requests row of technical/console.md, "Health".
 *
 * @param failed - the `failed` rows finished inside the window
 * @param credential - how many of them failed on a credential, so the next request fails too
 * @returns green at 0, red when any failed on a credential, else yellow
 * @sideEffects none
 */
export function failedLevel(failed: number, credential: number): HealthLevel {
  if (failed === 0) return HealthLevel.Green;
  return credential > 0 ? HealthLevel.Red : HealthLevel.Yellow;
}

/**
 * The failed calls row of technical/console.md, "Service health".
 *
 * @param last - the calls and the failed calls of the last hour, as `toolCallStats` gives them (`lastHour`)
 * @returns green at 0 failed; red at `FAILED_CALLS_RED_MIN` or more calls with a failed share of `FAILED_CALLS_RED_SHARE`
 *   or more; else yellow
 * @sideEffects none
 */
export function failedCallsLevel(last: ToolCallCount): HealthLevel {
  if (last.failed === 0) return HealthLevel.Green;
  const red = last.calls >= FAILED_CALLS_RED_MIN && last.failed / last.calls >= FAILED_CALLS_RED_SHARE;
  return red ? HealthLevel.Red : HealthLevel.Yellow;
}

/**
 * Writes the wait of the queue in the words of every page: `no wait` under a second, else `N min wait`.
 *
 * @param waitMs - the estimated wait, in ms
 * @returns for example `no wait`, `9 s wait`, `1 min wait`
 * @sideEffects none
 */
export function waitText(waitMs: number): string {
  return waitMs < MS_PER_SECOND ? "no wait" : `${durationText(waitMs)} wait`;
}

/**
 * Lists the `failed` requests that finished inside the health window.
 *
 * @param store - the open store
 * @param now - the end of the window, in ms since the epoch
 * @returns the rows, latest finished first; at most `MAX_LIMIT`
 * @sideEffects none (reads)
 */
export function failedRequestsIn(store: Store, now: number): RequestListItem[] {
  const page = listRequests(store, { status: RequestStatus.Failed, sort: RequestListSort.Finished, limit: MAX_LIMIT });
  return page.items.filter((r) => r.finishedAt !== null && r.finishedAt >= now - HEALTH_WINDOW_MS);
}

/**
 * Tells whether the worker waits out a rate limit. A status that says `pauseReason: operator` does not count: the
 * operator pause depends on the `queue_pause` key alone, and the status keeps the field for up to 1 poll after a resume.
 *
 * @param status - the worker status as stored; absent when no worker has run
 * @returns true when the state is `paused` for a reason other than the operator
 * @sideEffects none
 */
export function rateLimitPaused(status: WorkerStatus): boolean {
  return status.state === WorkerState.Paused && status.pauseReason !== PauseReason.Operator;
}

function workerRow(store: Store, wiki: ConsoleWiki, now: number): HealthRowReport {
  const status = readWorkerStatus(store);
  // The key, not the status: the pause holds before the worker has seen the key (technical/console.md, "Service health").
  const operatorPaused = readQueuePause(store) !== undefined;
  const polled = status !== undefined && now - status.lastPollAt <= WORKER_POLL_MS;
  const level = workerLevel({
    polled,
    ...(status?.lastCall === undefined ? {} : { lastCall: status.lastCall }),
    consecutiveFailures: status?.consecutiveFailures ?? 0,
    childEnded: wiki.childRunning === false,
    paused: (status !== undefined && rateLimitPaused(status)) || operatorPaused,
  });
  const parts: string[] = [];
  parts.push(status === undefined ? "no poll yet" : `polled ${durationText(now - status.lastPollAt)} ago`);
  if (wiki.childRunning === false) parts.push("stopped");
  if (status !== undefined && rateLimitPaused(status))
    parts.push(`paused, ${status.pauseReason ?? PauseReason.RateLimit}`);
  else if (operatorPaused) parts.push(`paused, ${PauseReason.Operator}`);
  if (status?.lastCall?.ok === false) parts.push(`last call failed, ${status.consecutiveFailures} in a row`);
  return { row: HealthRow.Worker, level, detail: parts.join(", ") };
}

function failedRow(store: Store, now: number): HealthRowReport {
  const rows = failedRequestsIn(store, now);
  const credential = rows.filter((r) => r.error !== null && looksCredential(r.error)).length;
  const tail = credential === 0 ? "" : `, ${credential} on a credential failure`;
  return {
    row: HealthRow.FailedRequests,
    level: failedLevel(rows.length, credential),
    detail: `${rows.length} in 24 hours${tail}`,
  };
}

// The calls of the last hour are the `tool_calls` rows of the store: a wiki with no row has no call to fail.
function failedCallsRow(store: Store, now: number): HealthRowReport {
  const last = toolCallStats(store, now).lastHour;
  return {
    row: HealthRow.FailedCalls,
    level: failedCallsLevel(last),
    detail: `${last.failed} of ${last.calls} in the last hour`,
  };
}

/**
 * technical/console.md, "The shell": the 3 live rows of the health table (worker, failed requests, failed calls) and
 * the worst of their levels. The queue is load, not a fault: it has no row. The status pill, Service health and the Wikis
 * table all read them.
 *
 * @param store - the open store of the wiki, read-only
 * @param wiki - the wiki: its database path for the lock file, its child state
 * @param now - the clock, in ms since the epoch
 * @returns the 3 rows in the order of the table and their worst level
 * @sideEffects reads the store and the lock file (and signals its pid with 0)
 */
export function liveHealth(store: Store, wiki: ConsoleWiki, now: number): HealthReport {
  const rows = [workerRow(store, wiki, now), failedRow(store, now), failedCallsRow(store, now)];
  return { verdict: worstLevel(rows.map((r) => r.level)), rows };
}
