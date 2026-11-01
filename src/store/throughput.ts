// technical/console.md, "Store API additions": the change requests the worker finished per hour, for Service health.
import { ChangeOutcome, RequestStatus } from "../domain/enums.js";
import type { Store } from "./types/index.js";

/** The number of hourly buckets of `requestThroughput`. */
export const THROUGHPUT_HOURS = 24;

const HOUR_MS = 3_600_000;

/** The finished requests of 1 hour by outcome. A `failed` request is the status failed, whatever its changes. */
interface ThroughputBucket {
  /** The start of the hour (a whole hour of the clock), in ms since the epoch. */
  startMs: number;
  accepted: number;
  duplicate: number;
  rejected: number;
  split: number;
  failed: number;
}

/** The result of `requestThroughput`. */
export interface RequestThroughput {
  /** 24 buckets, oldest first; the last one holds `now`. */
  buckets: ThroughputBucket[];
  /** The processed requests (accepted, duplicate, rejected and failed; a split is not one) in the 24 buckets. */
  last24h: number;
  /** The processed requests that finished in the rolling hour before `now`. */
  lastHour: number;
  /** `last24h / 24`. */
  perHour: number;
  /** The mean of `finished_at - started_at` over the processed requests of `last24h` that have both times, in ms; null when none. */
  meanMs: number | null;
}

interface FinishedRow {
  status: RequestStatus;
  outcome: string | null;
  started_at: number | null;
  finished_at: number;
}

/**
 * Counts the change requests that finished in the last 24 hours, per hour and by outcome. The outcome of a `done`
 * request is the outcome of its first change; a `done` request with no change (a reindex, a cleanup run) is in no count.
 *
 * @param store - the open store
 * @param now - the end of the last bucket, in ms since the epoch
 * @returns 24 buckets of a whole hour of the clock that end at the hour of `now`, and the totals
 * @sideEffects none (reads, 1 query)
 */
export function requestThroughput(store: Store, now: number): RequestThroughput {
  const lastStart = Math.floor(now / HOUR_MS) * HOUR_MS;
  const firstStart = lastStart - (THROUGHPUT_HOURS - 1) * HOUR_MS;
  const buckets: ThroughputBucket[] = Array.from({ length: THROUGHPUT_HOURS }, (_, i) => ({
    startMs: firstStart + i * HOUR_MS,
    accepted: 0,
    duplicate: 0,
    rejected: 0,
    split: 0,
    failed: 0,
  }));
  const rows = store.db
    .prepare(
      `SELECT r.status AS status, r.started_at AS started_at, r.finished_at AS finished_at,
              (SELECT c.outcome FROM changes c WHERE c.request_id = r.id ORDER BY c.seq LIMIT 1) AS outcome
         FROM change_requests r
        WHERE r.status IN (?, ?) AND r.finished_at >= ? AND r.finished_at <= ?`,
    )
    .all(RequestStatus.Done, RequestStatus.Failed, firstStart, now) as FinishedRow[];
  let last24h = 0;
  let lastHour = 0;
  let durationSum = 0;
  let durations = 0;
  for (const r of rows) {
    const bucket = buckets[Math.floor((r.finished_at - firstStart) / HOUR_MS)];
    if (bucket === undefined) continue;
    // The values of `ChangeOutcome` are the keys of the bucket.
    const outcome = r.outcome as ChangeOutcome | null;
    if (r.status === RequestStatus.Failed) bucket.failed += 1;
    else if (outcome === null) continue;
    else bucket[outcome] += 1;
    if (outcome === ChangeOutcome.Split && r.status !== RequestStatus.Failed) continue;
    last24h += 1;
    if (r.finished_at > now - HOUR_MS) lastHour += 1;
    if (r.started_at !== null) {
      durationSum += r.finished_at - r.started_at;
      durations += 1;
    }
  }
  return {
    buckets,
    last24h,
    lastHour,
    perHour: last24h / THROUGHPUT_HOURS,
    meanMs: durations === 0 ? null : durationSum / durations,
  };
}

interface QueuedRow {
  status: RequestStatus;
  received_at: number;
  started_at: number | null;
  finished_at: number | null;
}

/**
 * Reconstructs the length of the queue at the end of each of the last 24 hours, from the rows of `change_requests` alone.
 * A request is in the queue at a time when it was received at or before it and had not started (`started_at` NULL or after
 * it). The point of the current hour is the queue now: the rows with status `queued`, as `countQueued` counts them.
 *
 * @param store - the open store
 * @param now - the end of the last bucket, in ms since the epoch
 * @returns 24 lengths, oldest first, one per bucket of `requestThroughput`: the queue at the end of that hour, and at `now` for the last
 * @sideEffects none (reads, 1 query)
 */
export function queueLengthSeries(store: Store, now: number): number[] {
  const lastStart = Math.floor(now / HOUR_MS) * HOUR_MS;
  const firstStart = lastStart - (THROUGHPUT_HOURS - 1) * HOUR_MS;
  const ends = Array.from({ length: THROUGHPUT_HOURS }, (_, i) => firstStart + (i + 1) * HOUR_MS);
  const rows = store.db
    .prepare(
      `SELECT status, received_at, started_at, finished_at FROM change_requests
        WHERE received_at <= ?
          AND (started_at IS NULL OR started_at > ? OR finished_at IS NULL OR finished_at > ? OR status = ?)`,
    )
    .all(now, firstStart, firstStart, RequestStatus.Queued) as QueuedRow[];
  return ends.map((end, i) =>
    i === THROUGHPUT_HOURS - 1
      ? rows.filter((r) => r.status === RequestStatus.Queued).length
      : rows.filter(
          (r) =>
            r.received_at <= end &&
            (r.started_at === null || r.started_at > end) &&
            // A row finished before the schema kept `started_at` has none, yet it did not wait in the queue after it finished.
            (r.finished_at === null || r.finished_at > end),
        ).length,
  );
}
