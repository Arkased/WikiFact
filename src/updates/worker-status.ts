// technical/updates.md, "Queue and worker": how one worker step changes the worker status that the MCP server reads.
import {
  BatchRunStatus,
  CallFailureKind,
  PauseReason,
  ProcessOutcome,
  RunOnceStatus,
  WorkerState,
} from "../domain/enums.js";
import type { WorkerStatus } from "../store/index.js";
import { classifyCallFailure } from "./questions/index.js";
import type { RunOnceResult } from "./run-once.js";
import type { BatchRunResult } from "./batch/run.js";
import { BACKOFF_FACTOR } from "../constants.js";

/** The longest failure message kept in the status, in characters. */
const STATUS_MESSAGE_CHARS = 300;

/**
 * The first pause after a rate limit of the model, in ms (5 minutes). A session limit lasts hours, so a short first
 * wait finds out soon when it was a burst.
 */
export const RATE_LIMIT_PAUSE_MS = 5 * 60_000;

/**
 * The longest pause after rate limits in a row, in ms (1 hour). The pause doubles on each rate-limited call in a row
 * up to this value.
 */
export const RATE_LIMIT_PAUSE_MAX_MS = 60 * 60_000;

/** The margin added to the reset time of a rate limit, in ms (2 minutes), so that the worker resumes after the reset. */
export const RATE_LIMIT_RESET_MARGIN_MS = 2 * 60_000;

const MS_PER_MINUTE = 60_000;

/** The hours on a 12-hour clock face. */
const HOURS_ON_CLOCK = 12;
/** The last minute of an hour. */
const MAX_MINUTE = 59;
const MS_PER_DAY = 24 * 3_600_000;

/** The farthest reset time that the worker trusts, in ms ahead of now (8 days). A time beyond it gives the doubled wait. */
export const RATE_LIMIT_RESET_MAX_MS = 8 * MS_PER_DAY;

/** A reset date with no year that lies more than this far in the past is read as the same date next year (180 days). */
const RESET_YEAR_ROLLOVER_MS = 180 * MS_PER_DAY;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// "resets [Mon D, ]H[:MM]am|pm (Zone)": groups are month, day, hour, minute, meridiem, zone.
const RESET_PATTERN =
  /resets\s+(?:([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap]m)\s*\(([^)]+)\)/i;

interface WallClock {
  year: number;
  month: number; // 1 to 12
  day: number;
  hour: number;
  minute: number;
}

// The calendar fields of an instant in a time zone. Intl holds the zone rules, so no library comes in (code standard,
// section 5): the only hand-written part is `instantOf`, the inversion of the offset, which the DST tests cover.
function wallClockIn(zone: string, ms: number): WallClock {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  }).formatToParts(new Date(ms));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
}

// The instant at which the zone shows the given wall clock. The offset is read twice so that a time next to a
// daylight saving change lands on the right side of it.
function instantOf(zone: string, w: WallClock): number {
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
  const offsetAt = (ms: number): number => {
    const z = wallClockIn(zone, ms);
    return Date.UTC(z.year, z.month - 1, z.day, z.hour, z.minute) - Math.floor(ms / MS_PER_MINUTE) * MS_PER_MINUTE;
  };
  const first = asUtc - offsetAt(asUtc);
  return asUtc - offsetAt(first);
}

/**
 * Reads the time at which a rate limit of the model ends from the error text.
 *
 * The forms in the service logs (66 `rate_limit_pause` lines, 2026-10-17 to 2026-10-19), all with the zone
 * `America/Los_Angeles`: `resets 4pm (zone)` (30), `resets Oct 19, 4pm (zone)` (14), `resets 6:10pm (zone)` (12),
 * `resets 11:30pm (zone)` (10). The parser also takes `resets Oct 19, 6:10pm (zone)`, `am`, and `12am`/`12pm`. A time
 * with no date is the next moment at that clock time in the zone. A date with no year is in the current year of the
 * zone, or the next year when that date lies more than 180 days back.
 *
 * @param error - the error text of the rate-limited call
 * @param now - the time, in ms since the epoch
 * @returns the reset in ms since the epoch; `undefined` when the text names no time, the zone is unknown, the time
 *   is not after `now`, or it lies more than `RATE_LIMIT_RESET_MAX_MS` ahead
 * @sideEffects none
 */
