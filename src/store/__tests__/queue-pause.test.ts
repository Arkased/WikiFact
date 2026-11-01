import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MetaKey } from "../../domain/enums.js";
import { makeStore } from "../../../__tests__/helpers/store.js";
import { clearQueuePause, closeStore, readQueuePause, setQueuePause, type Store } from "../index.js";

let store: Store;
beforeEach(() => {
  store = makeStore();
});
afterEach(() => closeStore(store));

describe('operator pause of the queue (technical/updates.md, "Queue and worker")', () => {
  it("reads undefined when the queue runs", () => {
    expect(readQueuePause(store)).toBeUndefined();
  });

  it("round-trips the time and the note, and a second pause replaces the first", () => {
    setQueuePause(store, "before the eval", 1000);
    expect(readQueuePause(store)).toEqual({ at: 1000, note: "before the eval" });
    setQueuePause(store, "again", 2000);
    expect(readQueuePause(store)).toEqual({ at: 2000, note: "again" });
  });

  it("resumes by removing the key, and a resume of a running queue is harmless", () => {
    setQueuePause(store, "n", 1);
    clearQueuePause(store);
    expect(readQueuePause(store)).toBeUndefined();
    clearQueuePause(store);
    expect(readQueuePause(store)).toBeUndefined();
  });

  it("reads a value that does not parse as no pause", () => {
    store.db.prepare("INSERT INTO meta(key, value) VALUES (?, ?)").run(MetaKey.QueuePause, "not json");
    expect(readQueuePause(store)).toBeUndefined();
  });
});
