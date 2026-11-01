import { afterEach, describe, expect, it } from "vitest";
import type { LogLine } from "../../log/index.js";
import { ChangeOutcome, CleanupFinder, RequestKind, RequestStatus } from "../../domain/enums.js";
import {
  CLEANUP_EVERY,
  CLEANUP_EVERY_MIN,
  type CleanupEvery,
  writeCleanupFull,
  REPAIRS_TO_SHORTEN,
  closeStore,
  highestChangeSeq,
  readCleanupEvery,
  readCleanupFull,
  readCleanupPending,
  writeCleanupEvery,
  writeCleanupSeq,
  type Store,
} from "../../store/index.js";
import { T0, makeStore } from "../../../__tests__/helpers/store.js";
import { cleanupIfDue, runCleanup } from "../cleanup-run.js";
import { duplicatePairs, endQueuedRepairs, seqsAt, wroteRepair, wroteSubmission } from "./helpers/cleanup.js";

const stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) closeStore(s);
});
const lines: LogLine[] = [];
const log = (l: LogLine): void => void lines.push(l);

const FINDER = CleanupFinder.DuplicateFact;

const setRepairs = (s: Store, status: RequestStatus): void => {
  s.db.prepare("UPDATE change_requests SET status = ? WHERE kind = ?").run(status, RequestKind.CleanupRepair);
};

// A store whose finder ran at the highest seq, then a run that `repairs` repairs answer.
async function afterRun(repairs: number): Promise<Store> {
  const s = makeStore();
  stores.push(s);
  await duplicatePairs(s, 1);
  writeCleanupSeq(s, seqsAt(highestChangeSeq(s)));
  runCleanup(s, T0, log, [FINDER]);
  endQueuedRepairs(s);
  let at = T0;
  for (let i = 0; i < repairs; i++) wroteRepair(s, FINDER, ++at);
  return s;
}

describe("the interval after a run", () => {
  it("lengthens the interval after a run with no repair", async () => {
    const s = await afterRun(0);
    cleanupIfDue(s, log);
    expect(readCleanupEvery(s)[FINDER]).toBeGreaterThan(CLEANUP_EVERY[FINDER]);
  });

  it("shortens the interval after a run with REPAIRS_TO_SHORTEN repairs, and keeps it under that", async () => {
    const s = await afterRun(REPAIRS_TO_SHORTEN);
    cleanupIfDue(s, log);
    expect(readCleanupEvery(s)[FINDER]).toBeLessThan(CLEANUP_EVERY[FINDER]);
    const t = await afterRun(1);
    cleanupIfDue(t, log);
    expect(readCleanupEvery(t)[FINDER]).toBe(CLEANUP_EVERY[FINDER]);
  });

  it("sets it once per run: a second call changes nothing", async () => {
    const s = await afterRun(0);
    cleanupIfDue(s, log);
    const once = readCleanupEvery(s);
    expect(readCleanupPending(s)).toEqual([]);
    cleanupIfDue(s, log);
    expect(readCleanupEvery(s)).toEqual(once);
  });

  it("does not settle or run a pending finder while a repair of its run is queued or running, and settles it after they end", async () => {
    const s = makeStore();
    stores.push(s);
    await duplicatePairs(s, 1);
    writeCleanupSeq(s, seqsAt(highestChangeSeq(s)));
    expect(runCleanup(s, T0, log, [FINDER])).toBe(1);
    // Enough writes that the finder would be due by its interval, were it not pending.
    writeCleanupEvery(s, { ...CLEANUP_EVERY, [FINDER]: CLEANUP_EVERY_MIN });
    addChanges(s, CLEANUP_EVERY_MIN, ChangeOutcome.Accepted);
    const before = readCleanupEvery(s);
    expect(cleanupIfDue(s, log)).toBeUndefined();
    expect(readCleanupPending(s)).toEqual([FINDER]);
    expect(readCleanupEvery(s)).toEqual(before);
    setRepairs(s, RequestStatus.Running);
    expect(cleanupIfDue(s, log)).toBeUndefined();
    expect(readCleanupPending(s)).toEqual([FINDER]);
    // The repairs end with no change: the finder settles (its interval doubles) and leaves the list.
    setRepairs(s, RequestStatus.Done);
    cleanupIfDue(s, log);
    expect(readCleanupPending(s)).toEqual([]);
    expect(readCleanupEvery(s)[FINDER]).toBe(CLEANUP_EVERY_MIN * 2);
  });

  it("counts a repair only when it wrote a change above the run", async () => {
    const s = await afterRun(0);
    const id = wroteRepair(s, FINDER, T0 + 50);
    s.db.prepare("UPDATE changes SET outcome = 'rejected', reject_reason = 'unsupported' WHERE request_id = ?").run(id);
    cleanupIfDue(s, log);
    expect(readCleanupEvery(s)[FINDER]).toBeGreaterThan(CLEANUP_EVERY[FINDER]);
  });

  it("makes the finder due by the interval in meta, not by the seed", async () => {
    const s = makeStore();
    stores.push(s);
    for (let i = 0; i < CLEANUP_EVERY_MIN; i++) await duplicatePairs(s, 1);
    writeCleanupSeq(s, seqsAt(0));
    writeCleanupEvery(s, { ...CLEANUP_EVERY, [FINDER]: CLEANUP_EVERY_MIN * 100 });
    expect(cleanupIfDue(s, log)).toBeUndefined();
    writeCleanupEvery(s, { ...CLEANUP_EVERY, [FINDER]: CLEANUP_EVERY_MIN });
    expect(cleanupIfDue(s, log)).toBeDefined();
  });
});

