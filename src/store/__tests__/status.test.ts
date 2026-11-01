import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CallFailureKind } from "../../domain/enums.js";
import { makeStore } from "../../../__tests__/helpers/store.js";
import { WORKER_STATUS_KEY, closeStore, readWorkerStatus, writeWorkerStatus, type Store } from "../index.js";

let store: Store;
beforeEach(() => {
  store = makeStore();
});
afterEach(() => closeStore(store));

describe('worker status (technical/updates.md, "Queue and worker")', () => {
  it("reads undefined when no worker wrote one", () => {
    expect(readWorkerStatus(store)).toBeUndefined();
  });

  it("round-trips a status with a failed call", () => {
    const status = {
      pid: 42,
      startedAt: 1000,
      lastPollAt: 2000,
      lastCall: { ok: false as const, kind: CallFailureKind.Credential, message: "401", at: 1500 },
      consecutiveFailures: 2,
    };
    writeWorkerStatus(store, status);
    expect(readWorkerStatus(store)).toEqual(status);
  });

  it("round-trips a status with no call yet and one with an ok call", () => {
    writeWorkerStatus(store, { pid: 1, startedAt: 1, lastPollAt: 1, consecutiveFailures: 0 });
    expect(readWorkerStatus(store)).toEqual({ pid: 1, startedAt: 1, lastPollAt: 1, consecutiveFailures: 0 });
    writeWorkerStatus(store, {
      pid: 1,
      startedAt: 1,
      lastPollAt: 3,
      lastCall: { ok: true, at: 3 },
      consecutiveFailures: 0,
    });
    expect(readWorkerStatus(store)?.lastCall).toEqual({ ok: true, at: 3 });
  });

  it("keeps one row: a second write replaces the first", () => {
    writeWorkerStatus(store, { pid: 1, startedAt: 1, lastPollAt: 1, consecutiveFailures: 0 });
    writeWorkerStatus(store, { pid: 1, startedAt: 1, lastPollAt: 9, consecutiveFailures: 0 });
    const n = store.db.prepare("SELECT COUNT(*) AS n FROM meta WHERE key = ?").get(WORKER_STATUS_KEY) as { n: number };
    expect(n.n).toBe(1);
    expect(readWorkerStatus(store)?.lastPollAt).toBe(9);
  });

  it("reads undefined for a value that does not parse", () => {
    store.db.prepare("INSERT INTO meta(key, value) VALUES (?, ?)").run(WORKER_STATUS_KEY, "{not json");
    expect(readWorkerStatus(store)).toBeUndefined();
    store.db.prepare("UPDATE meta SET value = ? WHERE key = ?").run(JSON.stringify({ pid: "x" }), WORKER_STATUS_KEY);
    expect(readWorkerStatus(store)).toBeUndefined();
  });
});
