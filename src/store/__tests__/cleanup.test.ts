import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CleanupFinder, MetaKey, RequestKind, RequestStatus } from "../../domain/enums.js";
import {
  CLEANUP_FINDERS,
  cleanupCandidates as findCandidates,
  closeStore,
  enqueueCleanupRepair,
  enqueueCleanupRepairs,
  failAttempt,
  finishRequest,
  getRequest,
  highestChangeSeq,
  isCovered,
  parseCleanupRepair,
  readCleanupFull,
  readCleanupSeq,
  seedChange,
  takeNextRequest,
  verdictSubject,
  writeCleanupFull,
  writeCleanupSeq,
  writeVerdicts,
  type Store,
  type CleanupRepair,
} from "../index.js";
import { T0, accepted, draft, makeStore } from "../../../__tests__/helpers/store.js";

let store: Store;
let clock: number;
beforeEach(() => {
  store = makeStore();
  clock = T0;
});
afterEach(() => closeStore(store));

function must<T>(x: T | undefined | null): T {
  if (x === undefined || x === null) throw new Error("expected a value");
  return x;
}

// Writes one change set; every call moves the clock, so the versions have distinct times.
async function put(facts: Parameters<typeof draft>[0][]) {
  clock += 1;
  return seedChange(store, accepted(facts.map((f) => draft(f))), { now: clock });
}

const fact = (header: string, content: string) => ({ header, content });

// The candidates of the default finders; the tests of `cut` call `findCandidates` itself.
const cleanupCandidates = (s: Store, limits: Parameters<typeof findCandidates>[1] = {}): CleanupRepair[] =>
  findCandidates(s, limits).candidates;

// Writes `n` pairs of near-duplicate facts that share no word with another pair, so the finder offers `n` candidates.
async function seedPairs(n: number): Promise<string[]> {
  const facts = Array.from({ length: n }, (_, i) => [
    fact(`Pair${i}x one`, `Pair${i}x alpha${i}x beta${i}x gamma${i}x delta${i}x.`),
    fact(`Pair${i}x two`, `Pair${i}x alpha${i}x beta${i}x gamma${i}x delta${i}x again.`),
  ]).flat();
  return (await put(facts)).factIds;
}

describe("cleanupCandidates", () => {
  it("offers only the duplicate fact finder, and nothing on a wiki with no near-duplicate", async () => {
    await put([fact("Creeper fuse", "A creeper fuse burns."), fact("Zombie moan", "A zombie moans at night.")]);
    expect(cleanupCandidates(store, {})).toEqual([]);
    expect(CLEANUP_FINDERS).toEqual([CleanupFinder.DuplicateFact]);
    const ids = await seedPairs(1);
    expect(cleanupCandidates(store, {})).toEqual([
      { finder: CleanupFinder.DuplicateFact, factIds: [must(ids[0]), must(ids[1])] },
    ]);
  });

  it("cuts the finder at its cap, and cuts nothing whose candidates fit", async () => {
    await seedPairs(3);
    expect(findCandidates(store, { cap: 100 }).cut).toEqual([]);
    const capped = findCandidates(store, { cap: 2 });
    expect(capped.candidates).toHaveLength(2);
    expect(capped.cut).toEqual([CleanupFinder.DuplicateFact]);
    expect(findCandidates(store, { cap: 2 }, []).candidates).toEqual([]);
  });

  it("skips a candidate that a queued or running cleanupRepair request holds, and takes it again once the request is done or failed", async () => {
    const ids = await seedPairs(1);
    const doc: CleanupRepair = { finder: CleanupFinder.DuplicateFact, factIds: [must(ids[0]), must(ids[1])] };
    const found = (): number => cleanupCandidates(store, {}).length;
    expect(found()).toBe(1);
    const id = enqueueCleanupRepair(store, doc, clock);
    expect(found()).toBe(0);
    expect(takeNextRequest(store, clock)?.id).toBe(id);
    expect(found()).toBe(0);
    finishRequest(store, id, clock);
    expect(found()).toBe(1);
    const again = enqueueCleanupRepair(store, doc, clock);
    takeNextRequest(store, clock);
    failAttempt(store, again, "x", clock);
    failAttempt(store, again, "x", clock);
    expect(found()).toBe(0);
    takeNextRequest(store, clock);
    expect(failAttempt(store, again, "x", clock)).toBe(RequestStatus.Failed);
    expect(found()).toBe(1);
  });

  it("holds a queued request of a removed finder as nothing: it does not parse", () => {
    store.db
      .prepare(
        "INSERT INTO change_requests(id, kind, status, change, targets, received_at) VALUES ('r1', ?, ?, ?, '[]', ?)",
      )
      .run(RequestKind.CleanupRepair, RequestStatus.Queued, JSON.stringify({ finder: "oldFinder", factId: "f1" }), T0);
    expect(cleanupCandidates(store, {})).toEqual([]);
  });
});