// Adds `n` changes of one outcome above the highest seq.
function addChanges(s: Store, n: number, outcome: ChangeOutcome): void {
  for (let i = 0; i < n; i++) {
    const id = wroteSubmission(s, T0 + 1000 + highestChangeSeq(s));
    s.db.prepare("UPDATE changes SET outcome = ? WHERE request_id = ?").run(outcome, id);
  }
}

describe("the trigger counts writes", () => {
  async function atInterval(): Promise<Store> {
    const s = makeStore();
    stores.push(s);
    await duplicatePairs(s, 1);
    writeCleanupSeq(s, seqsAt(highestChangeSeq(s)));
    writeCleanupEvery(
      s,
      Object.fromEntries(Object.values(CleanupFinder).map((f) => [f, CLEANUP_EVERY_MIN])) as CleanupEvery,
    );
    return s;
  }

  it("is not due by splits, duplicates and rejections, however many", async () => {
    const s = await atInterval();
    addChanges(s, CLEANUP_EVERY_MIN, ChangeOutcome.Split);
    addChanges(s, CLEANUP_EVERY_MIN, ChangeOutcome.Duplicate);
    addChanges(s, CLEANUP_EVERY_MIN, ChangeOutcome.Rejected);
    expect(cleanupIfDue(s, log)).toBeUndefined();
  });

  it("is due at the interval in accepted changes, and not 1 under, while other outcomes sit among them", async () => {
    const s = await atInterval();
    addChanges(s, CLEANUP_EVERY_MIN - 1, ChangeOutcome.Accepted);
    addChanges(s, 3, ChangeOutcome.Split);
    addChanges(s, 3, ChangeOutcome.Rejected);
    expect(cleanupIfDue(s, log)).toBeUndefined();
    addChanges(s, 1, ChangeOutcome.Accepted);
    expect(cleanupIfDue(s, log)).toBeDefined();
  });

  it("does not count the writes of repairs toward the interval, and counts submissions", async () => {
    const s = await atInterval();
    for (let i = 0; i < CLEANUP_EVERY_MIN; i++) wroteRepair(s, FINDER, T0 + 2000 + i);
    expect(cleanupIfDue(s, log)).toBeUndefined();
    addChanges(s, CLEANUP_EVERY_MIN, ChangeOutcome.Accepted);
    expect(cleanupIfDue(s, log)).toBeDefined();
  });

  it("runs a finder that the cap cut only when an accepted change exists above its seq", async () => {
    const s = await atInterval();
    writeCleanupFull(s, [FINDER]);
    addChanges(s, 2, ChangeOutcome.Rejected);
    expect(cleanupIfDue(s, log)).toBeUndefined();
    addChanges(s, 1, ChangeOutcome.Accepted);
    expect(cleanupIfDue(s, log)).toBeDefined();
  });
});

describe("the drain of a cap-cut finder", () => {
  // A cut run of the finder with `repairs` repairs, then 1 submission write; the interval is far off.
  async function cutRun(repairs: number): Promise<Store> {
    const s = await afterRun(repairs);
    writeCleanupFull(s, [FINDER]);
    writeCleanupEvery(s, { ...CLEANUP_EVERY, [FINDER]: CLEANUP_EVERY_MIN * 100 });
    wroteSubmission(s, T0 + 5000);
    return s;
  }

  it("does not drain after a cut run with fewer repairs than REPAIRS_TO_SHORTEN", async () => {
    const s = await cutRun(REPAIRS_TO_SHORTEN - 1);
    expect(cleanupIfDue(s, log)).toBeUndefined();
    expect(readCleanupFull(s)).toEqual([]);
  });

  it("drains after a cut run with REPAIRS_TO_SHORTEN repairs, on the next write", async () => {
    const s = await cutRun(REPAIRS_TO_SHORTEN);
    expect(cleanupIfDue(s, log)).toBeDefined();
  });
});
