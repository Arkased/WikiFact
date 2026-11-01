import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CleanupFinder, OperatorEditKind, RequestKind, RequestStatus } from "../../domain/enums.js";
import {
  closeStore,
  enqueueOperatorEdit,
  enqueueRequest,
  enqueueCleanupRepair,
  failAttempt,
  finishRequest,
  getBatchRequest,
  getRequest,
  listFailed,
  openSession,
  queuePosition,
  releaseStagedRequest,
  requeue,
  resetRunning,
  takeNextRequest,
  takeStagedRequest,
  type Store,
  type CleanupRepair,
} from "../index.js";
import { T0, makeStore } from "../../../__tests__/helpers/store.js";

function must<T>(x: T | null | undefined): T {
  if (x === null || x === undefined) throw new Error("expected a value");
  return x;
}

let store: Store;
beforeEach(() => {
  store = makeStore();
});
afterEach(() => closeStore(store));

const dup = (n: number): CleanupRepair => ({ finder: CleanupFinder.DuplicateFact, factIds: [`f${n}a`, `f${n}b`] });
const sub = (n: number) => enqueueRequest(store, { change: `c${n}`, justification: "j", targets: ["x"] }, T0 + n);

describe("the session of a request (technical/submit.md, requestChange)", () => {
  it("stores the session id of the request, and NULL when it has none", () => {
    openSession(store, { id: "s1", startedAt: T0 });
    enqueueRequest(store, { change: "c", justification: "j", sessionId: "s1" }, T0 + 1);
    enqueueRequest(store, { change: "c", justification: "j" }, T0 + 2);
    expect(store.db.prepare("SELECT session_id FROM change_requests ORDER BY received_at").all()).toEqual([
      { session_id: "s1" },
      { session_id: null },
    ]);
  });
});

describe('queue (technical/updates.md, "Queue and worker")', () => {
  it("takes the oldest queued row and sets it to running", () => {
    const a = sub(1);
    const b = sub(2);
    const r = must(takeNextRequest(store));
    expect(r.id).toBe(a);
    expect(r.status).toBe(RequestStatus.Running);
    expect(r.targets).toEqual(["x"]);
    expect(must(takeNextRequest(store)).id).toBe(b);
    expect(takeNextRequest(store)).toBeNull();
  });

  it("takes the operator's edits, then submissions and lookup repairs, then cleanup repairs, each group oldest first", () => {
    const repair1 = enqueueCleanupRepair(store, dup(1), T0 + 1);
    const repair2 = enqueueCleanupRepair(store, dup(2), T0 + 2);
    const edit1 = enqueueOperatorEdit(store, { edit: OperatorEditKind.Cleanup, note: "n" }, T0 + 3);
    const s1 = sub(4);
    const lookup = enqueueRequest(store, { kind: RequestKind.LookupRepair, targets: ["x"] }, T0 + 5);
    const edit2 = enqueueOperatorEdit(store, { edit: OperatorEditKind.Cleanup, note: "n" }, T0 + 6);
    const s2 = sub(7);
    const order: string[] = [];
    for (let r = takeNextRequest(store); r; r = takeNextRequest(store)) order.push(r.id);
    expect(order).toEqual([edit1, edit2, s1, lookup, s2, repair1, repair2]);
  });

  it("counts for a place only the queued requests that run before it, cleanup repairs not included", () => {
    enqueueCleanupRepair(store, dup(1), T0 + 1);
    enqueueCleanupRepair(store, dup(2), T0 + 2);
    const first = sub(3);
    const repair = enqueueCleanupRepair(store, dup(3), T0 + 4);
    const second = sub(5);
    expect(queuePosition(store, first)).toBe(1);
    expect(queuePosition(store, second)).toBe(2);
    expect(queuePosition(store, repair)).toBe(5);
    takeNextRequest(store);
    expect(queuePosition(store, first)).toBe(0);
    expect(queuePosition(store, second)).toBe(1);
  });

  it("records started_at when the worker takes the row", () => {
    const a = sub(1);
    takeNextRequest(store, T0 + 500);
    const row = store.db.prepare("SELECT started_at FROM change_requests WHERE id = ?").get(a) as {
      started_at: number | null;
    };
    expect(row.started_at).toBe(T0 + 500);
  });

  it("finish sets done", () => {
    const a = sub(1);
    takeNextRequest(store);
    finishRequest(store, a, T0 + 9);
    expect(getRequest(store, a)).toMatchObject({ status: RequestStatus.Done, finishedAt: T0 + 9 });
  });

  it("a failed attempt goes back to queued, and the third failure is final", () => {
    const a = sub(1);
    takeNextRequest(store);
    expect(failAttempt(store, a, "overloaded", T0)).toBe(RequestStatus.Queued);
    expect(getRequest(store, a)).toMatchObject({ status: RequestStatus.Queued, attempts: 1, error: "overloaded" });
    takeNextRequest(store);
    expect(failAttempt(store, a, "timeout", T0)).toBe(RequestStatus.Queued);
    takeNextRequest(store);
    expect(failAttempt(store, a, "invalid output", T0 + 5)).toBe(RequestStatus.Failed);
    expect(getRequest(store, a)).toMatchObject({
      status: RequestStatus.Failed,
      attempts: 3,
      error: "invalid output",
      finishedAt: T0 + 5,
    });
    expect(takeNextRequest(store)).toBeNull();
    expect(listFailed(store).map((r) => r.id)).toEqual([a]);
  });

  it("resetRunning puts running rows back to queued", () => {
    const a = sub(1);
    sub(2);
    takeNextRequest(store);
    expect(resetRunning(store)).toBe(1);
    expect(must(getRequest(store, a)).status).toBe(RequestStatus.Queued);
    expect(must(takeNextRequest(store)).id).toBe(a);
  });

  it("requeue resets a failed row only", () => {
    const a = sub(1);
    for (let i = 0; i < 3; i++) {
      takeNextRequest(store);
      failAttempt(store, a, "e");
    }
    expect(requeue(store, a)).toBe(true);
    expect(getRequest(store, a)).toMatchObject({
      status: RequestStatus.Queued,
      attempts: 0,
      error: null,
      finishedAt: null,
    });
    expect(requeue(store, a)).toBe(false);
  });

  it("validates input", () => {
    expect(() => enqueueRequest(store, { change: "", justification: "j" })).toThrow(/change/);
    expect(() => enqueueRequest(store, { change: "c", justification: " " })).toThrow(/justification/);
    expect(() => enqueueRequest(store, { kind: RequestKind.LookupRepair, targets: [] })).toThrow(/one target/);
    const id = enqueueRequest(store, { kind: RequestKind.LookupRepair, targets: ["f1"] }, T0);
    expect(getRequest(store, id)).toMatchObject({
      kind: RequestKind.LookupRepair,
      change: null,
      justification: null,
      searchId: null,
    });
  });

  it("refuses a targets column that is not a JSON array of ids", () => {
    const id = sub(1);
    store.db.prepare("UPDATE change_requests SET targets = ? WHERE id = ?").run('{"not":"a list"}', id);
    expect(() => getRequest(store, id)).toThrow(/targets/);
  });
});