describe("the cleanupRepair request row", () => {
  it("is stored with the document as change, a null justification and the ids as targets", () => {
    const id = enqueueCleanupRepair(store, { finder: CleanupFinder.DuplicateFact, factIds: ["f1", "f2"] }, T0);
    const row = must(getRequest(store, id));
    expect(row.kind).toBe(RequestKind.CleanupRepair);
    expect(row.status).toBe(RequestStatus.Queued);
    expect(row.justification).toBeNull();
    expect(row.targets).toEqual(["f1", "f2"]);
    expect(parseCleanupRepair(must(row.change))).toEqual({
      finder: CleanupFinder.DuplicateFact,
      factIds: ["f1", "f2"],
    });
  });

  it("enqueueCleanupRepairs writes one row per candidate in order, and none when a candidate is invalid", () => {
    const a: CleanupRepair = { finder: CleanupFinder.DuplicateFact, factIds: ["f1", "f2"] };
    const b: CleanupRepair = { finder: CleanupFinder.DuplicateFact, factIds: ["f3", "f4"] };
    expect(enqueueCleanupRepairs(store, [], T0)).toEqual([]);
    const ids = enqueueCleanupRepairs(store, [a, b], T0);
    expect(ids).toHaveLength(2);
    expect(ids.map((id) => parseCleanupRepair(must(getRequest(store, id)?.change)))).toEqual([a, b]);
    expect(ids.map((id) => getRequest(store, id)?.receivedAt)).toEqual([T0, T0]);
    const bad: CleanupRepair = { finder: CleanupFinder.DuplicateFact, factIds: ["a", "a"] };
    expect(() => enqueueCleanupRepairs(store, [a, bad], T0)).toThrow(/2 different facts/);
    const count = (store.db.prepare("SELECT COUNT(*) AS n FROM change_requests").get() as { n: number }).n;
    expect(count).toBe(2);
  });

  it("refuses a pair of one fact, and an unknown finder", () => {
    expect(() => enqueueCleanupRepair(store, { finder: CleanupFinder.DuplicateFact, factIds: ["a", "a"] })).toThrow(
      /2 different facts/,
    );
    expect(() => parseCleanupRepair('{"finder":"nope"}')).toThrow(/invalid/);
    expect(() => parseCleanupRepair("not json")).toThrow(/JSON/);
    expect(() => parseCleanupRepair(JSON.stringify({ finder: "oldFinder", factId: "f" }))).toThrow(/invalid/);
  });
});

describe("the cleanup state", () => {
  const seqs = (n: number): Record<CleanupFinder, number> =>
    Object.fromEntries(CLEANUP_FINDERS.map((f, i) => [f, n + i])) as Record<CleanupFinder, number>;
  const setMeta = (key: MetaKey, value: string): void =>
    void store.db
      .prepare("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);

  it("keeps the seq of each finder in meta and reads the highest change seq", async () => {
    expect(readCleanupSeq(store)).toBeUndefined();
    expect(highestChangeSeq(store)).toBe(0);
    writeCleanupSeq(store, seqs(123));
    expect(readCleanupSeq(store)).toEqual(seqs(123));
    writeCleanupSeq(store, seqs(456));
    expect(readCleanupSeq(store)).toEqual(seqs(456));
    const res = await put([fact("Hit", "A hit.")]);
    expect(highestChangeSeq(store)).toBe(res.seq);
  });

  it("counts a cleanup_seq value that does not parse as absent", () => {
    for (const bad of ["not json", "123", '{"duplicateFact":"x"}', '{"oldFinder":1}']) {
      setMeta(MetaKey.CleanupSeq, bad);
      expect(readCleanupSeq(store)).toBeUndefined();
    }
  });

  it("ignores a key of a finder that no longer exists, such as oldFinder", () => {
    setMeta(MetaKey.CleanupSeq, JSON.stringify({ ...seqs(7), oldFinder: 3, otherFinder: 4 }));
    expect(readCleanupSeq(store)).toEqual(seqs(7));
    setMeta(MetaKey.CleanupFull, JSON.stringify(["oldFinder", "otherFinder", CleanupFinder.DuplicateFact]));
    expect(readCleanupFull(store)).toEqual([CleanupFinder.DuplicateFact]);
  });

  it("round trips cleanup_full, and counts an absent or bad value as no finder", () => {
    expect(readCleanupFull(store)).toEqual([]);
    writeCleanupFull(store, [CleanupFinder.DuplicateFact]);
    expect(readCleanupFull(store)).toEqual([CleanupFinder.DuplicateFact]);
    for (const bad of ["nope", '["nope"]', "{}"]) {
      setMeta(MetaKey.CleanupFull, bad);
      expect(readCleanupFull(store)).toEqual([]);
    }
  });

  it("keeps a duplicate fact verdict until the header or the content of either fact changes", async () => {
    const res = await put([fact("Fuse", "A fuse."), fact("Fuse time", "A fuse burns.")]);
    const [a, b] = [must(res.factIds[0]), must(res.factIds[1])];
    const subject = verdictSubject([a, b]);
    expect(isCovered(store, CleanupFinder.DuplicateFact, subject)).toBe(false);
    clock += 1;
    writeVerdicts(store, CleanupFinder.DuplicateFact, [subject], clock);
    expect(isCovered(store, CleanupFinder.DuplicateFact, subject)).toBe(true);
    // A new header of 1 fact ends it.
    await put([{ factId: a, ...fact("Fuse duration", "A fuse.") }]);
    expect(isCovered(store, CleanupFinder.DuplicateFact, subject)).toBe(false);
    // A new verdict, then a new content of the other fact ends it.
    clock += 1;
    writeVerdicts(store, CleanupFinder.DuplicateFact, [subject], clock);
    expect(isCovered(store, CleanupFinder.DuplicateFact, subject)).toBe(true);
    await put([{ factId: b, ...fact("Fuse time", "A fuse burns for 1.5 seconds.") }]);
    expect(isCovered(store, CleanupFinder.DuplicateFact, subject)).toBe(false);
  });
});