export function rateLimitResetAt(error: string, now: number): number | undefined {
  const m = RESET_PATTERN.exec(error);
  if (m === null) return undefined;
  const [, monthName, dayText, hourText, minuteText, meridiem, zoneText] = m;
  const zone = zoneText?.trim() ?? "";
  const hour12 = Number(hourText);
  const minute = minuteText === undefined ? 0 : Number(minuteText);
  if (hour12 < 1 || hour12 > HOURS_ON_CLOCK || minute > MAX_MINUTE) return undefined;
  const hour = (hour12 % HOURS_ON_CLOCK) + (meridiem?.toLowerCase() === "pm" ? HOURS_ON_CLOCK : 0);
  try {
    const today = wallClockIn(zone, now);
    if (monthName !== undefined && dayText !== undefined) {
      const month = MONTHS.indexOf(monthName.slice(0, 3).toLowerCase()) + 1;
      if (month === 0) return undefined;
      const at = (year: number): number => instantOf(zone, { year, month, day: Number(dayText), hour, minute });
      let reset = at(today.year);
      if (reset < now - RESET_YEAR_ROLLOVER_MS) reset = at(today.year + 1);
      return reset > now && reset - now <= RATE_LIMIT_RESET_MAX_MS ? reset : undefined;
    }
    // Today's date plus 0 or 1 days; Date.UTC carries a day past the end of the month.
    for (const add of [0, 1]) {
      const reset = instantOf(zone, { ...today, day: today.day + add, hour, minute });
      if (reset > now) return reset - now <= RATE_LIMIT_RESET_MAX_MS ? reset : undefined;
    }
    return undefined;
  } catch {
    // An unknown zone makes Intl throw a RangeError: the text does not parse, so the caller falls back.
    return undefined;
  }
}

/**
 * The status at the start of the worker.
 *
 * @param now - the time, in ms since the epoch
 * @returns a status for this process with no call yet and no failure
 * @sideEffects reads `process.pid`
 */
export function initialWorkerStatus(now: number): WorkerStatus {
  return { pid: process.pid, startedAt: now, lastPollAt: now, consecutiveFailures: 0 };
}

/**
 * The wait after a rate-limited model call.
 *
 * @param previousMs - the wait of the previous rate-limited call in a row; absent when no call was rate limited since
 *   the last success
 * @returns `RATE_LIMIT_PAUSE_MS` for the first, else double the previous wait, at most `RATE_LIMIT_PAUSE_MAX_MS`
 * @sideEffects none
 */
export function nextRateLimitPauseMs(previousMs: number | undefined): number {
  return previousMs === undefined
    ? RATE_LIMIT_PAUSE_MS
    : Math.min(previousMs * BACKOFF_FACTOR, RATE_LIMIT_PAUSE_MAX_MS);
}

/**
 * The status of a worker that waits out a pause.
 *
 * @param status - the status after the step that was rate limited
 * @param now - the time the pause starts, in ms since the epoch
 * @param waitMs - the length of the pause, in ms
 * @returns the status with the state `paused`, the end of the pause and the reason `rate limit`
 * @sideEffects none
 */
export function pausedWorkerStatus(status: WorkerStatus, now: number, waitMs: number): WorkerStatus {
  return { ...status, state: WorkerState.Paused, pausedUntil: now + waitMs, pauseReason: PauseReason.RateLimit };
}

/**
 * The status of a worker whose queue the operator paused (technical/updates.md, "Queue and worker"). The worker is
 * alive and polls; it takes no request.
 *
 * @param status - the status before the step
 * @param now - the time of the poll, in ms since the epoch
 * @param since - the `at` of the `queue_pause` key, in ms since the epoch
 * @returns the status with the state `paused`, the reason `operator` and `pausedSince`, and no `pausedUntil`
 * @sideEffects none
 */
export function operatorPausedWorkerStatus(status: WorkerStatus, now: number, since: number): WorkerStatus {
  return {
    ...resumedWorkerStatus(status),
    lastPollAt: now,
    state: WorkerState.Paused,
    pauseReason: PauseReason.Operator,
    pausedSince: since,
  };
}

/**
 * The status of a worker whose pause ended.
 *
 * @param status - the status while paused
 * @returns the status without the pause fields
 * @sideEffects none
 */
export function resumedWorkerStatus(status: WorkerStatus): WorkerStatus {
  return {
    pid: status.pid,
    startedAt: status.startedAt,
    lastPollAt: status.lastPollAt,
    consecutiveFailures: status.consecutiveFailures,
    ...(status.lastCall === undefined ? {} : { lastCall: status.lastCall }),
    ...(status.lastBatchError === undefined ? {} : { lastBatchError: status.lastBatchError }),
  };
}

/**
 * Folds the result of one worker step into the status. An idle step and a request that made no model call (a
 * skipped lookupRepair) only move `lastPollAt`. A done request is a successful call and resets the failure count; a
 * failed attempt records the kind and the message of the error and raises the count. A rate-limited call records its
 * kind and message but leaves the count: a session limit is a wait, not a fault (technical/updates.md, "Model call
 * failures").
 *
 * @param prev - the status before the step
 * @param result - what `runOnce` returned
 * @param now - the time of the step, in ms since the epoch
 * @returns the new status
 * @sideEffects none
 */
