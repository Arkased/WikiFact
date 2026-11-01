import { afterEach, describe, expect, it } from "vitest";
import { CleanupFinder, MetaKey } from "../../domain/enums.js";
import {
  CLEANUP_EVERY,
  CLEANUP_EVERY_MAX,
  CLEANUP_EVERY_MIN,
  REPAIRS_TO_SHORTEN,
  closeStore,
  nextInterval,
  readCleanupEvery,
  type Store,
} from "../index.js";
import { makeStore } from "../../../__tests__/helpers/store.js";

const stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) closeStore(s);
});
function fresh(): Store {
  const s = makeStore();
  stores.push(s);
  return s;
}
const putMeta = (s: Store, value: string): void => {
  s.db.prepare("INSERT INTO meta(key, value) VALUES (?, ?)").run(MetaKey.CleanupEvery, value);
};

describe("nextInterval", () => {
  const mid = 100;

  it("doubles the interval for 0 repairs", () => {
    expect(nextInterval(mid, 0)).toBe(mid * 2);
  });

  it("keeps the interval for 1 and 2 repairs", () => {
    expect(nextInterval(mid, 1)).toBe(mid);
    expect(nextInterval(mid, REPAIRS_TO_SHORTEN - 1)).toBe(mid);
  });

  it("halves the interval for 3 repairs or more", () => {
    expect(nextInterval(mid, REPAIRS_TO_SHORTEN)).toBe(mid / 2);
    expect(nextInterval(mid, REPAIRS_TO_SHORTEN + 10)).toBe(mid / 2);
  });

  it("never goes below the floor", () => {
    expect(nextInterval(CLEANUP_EVERY_MIN, REPAIRS_TO_SHORTEN)).toBe(CLEANUP_EVERY_MIN);
    expect(nextInterval(CLEANUP_EVERY_MIN + 1, REPAIRS_TO_SHORTEN)).toBe(CLEANUP_EVERY_MIN);
  });

  it("never goes above the ceiling", () => {
    expect(nextInterval(CLEANUP_EVERY_MAX, 0)).toBe(CLEANUP_EVERY_MAX);
    expect(nextInterval(CLEANUP_EVERY_MAX - 1, 0)).toBe(CLEANUP_EVERY_MAX);
  });
});

describe("readCleanupEvery", () => {
  it("seeds every finder from CLEANUP_EVERY while the key is absent", () => {
    expect(readCleanupEvery(fresh())).toEqual(CLEANUP_EVERY);
  });

  it("reads the value of a finder", () => {
    const s = fresh();
    putMeta(s, JSON.stringify({ [CleanupFinder.DuplicateFact]: CLEANUP_EVERY_MAX }));
    expect(readCleanupEvery(s)[CleanupFinder.DuplicateFact]).toBe(CLEANUP_EVERY_MAX);
  });

  it("ignores a key that names a removed finder", () => {
    const s = fresh();
    putMeta(s, JSON.stringify({ oldFinder: 1, otherFinder: 7, [CleanupFinder.DuplicateFact]: CLEANUP_EVERY_MIN }));
    const every = readCleanupEvery(s);
    expect(Object.keys(every).sort()).toEqual(Object.values(CleanupFinder).sort());
    expect(every[CleanupFinder.DuplicateFact]).toBe(CLEANUP_EVERY_MIN);
  });

  it("clamps a value outside the floor and the ceiling, and seeds when the value does not parse", () => {
    const s = fresh();
    putMeta(s, JSON.stringify({ [CleanupFinder.DuplicateFact]: 0 }));
    expect(readCleanupEvery(s)[CleanupFinder.DuplicateFact]).toBe(CLEANUP_EVERY_MIN);
    s.db
      .prepare("UPDATE meta SET value = ? WHERE key = ?")
      .run(JSON.stringify({ [CleanupFinder.DuplicateFact]: CLEANUP_EVERY_MAX + 1 }), MetaKey.CleanupEvery);
    expect(readCleanupEvery(s)[CleanupFinder.DuplicateFact]).toBe(CLEANUP_EVERY_MAX);
    s.db.prepare("UPDATE meta SET value = ? WHERE key = ?").run("not json", MetaKey.CleanupEvery);
    expect(readCleanupEvery(s)).toEqual(CLEANUP_EVERY);
  });
});
