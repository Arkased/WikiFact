import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChangeOutcome, RequestStatus } from "../../domain/enums.js";
import {
  THROUGHPUT_HOURS,
  closeStore,
  enqueueRequest,
  queueLengthSeries,
  requestThroughput,
  type Store,
} from "../index.js";
import { T0, makeStore } from "../../../__tests__/helpers/store.js";

const HOUR = 3_600_000;
/** 30 minutes into a whole hour of the clock. */
const NOW = Math.floor(T0 / HOUR) * HOUR + HOUR / 2;

let store: Store;
beforeEach(() => {
  store = makeStore();
});
afterEach(() => closeStore(store));

// Inserts a finished request; an outcome adds the `changes` row, none leaves a request that wrote no change.
function finished(
  status: RequestStatus,
  outcome: ChangeOutcome | null,
  startedAt: number | null,
  finishedAt: number,
): void {
  const id = enqueueRequest(store, { change: "c", justification: "j" }, finishedAt - 1000);
  store.db
    .prepare("UPDATE change_requests SET status = ?, started_at = ?, finished_at = ? WHERE id = ?")
    .run(status, startedAt, finishedAt, id);
  if (outcome !== null) {
    store.db
      .prepare("INSERT INTO changes(request_id, outcome, summary, created_at) VALUES (?, ?, 's', ?)")
      .run(id, outcome, finishedAt);
  }
}

describe("requestThroughput", () => {
  it("gives 24 empty whole-hour buckets that end at the hour of now", () => {
    const t = requestThroughput(store, NOW);
    expect(t.buckets).toHaveLength(24);
    expect(t.buckets.at(-1)?.startMs).toBe(NOW - HOUR / 2);
    expect(t.buckets[0]?.startMs).toBe(NOW - HOUR / 2 - 23 * HOUR);
    expect(t).toMatchObject({ last24h: 0, lastHour: 0, perHour: 0, meanMs: null });
  });

  it("counts by outcome and hour, with the totals, the rolling hour and the mean duration", () => {
    finished(RequestStatus.Done, ChangeOutcome.Accepted, NOW - 3000, NOW - 1000);
    finished(RequestStatus.Done, ChangeOutcome.Duplicate, NOW - 40 * 60_000 - 5000, NOW - 40 * 60_000);
    finished(RequestStatus.Done, ChangeOutcome.Rejected, NOW - 2 * HOUR - 1000, NOW - 2 * HOUR);
    finished(RequestStatus.Done, ChangeOutcome.Split, NOW - 2 * HOUR - 9000, NOW - 2 * HOUR - 1);
    finished(RequestStatus.Failed, null, NOW - 5 * HOUR - 3000, NOW - 5 * HOUR);
    // No change written, no start time and outside the window: counted nowhere.
    finished(RequestStatus.Done, null, NOW - 100, NOW - 50);
    finished(RequestStatus.Done, ChangeOutcome.Accepted, null, NOW - 30 * HOUR);
    const t = requestThroughput(store, NOW);
    const last = t.buckets.at(-1);
    expect(last).toMatchObject({ accepted: 1, duplicate: 0, rejected: 0, split: 0, failed: 0 });
    // 40 minutes before a half past the hour is in the hour before, and still in the rolling hour.
    expect(t.buckets.at(-2)).toMatchObject({ duplicate: 1 });
    expect(t.buckets.at(-3)).toMatchObject({ rejected: 1, split: 1 });
    expect(t.buckets.at(-6)).toMatchObject({ failed: 1 });
    expect(t.last24h).toBe(4);
    // The rolling hour holds the accepted request and the duplicate, not the one 2 hours ago.
    expect(t.lastHour).toBe(2);
    expect(t.perHour).toBeCloseTo(4 / 24);
    // 2000, 5000, 1000 and 3000 ms.
    expect(t.meanMs).toBeCloseTo((2000 + 5000 + 1000 + 3000) / 4);
  });

  it("holds the request that finished at now in the last bucket and ignores a queued one", () => {
    finished(RequestStatus.Done, ChangeOutcome.Accepted, NOW - 10, NOW);
    enqueueRequest(store, { change: "q", justification: "j" }, NOW);
    const t = requestThroughput(store, NOW);
    expect(t.buckets.at(-1)?.accepted).toBe(1);
    expect(t.last24h).toBe(1);
  });
});

describe("queueLengthSeries", () => {
  // A request received at `receivedAt` that started at `startedAt` (null: still queued).
  function request(receivedAt: number, startedAt: number | null): void {
    const id = enqueueRequest(store, { change: "c", justification: "j" }, receivedAt);
    if (startedAt !== null) {
      store.db
        .prepare("UPDATE change_requests SET status = ?, started_at = ?, finished_at = ? WHERE id = ?")
        .run(RequestStatus.Done, startedAt, startedAt + 1, id);
    }
  }

  it("gives 24 zeros for an empty queue", () => {
    expect(queueLengthSeries(store, NOW)).toEqual(new Array<number>(THROUGHPUT_HOURS).fill(0));
  });

  it("does not count a done row with no start time after it finished (a row from before the schema kept it)", () => {
    const id = enqueueRequest(store, { change: "c", justification: "j" }, NOW - 10 * HOUR);
    store.db
      .prepare("UPDATE change_requests SET status = ?, started_at = NULL, finished_at = ? WHERE id = ?")
      .run(RequestStatus.Done, NOW - 8 * HOUR, id);
    const series = queueLengthSeries(store, NOW);
    // It waited until it finished 8 hours ago; every hour end after that, and now, is clear.
    expect(series.at(-1)).toBe(0);
    expect(series.slice(-8).every((n) => n === 0)).toBe(true);
    // Before it finished, it was in the queue.
    expect(series.at(-10)).toBe(1);
  });

  it("counts the requests that waited at the end of each hour, and the queue now in the last point", () => {
    const end = (hoursAgo: number): number => NOW - HOUR / 2 - (hoursAgo - 1) * HOUR;
    // Waits from 3 hours ago to 1 hour ago, then runs: in the queue at the end of the hours 3 and 2 ago.
    request(end(3) - 600_000, end(1) + 10);
    // Received 2 hours ago and still queued: in the queue from then on, and now.
    request(end(2) - 100, null);
    // Received and started within the same hour: never in the queue at an hour end.
    request(end(4) - 2000, end(4) - 1000);
    const series = queueLengthSeries(store, NOW);
    expect(series).toHaveLength(THROUGHPUT_HOURS);
    expect(series.at(-1)).toBe(1);
    expect(series.at(-2)).toBe(2);
    expect(series.at(-3)).toBe(2);
    expect(series.at(-4)).toBe(1);
    expect(series.at(-5)).toBe(0);
    expect(series[0]).toBe(0);
  });

  it("counts a request received before the first hour that is still queued in every point", () => {
    request(NOW - 30 * HOUR, null);
    expect(queueLengthSeries(store, NOW)).toEqual(new Array<number>(THROUGHPUT_HOURS).fill(1));
  });

  it("does not count a request received after now", () => {
    request(NOW + 1, null);
    expect(queueLengthSeries(store, NOW).at(-1)).toBe(0);
  });
});