export function nextWorkerStatus(prev: WorkerStatus, result: RunOnceResult, now: number): WorkerStatus {
  return foldStep(prev, result, now);
}

/**
 * Folds the end of one batch into the status, as `nextWorkerStatus` folds one request: a batch that ended is a successful
 * call, unless every one of its requests failed an attempt, then it is a failed attempt; a rate-limited batch records its kind and message and leaves the failure count,
 * and a batch that stopped between 2 steps only moves `lastPollAt`. A batch whose promotion failed (`Dropped`) is no model
 * call: it records `lastBatchError` (the message and the time) and leaves `lastCall` and `consecutiveFailures`; a batch that
 * ended (`Done`, also when every request failed an attempt) clears `lastBatchError`.
 *
 * @param prev - the status before the step
 * @param result - what `runBatch` returned
 * @param now - the time of the step, in ms since the epoch
 * @returns the new status
 * @sideEffects none
 */
export function nextBatchWorkerStatus(prev: WorkerStatus, result: BatchRunResult, now: number): WorkerStatus {
  const polled = { ...prev, lastPollAt: now };
  switch (result.status) {
    case BatchRunStatus.Stopped:
      return polled;
    case BatchRunStatus.Done:
      // Every request of the batch failed: a failed attempt.
      if (result.error !== undefined && result.failed === result.size) {
        return withoutBatchError({
          ...polled,
          lastCall: {
            ok: false,
            kind: classifyCallFailure(result.error),
            message: result.error.slice(0, STATUS_MESSAGE_CHARS),
            at: now,
          },
          consecutiveFailures: prev.consecutiveFailures + 1,
        });
      }
      return withoutBatchError({ ...polled, lastCall: { ok: true, at: now }, consecutiveFailures: 0 });
    case BatchRunStatus.Dropped:
      // No model call failed: the event has its own field, and `lastCall` and the count stay.
      return { ...polled, lastBatchError: { message: result.error.slice(0, STATUS_MESSAGE_CHARS), at: now } };
    case BatchRunStatus.RateLimited:
      return {
        ...polled,
        lastCall: {
          ok: false,
          kind: CallFailureKind.RateLimit,
          message: result.error.slice(0, STATUS_MESSAGE_CHARS),
          at: now,
        },
      };
  }
}

/**
 * Counts one step of the 1-at-a-time run that follows a dropped batch (technical/updates.md, "High volume mode", rule 6). A step
 * that ends in done, rejected or a failed attempt uses one step. A rate-limited step does not count: its request went back
 * to the queue unrun and keeps its place. An idle poll ends the run (`left` is 0). When the run ends, the status loses
 * `lastBatchError`, because the panel line would no longer say what the worker does.
 *
 * @param left - the steps left before the step
 * @param status - the status after the step was folded in
 * @param step - what `runOnce` returned
 * @returns the steps left and the status
 * @sideEffects none
 */
export function afterSoloStep(
  left: number,
  status: WorkerStatus,
  step: RunOnceResult,
): { left: number; status: WorkerStatus } {
  let next = left;
  if (step.status === RunOnceStatus.Idle) next = 0;
  else if (step.status !== RunOnceStatus.RateLimited && left > 0) next = left - 1;
  return { left: next, status: left > 0 && next === 0 ? withoutBatchError(status) : status };
}

/**
 * Clears `lastBatchError`: the status after a batch ended, or after the 1-at-a-time run of a dropped batch ended.
 *
 * @param status - the status
 * @returns a copy with no `lastBatchError`
 * @sideEffects none
 */
function withoutBatchError(status: WorkerStatus): WorkerStatus {
  const rest = { ...status };
  delete rest.lastBatchError;
  return rest;
}

function foldStep(prev: WorkerStatus, result: RunOnceResult, now: number): WorkerStatus {
  const polled = { ...prev, lastPollAt: now };
  switch (result.status) {
    case RunOnceStatus.Idle:
      return polled;
    case RunOnceStatus.Done:
      if (result.result.outcome === ProcessOutcome.Skipped) return polled;
      return { ...polled, lastCall: { ok: true, at: now }, consecutiveFailures: 0 };
    case RunOnceStatus.RateLimited:
      return {
        ...polled,
        lastCall: {
          ok: false,
          kind: CallFailureKind.RateLimit,
          message: result.error.slice(0, STATUS_MESSAGE_CHARS),
          at: now,
        },
      };
    case RunOnceStatus.Queued:
    case RunOnceStatus.Failed:
      return {
        ...polled,
        lastCall: {
          ok: false,
          kind: classifyCallFailure(result.error),
          message: result.error.slice(0, STATUS_MESSAGE_CHARS),
          at: now,
        },
        consecutiveFailures: prev.consecutiveFailures + 1,
      };
  }
}