describe("a request that only the staging tables hold (the child of a split in a fixed batch)", () => {
  // The row moves from the queue to the staging tables, as the child of a split does in a batch.
  const staged = (n: number): string => {
    const id = sub(n);
    store.db.prepare("INSERT INTO stg_change_requests SELECT * FROM change_requests WHERE id = ?").run(id);
    store.db.prepare("DELETE FROM change_requests WHERE id = ?").run(id);
    return id;
  };

  it("reads the row from the queue first and from the staging tables when the queue has none", () => {
    const live = sub(1);
    const id = staged(2);
    expect(getBatchRequest(store, live)?.id).toBe(live);
    expect(getBatchRequest(store, id)?.id).toBe(id);
    expect(getRequest(store, id)).toBeNull();
    expect(getBatchRequest(store, "nope")).toBeNull();
  });

  it("takes a queued staged row once, sets it running there and leaves the queue alone", () => {
    const id = staged(1);
    expect(takeStagedRequest(store, id, T0 + 10)).toMatchObject({ id, status: RequestStatus.Running });
    expect(takeStagedRequest(store, id, T0 + 11)).toBeNull();
    expect(getBatchRequest(store, id)).toMatchObject({ status: RequestStatus.Running });
    expect(takeStagedRequest(store, "nope", T0)).toBeNull();
  });

  it("puts a staged row back to queued with the error and no attempt counted", () => {
    const id = staged(1);
    takeStagedRequest(store, id, T0 + 10);
    releaseStagedRequest(store, id, "rate limit");
    expect(getBatchRequest(store, id)).toMatchObject({
      status: RequestStatus.Queued,
      error: "rate limit",
      attempts: 0,
    });
    expect(() => releaseStagedRequest(store, "nope", "x")).toThrow(/unknown staged request/);
  });
});
