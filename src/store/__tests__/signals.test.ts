import { describe, expect, it } from "vitest";
import {
  ChangeOutcome,
  CleanupFinder,
  OperatorEditKind,
  RejectReason,
  RequestStatus,
  RetrievalKind,
  SearchHitKind,
  Span,
} from "../../domain/enums.js";
import { T0, draft, factIdOf, makeStore } from "../../../__tests__/helpers/store.js";
import { FAKE_PRICES, PRICED_MODEL } from "../../../__tests__/helpers/prices.js";
import {
  CLEANUP_EVERY,
  CLEANUP_EVERY_MAX,
  writeCleanupEvery,
  GROWTH_STRETCHES,
  applyChangeSync,
  enqueueOperatorEdit,
  enqueueRequest,
  enqueueCleanupRepair,
  finishRequest,
  jobRows,
  openSession,
  readsPerSearch,
  recordModelCall,
  recordRetrieval,
  recordSearch,
  searchMisses,
  spanBounds,
  growthSeries,
  tokenCost,
  writeCleanupFull,
  writeCleanupPending,
  writeCleanupSeq,
  type FactDraft,
  type ModelCallInput,
  type SpanBounds,
  type Store,
} from "../index.js";

const ALL: SpanBounds = { searches: 0, fromAt: null, toAt: null };

function search(
  s: Store,
  id: string,
  sessionId: string | null,
  ...when: [at: number, results: [SearchHitKind, string][]]
): void {
  const [at, results] = when;
  recordSearch(s, {
    id,
    sessionId,
    query: "q",
    at,
    durationMs: 1,
    results: results.map(([kind, targetId], i) => ({ kind, targetId, rank: i + 1, ref: refOf(id, targetId) })),
  });
}

// The ref that `search` mints for a result in these tests.
const refOf = (searchId: string, targetId: string): string => `${searchId}:${targetId}`;

// A change request of the given time, finished, that names the search `searchId` when given.
function request(s: Store, at: number, searchId?: string): string {
  const id = enqueueRequest(s, { change: "c", justification: "j", searchId }, at);
  finishRequest(s, id, at + 1);
  return id;
}

function calls(s: Store, requestId: string, tokensIn: number, tokensCacheWrite = 0): void {
  recordModelCall(s, {
    requestId,
    question: "Q1",
    model: "m",
    effort: "low",
    tokensIn,
    tokensOut: 0,
    tokensCacheRead: 0,
    tokensCacheWrite,
    durationMs: 1,
    at: T0,
  });
}

function outcome(s: Store, requestId: string, kind: ChangeOutcome, ...opts: [writesFact?: boolean, at?: number]): void {
  const [facts = false, at = T0] = opts;
  if (facts) {
    applyChangeSync(
      s,
      requestId,
      { outcome: ChangeOutcome.Accepted, summary: "s", changeReasoning: "r", facts: [draft()] },
      { now: at },
    );
    return;
  }
  s.db
    .prepare("INSERT INTO changes(request_id, outcome, reject_reason, summary, created_at) VALUES (?, ?, ?, 's', ?)")
    .run(requestId, kind, kind === ChangeOutcome.Rejected ? RejectReason.Unsupported : null, at);
}

describe("spanBounds", () => {
  it("bounds the recent span by its newest searches and leaves All without a bound", () => {
    const s = makeStore();
    search(s, "q1", null, T0 + 10, []);
    search(s, "q2", null, T0 + 20, []);
    search(s, "q3", null, T0 + 30, []);
    const recent = 2;
    expect(spanBounds(s, Span.Recent, recent)).toEqual({ searches: recent, fromAt: T0 + 20, toAt: T0 + 30 });
    expect(spanBounds(s, Span.All, recent)).toEqual({ searches: 3, fromAt: null, toAt: null });
  });

  it("holds every search when the wiki has fewer than the recent size", () => {
    const s = makeStore();
    search(s, "q1", null, T0 + 10, []);
    expect(spanBounds(s, Span.Recent, 5)).toEqual({ searches: 1, fromAt: T0 + 10, toAt: T0 + 10 });
  });

  it("has 0 searches and no bound for a wiki with no search", () => {
    const s = makeStore();
    expect(spanBounds(s, Span.Recent, 5)).toEqual({ searches: 0, fromAt: null, toAt: null });
    expect(spanBounds(s, Span.All, 5)).toEqual({ searches: 0, fromAt: null, toAt: null });
  });
});

describe("growthSeries", () => {
  // A change request received at `at` that writes `facts`, finished; returns the ids of the facts it wrote.
  function writing(s: Store, at: number, facts: FactDraft[]): string[] {
    const id = enqueueRequest(s, { change: "c", justification: "j" }, T0 + at);
    const result = applyChangeSync(
      s,
      id,
      { outcome: ChangeOutcome.Accepted, summary: "s", changeReasoning: "r", facts },
      { now: T0 + at },
    );
    finishRequest(s, id, T0 + at + 1);
    return result.factIds;
  }

  it("counts an addition, a correction, a deletion, a request that does both, and a request that wrote nothing", () => {
    const s = makeStore();
    search(s, "q1", null, T0 + 100, []);
    // 50: before the first search, counts nowhere, but its fact exists for the corrections below.
    const [old = ""] = writing(s, 50, [draft({ header: "Old" })]);
    const [a = ""] = writing(s, 110, [draft({ header: "A" })]); // an addition
    writing(s, 120, [draft({ header: "A", factId: a, content: "Changed." })]); // a correction
    writing(s, 130, [draft({ header: "A", factId: a, isDeleted: true })]); // a deletion: a correction
    writing(s, 140, [draft({ header: "B" }), draft({ header: "Old", factId: old, content: "Changed." })]); // both
    outcome(s, request(s, T0 + 150), ChangeOutcome.Rejected); // wrote nothing: neither
    search(s, "q2", null, T0 + 200, []);
    // 2 searches are 2 stretches of 1: every request lies between the 2 searches, so it is in the first stretch.
    expect(growthSeries(s, ALL)).toEqual([
      {
        searches: 1,
        count: 1,
        additions: 2,
        corrections: 3,
        additionsPerSearch: 2,
        correctionsPerSearch: 3,
        liveFacts: 1,
        liveBefore: 1,
      },
      {
        searches: 2,
        count: 1,
        additions: 0,
        corrections: 0,
        additionsPerSearch: 0,
        correctionsPerSearch: 0,
        liveFacts: 2,
        liveBefore: 2,
      },
    ]);
  });

  it("keeps 1 stretch per search up to GROWTH_STRETCHES searches", () => {
    const s = makeStore();
    for (let i = 0; i < GROWTH_STRETCHES; i++) search(s, `q${i}`, null, T0 + i, []);
    const series = growthSeries(s, ALL);
    expect(series.map((p) => p.searches)).toEqual(Array.from({ length: GROWTH_STRETCHES }, (_, i) => i + 1));
    expect(series.every((p) => p.count === 1)).toBe(true);
  });

  it("cuts GROWTH_STRETCHES + 1 searches into stretches of 2, the last one shorter", () => {
    const s = makeStore();
    for (let i = 0; i <= GROWTH_STRETCHES; i++) search(s, `q${i}`, null, T0 + i, []);
    const series = growthSeries(s, ALL);
    expect(series).toHaveLength(GROWTH_STRETCHES / 2 + 1);
    expect(series.slice(0, 3).map((p) => p.searches)).toEqual([2, 4, 6]);
    expect(series.at(-1)).toMatchObject({ searches: GROWTH_STRETCHES + 1, count: 1 });
  });

  it("divides the requests of each stretch by the searches of that stretch, not by a count from the start", () => {
    const s = makeStore();
    // 5 * GROWTH_STRETCHES searches: a size of 2 would give too many stretches, so the size is 5 and there are
    // GROWTH_STRETCHES of them. 3 additions come in the 1st stretch and 1 in a middle stretch; every other stretch has none.
    const size = 5;
    const stretchCount = GROWTH_STRETCHES;
    const gap = 10;
    for (let i = 0; i < size * stretchCount; i++) search(s, `q${i}`, null, T0 + i * gap, []);
    for (const at of [1, 2, 3]) writing(s, at + 5, [draft({ header: `H${at}` })]);
    const middle = Math.floor(stretchCount / 2);
    writing(s, middle * size * gap + 5, [draft({ header: "Late" })]);
    const series = growthSeries(s, ALL);
    expect(series).toHaveLength(stretchCount);
    expect(series[0]).toMatchObject({ searches: size, count: size, additions: 3, additionsPerSearch: 3 / size });
    expect(series[1]).toMatchObject({ additions: 0, additionsPerSearch: 0 });
    expect(series[middle]).toMatchObject({
      searches: (middle + 1) * size,
      additions: 1,
      additionsPerSearch: 1 / size,
    });
    expect(series.at(-1)).toMatchObject({ additions: 0, additionsPerSearch: 0 });
  });

  it("ends each stretch of a span at a multiple of the stretch size in the searches of the wiki", () => {
    const s = makeStore();
    // The wiki has 20 * GROWTH_STRETCHES + 3 searches (1,003), the span the newest 4 * GROWTH_STRETCHES: stretches of 5,
    // and the span starts after 803 searches, so the first stretch holds 2 searches and the last 3.
    const size = 5;
    const total = 20 * GROWTH_STRETCHES + 3;
    for (let i = 0; i < total; i++) search(s, `q${String(i).padStart(5, "0")}`, null, T0 + i, []);
    const series = growthSeries(s, spanBounds(s, Span.Recent, 4 * GROWTH_STRETCHES));
    expect(series.length).toBeLessThanOrEqual(GROWTH_STRETCHES);
    expect(series[0]).toMatchObject({
      searches: Math.ceil((total - 4 * GROWTH_STRETCHES + 1) / size) * size,
      count: 2,
    });
    for (const stretch of series.slice(0, -1)) expect(stretch.searches % size).toBe(0);
    expect(series.at(-1)).toMatchObject({ searches: total, count: 3 });
    expect(series.reduce((sum, p) => sum + p.count, 0)).toBe(4 * GROWTH_STRETCHES);
  });

  it("counts the live facts at the time of the last search of each stretch, and not a deleted fact", () => {
    const s = makeStore();
    for (const [i, at] of [100, 200, 300, 400].entries()) search(s, `q${i}`, null, T0 + at, []);
    const [a = ""] = writing(s, 50, [draft({ header: "A" })]);
    writing(s, 150, [draft({ header: "B" })]);
    writing(s, 250, [draft({ header: "A", factId: a, isDeleted: true })]);
    writing(s, 350, [draft({ header: "C" })]);
    expect(growthSeries(s, ALL).map((p) => p.liveFacts)).toEqual([1, 2, 1, 2]);
  });

  it("returns no stretch for a wiki with no search", () => {
    const s = makeStore();
    request(s, T0);
    expect(growthSeries(s, ALL)).toEqual([]);
  });

  it("counts the children of a split in place of the split, and no request of another kind", () => {
    const s = makeStore();
    search(s, "q1", null, T0 + 100, []);
    const parent = request(s, T0 + 110);
    outcome(s, parent, ChangeOutcome.Split);
    for (const at of [111, 112]) {
      const id = enqueueRequest(s, { change: "c", justification: "j", parentId: parent }, T0 + at);
      finishRequest(s, id, T0 + at);
    }
    enqueueOperatorEdit(s, { edit: OperatorEditKind.Reindex, note: "n" }, T0 + 113);
    search(s, "q2", null, T0 + 200, []);
    // The split and its 2 children wrote nothing; only the count of requests that wrote matters now.
    const child = (at: number): void => void writing(s, at, [draft({ header: `C${at}` })]);
    child(114);
    child(115);
    expect(growthSeries(s, ALL)[0]).toMatchObject({ searches: 1, additions: 2, corrections: 0 });
  });

  it("starts a recent span at its first search: the x axis counts the searches of the wiki, the rates count the span", () => {
    const s = makeStore();
    for (const [i, at] of [100, 200, 300, 400].entries()) search(s, `q${i}`, null, T0 + at, []);
    // 150 and 250: before the first search of the span (300), they count nowhere but their facts are live; 350: in the span
    for (const at of [150, 250, 350]) writing(s, at, [draft({ header: `H${at}` })]);
    const recent = spanBounds(s, Span.Recent, 2);
    expect(growthSeries(s, recent)).toEqual([
      {
        searches: 3,
        count: 1,
        additions: 1,
        corrections: 0,
        additionsPerSearch: 1,
        correctionsPerSearch: 0,
        liveFacts: 2,
        liveBefore: 2,
      },
      {
        searches: 4,
        count: 1,
        additions: 0,
        corrections: 0,
        additionsPerSearch: 0,
        correctionsPerSearch: 0,
        liveFacts: 3,
        liveBefore: 3,
      },
    ]);
  });

  it("is empty for bounds with no search", () => {
    const s = makeStore();
    search(s, "q1", null, T0 + 100, []);
    expect(growthSeries(s, { searches: 0, fromAt: T0 + 500, toAt: T0 + 600 })).toEqual([]);
  });

  it("counts a request received before the first search nowhere, but its fact is live", () => {
    const s = makeStore();
    for (const at of [10, 20, 30]) writing(s, at, [draft({ header: `H${at}` })]);
    search(s, "q1", null, T0 + 100, []);
    expect(growthSeries(s, ALL)).toEqual([
      {
        searches: 1,
        count: 1,
        additions: 0,
        corrections: 0,
        additionsPerSearch: 0,
        correctionsPerSearch: 0,
        liveFacts: 3,
        liveBefore: 3,
      },
    ]);
  });
});

describe("readsPerSearch", () => {
  function fixture(): { s: Store; factId: string } {
    const s = makeStore();
    const id = enqueueRequest(s, { change: "c", justification: "j" }, T0);
    applyChangeSync(
      s,
      id,
      {
        outcome: ChangeOutcome.Accepted,
        summary: "s",
        changeReasoning: "r",
        facts: [draft()],
      },
      { now: T0 },
    );
    openSession(s, { id: "s1", startedAt: T0 });
    openSession(s, { id: "s2", startedAt: T0 });
    return { s, factId: factIdOf(s) };
  }

  it("links a read to the search that minted its ref, and counts reads per search", () => {
    const { s, factId } = fixture();
    const F = SearchHitKind.Fact;
    search(s, "q1", "s1", T0 + 10, [[F, factId]]);
    search(s, "q2", "s1", T0 + 20, [[F, factId]]);
    search(s, "q3", "s2", T0 + 40, [[F, factId]]);
    search(s, "q4", "s1", T0 + 50, [[F, factId]]);
    recordRetrieval(s, factId, { now: T0 + 5 }); // by id: unlinked
    recordRetrieval(s, factId, { now: T0 + 15, ref: refOf("q1", factId) }); // q1
    recordRetrieval(s, factId, { now: T0 + 25, ref: refOf("q2", factId) }); // q2
    recordRetrieval(s, factId, { now: T0 + 30, ref: refOf("q2", factId) }); // q2
    recordRetrieval(s, factId, { now: T0 + 36 }); // by id: unlinked
    // q3 is the newest search of session s2 and listed the fact, but nothing read it by its ref
    for (const at of [51, 52, 53]) recordRetrieval(s, factId, { now: T0 + at, ref: refOf("q4", factId) }); // q4
    const result = readsPerSearch(s, ALL);
    expect(result).toEqual({ searches: 4, noResult: 0, unminted: 0, counts: [1, 1, 1, 1], unlinkedReads: 2 });
  });

  it("links a read to the search of its ref even when a later search of the same session listed the fact", () => {
    const { s, factId } = fixture();
    search(s, "q1", "s1", T0 + 10, [[SearchHitKind.Fact, factId]]);
    search(s, "q2", "s1", T0 + 20, [[SearchHitKind.Fact, factId]]);
    recordRetrieval(s, factId, { now: T0 + 30, ref: refOf("q1", factId) });
    expect(readsPerSearch(s, ALL)).toEqual({
      searches: 2,
      noResult: 0,
      unminted: 0,
      counts: [1, 1, 0, 0],
      unlinkedReads: 0,
    });
  });

  it("counts a search with no result in noResult and in no histogram count", () => {
    const { s, factId } = fixture();
    search(s, "q1", "s1", T0 + 10, [[SearchHitKind.Fact, factId]]);
    search(s, "q2", "s1", T0 + 20, []);
    search(s, "q3", "s2", T0 + 30, []);
    expect(readsPerSearch(s, ALL)).toEqual({
      searches: 3,
      noResult: 2,
      unminted: 0,
      counts: [1, 0, 0, 0],
      unlinkedReads: 0,
    });
  });

  it("counts a search with results and no search_results row in unminted and in no histogram count", () => {
    const { s, factId } = fixture();
    search(s, "q1", "s1", T0 + 10, [[SearchHitKind.Fact, factId]]);
    // Searches from before the minted ids: result_count above 0, no search_results row.
    for (const [id, at] of [
      ["old1", T0 + 20],
      ["old2", T0 + 30],
    ] as const) {
      search(s, id, "s1", at, [[SearchHitKind.Fact, factId]]);
      s.db.prepare("DELETE FROM search_results WHERE search_id = ?").run(id);
    }
    search(s, "q4", "s1", T0 + 40, []);
    expect(readsPerSearch(s, ALL)).toEqual({
      searches: 4,
      noResult: 1,
      unminted: 2,
      counts: [1, 0, 0, 0],
      unlinkedReads: 0,
    });
  });

  it("does not count a confirm as a read", () => {
    const { s, factId } = fixture();
    search(s, "q1", "s1", T0 + 10, [[SearchHitKind.Fact, factId]]);
    recordRetrieval(s, factId, { now: T0 + 11, kind: RetrievalKind.Confirm });
    expect(readsPerSearch(s, ALL)).toMatchObject({ counts: [1, 0, 0, 0], unlinkedReads: 0 });
  });

  it("counts the reads of the newest search of a recent span, which come after its time range", () => {
    const { s, factId } = fixture();
    const F = SearchHitKind.Fact;
    search(s, "q1", "s1", T0 + 10, [[F, factId]]);
    search(s, "q2", "s1", T0 + 20, [[F, factId]]);
    recordRetrieval(s, factId, { now: T0 + 15, ref: refOf("q1", factId) });
    recordRetrieval(s, factId, { now: T0 + 25, ref: refOf("q2", factId) });
    const bounds = spanBounds(s, Span.Recent, 1);
    expect(readsPerSearch(s, bounds)).toEqual({
      searches: 1,
      noResult: 0,
      unminted: 0,
      counts: [0, 1, 0, 0],
      unlinkedReads: 0,
    });
  });

  it("is empty for a wiki with no search", () => {
    const s = makeStore();
    expect(readsPerSearch(s, ALL)).toEqual({
      searches: 0,
      noResult: 0,
      unminted: 0,
      counts: [0, 0, 0, 0],
      unlinkedReads: 0,
    });
  });
});

describe("searchMisses", () => {
  // A request received at `T0 + at` that writes `facts` and names the search `searchId`; returns the ids of the facts it wrote.
  function writing(s: Store, at: number, facts: FactDraft[], searchId?: string): string[] {
    const id = enqueueRequest(s, { change: "c", justification: "j", searchId }, T0 + at);
    const result = applyChangeSync(
      s,
      id,
      { outcome: ChangeOutcome.Accepted, summary: "s", changeReasoning: "r", facts },
      { now: T0 + at },
    );
    finishRequest(s, id, T0 + at + 1);
    return result.factIds;
  }

  // A duplicate outcome of a request, of the fact `target`.
  function duplicateOf(s: Store, requestId: string, target: string, at: number): void {
    s.db
      .prepare("INSERT INTO changes(request_id, outcome, summary, created_at, duplicate_of) VALUES (?, ?, 's', ?, ?)")
      .run(requestId, ChangeOutcome.Duplicate, T0 + at, target);
  }

  it("counts a duplicate of an unlisted fact as a miss", () => {
    const s = makeStore();
    const [unlisted = ""] = writing(s, 10, [draft({ header: "Unlisted" })]);
    search(s, "q1", null, T0 + 100, []);
    duplicateOf(s, request(s, T0 + 110, "q1"), unlisted, 111);
    expect(searchMisses(s, ALL)).toEqual({ afterSearch: 1, missed: 1 });
  });

  it("does not count a duplicate of a listed fact", () => {
    const s = makeStore();
    const [listed = ""] = writing(s, 10, [draft({ header: "Listed" })]);
    search(s, "q1", null, T0 + 100, [[SearchHitKind.Fact, listed]]);
    duplicateOf(s, request(s, T0 + 110, "q1"), listed, 111);
    expect(searchMisses(s, ALL)).toEqual({ afterSearch: 1, missed: 0 });
  });

  it("counts a correction of an unlisted fact as a miss, and a deletion of one", () => {
    const s = makeStore();
    const [other = ""] = writing(s, 10, [draft({ header: "Other" })]);
    const [listed = ""] = writing(s, 11, [draft({ header: "Listed" })]);
    search(s, "q1", null, T0 + 100, [[SearchHitKind.Fact, listed]]);
    writing(s, 120, [draft({ header: "Other", factId: other, content: "Changed." })], "q1");
    writing(s, 130, [draft({ header: "Other", factId: other, isDeleted: true })], "q1");
    expect(searchMisses(s, ALL)).toEqual({ afterSearch: 2, missed: 2 });
  });

  it("does not count a correction or a deletion of a listed fact", () => {
    const s = makeStore();
    const [listed = ""] = writing(s, 10, [draft({ header: "Listed" })]);
    search(s, "q1", null, T0 + 100, [[SearchHitKind.Fact, listed]]);
    writing(s, 120, [draft({ header: "Listed", factId: listed, content: "Changed." })], "q1");
    writing(s, 130, [draft({ header: "Listed", factId: listed, isDeleted: true })], "q1");
    expect(searchMisses(s, ALL)).toEqual({ afterSearch: 2, missed: 0 });
  });

  it("does not count an addition, and counts a request that adds and corrects only through its corrected fact", () => {
    const s = makeStore();
    const [other = ""] = writing(s, 10, [draft({ header: "Other" })]);
    const [listed = ""] = writing(s, 11, [draft({ header: "Listed" })]);
    search(s, "q1", null, T0 + 100, [[SearchHitKind.Fact, listed]]);
    writing(s, 110, [draft({ header: "New" })], "q1"); // an addition
    // A new fact and a correction of a listed fact: not a miss.
    writing(
      s,
      115,
      [draft({ header: "New 2" }), draft({ header: "Listed", factId: listed, content: "Changed." })],
      "q1",
    );
    // A new fact and a correction of an unlisted fact: a miss.
    writing(s, 120, [draft({ header: "New 3" }), draft({ header: "Other", factId: other, content: "Changed." })], "q1");
    expect(searchMisses(s, ALL)).toEqual({ afterSearch: 3, missed: 1 });
  });

  it("leaves a request that names no search out of both counts, and applies only the lower bound", () => {
    const s = makeStore();
    const [unlisted = ""] = writing(s, 5, [draft({ header: "Unlisted" })]);
    duplicateOf(s, request(s, T0 + 10), unlisted, 11); // names no search
    search(s, "q1", null, T0 + 100, []);
    duplicateOf(s, request(s, T0 + 110, "q1"), unlisted, 111);
    expect(searchMisses(s, ALL)).toEqual({ afterSearch: 1, missed: 1 });
    const bounds: SpanBounds = { searches: 1, fromAt: T0 + 105, toAt: T0 + 105 };
    expect(searchMisses(s, bounds)).toEqual({ afterSearch: 1, missed: 1 });
    expect(searchMisses(s, { searches: 1, fromAt: T0 + 111, toAt: T0 + 111 })).toEqual({
      afterSearch: 0,
      missed: 0,
    });
  });

  it("links a request to the search it names, not to another search of the same session", () => {
    const s = makeStore();
    openSession(s, { id: "s1", startedAt: T0 });
    const [listed = ""] = writing(s, 5, [draft({ header: "Listed" })]);
    search(s, "q1", "s1", T0 + 100, [[SearchHitKind.Fact, listed]]);
    search(s, "q2", "s1", T0 + 105, []); // the later search of the session, which did not list the fact
    duplicateOf(s, request(s, T0 + 110, "q1"), listed, 111);
    expect(searchMisses(s, ALL)).toEqual({ afterSearch: 1, missed: 0 });
  });

  it("gives a child of a split the search of its parent", () => {
    const s = makeStore();
    search(s, "q1", null, T0 + 100, []);
    const parent = request(s, T0 + 110, "q1");
    applyChangeSync(
      s,
      parent,
      { outcome: ChangeOutcome.Split, summary: "s", changeReasoning: "r", facts: [], claims: ["a", "b"] },
      { now: T0 + 111 },
    );
    expect(s.db.prepare("SELECT search_id FROM change_requests WHERE parent_id = ?").all(parent)).toEqual([
      { search_id: "q1" },
      { search_id: "q1" },
    ]);
  });
});

describe("tokenCost", () => {
  function fixture(): Store {
    const s = makeStore();
    const accepted = request(s, T0 + 10);
    outcome(s, accepted, ChangeOutcome.Accepted, true, T0 + 11);
    calls(s, accepted, 10, 1);
    const duplicate = request(s, T0 + 20);
    outcome(s, duplicate, ChangeOutcome.Duplicate);
    calls(s, duplicate, 5);
    const split = request(s, T0 + 30);
    outcome(s, split, ChangeOutcome.Split);
    calls(s, split, 100);
    const child = enqueueRequest(s, { change: "c", justification: "j", parentId: split }, T0 + 31);
    finishRequest(s, child, T0 + 32);
    outcome(s, child, ChangeOutcome.Rejected);
    calls(s, child, 7);
    // queued, an operator edit and a lookup repair are not ended change requests
    enqueueRequest(s, { change: "c", justification: "j" }, T0 + 40);
    enqueueOperatorEdit(s, { edit: OperatorEditKind.Reindex, note: "n" }, T0 + 41);
    return s;
  }

  it("sums the cost of the change requests, counts the writes and the wasted cost", () => {
    // the split request's own calls (100) are in the sum and are wasted, its child wrote nothing;
    // the fake input price is 1 cent per token, a cache write costs twice that
    const cost = tokenCost(fixture(), ALL, FAKE_PRICES);
    expect(cost).toMatchObject({
      writes: 1,
      tokens: 10 + 1 + 5 + 100 + 7,
      wastedTokens: 5 + 100 + 7,
      unpricedCalls: 0,
    });
    expect(cost.usd).toBeCloseTo(1.24, 10);
    expect(cost.wastedUsd).toBeCloseTo(1.12, 10);
  });

  it("counts the calls under a split, and wastes them only when no child wrote a fact version", () => {
    const s = makeStore();
    const split = (at: number, tokensIn: number, childWrites: boolean): void => {
      const parent = request(s, at);
      outcome(s, parent, ChangeOutcome.Split);
      calls(s, parent, tokensIn);
      for (const writes of [childWrites, false]) {
        const child = enqueueRequest(s, { change: "c", justification: "j", parentId: parent }, at + 2);
        finishRequest(s, child, at + 3);
        if (writes) outcome(s, child, ChangeOutcome.Accepted, true, at + 4);
        else outcome(s, child, ChangeOutcome.Rejected);
      }
    };
    split(T0 + 10, 30, true);
    split(T0 + 50, 20, false);
    const cost = tokenCost(s, ALL, FAKE_PRICES);
    // a split is not a write; its 1 writing child is
    expect(cost.writes).toBe(1);
    expect(cost.usd).toBeCloseTo(0.5, 10);
    expect(cost.wastedUsd).toBeCloseTo(0.2, 10);
  });

  it("prices the input, the cache reads and the output of a model apart, and counts a call of an unlisted model at 0", () => {
    const s = makeStore();
    const id = request(s, T0 + 10);
    outcome(s, id, ChangeOutcome.Accepted, true, T0 + 11);
    const call = (model: string, usage: Partial<ModelCallInput>): void => {
      recordModelCall(s, {
        requestId: id,
        question: "Q1",
        model,
        effort: "low",
        tokensIn: 0,
        tokensOut: 0,
        tokensCacheRead: 0,
        tokensCacheWrite: 0,
        durationMs: 1,
        at: T0,
        ...usage,
      });
    };
    call(PRICED_MODEL, { tokensIn: 100, tokensOut: 10, tokensCacheRead: 200, tokensCacheWrite: 50 });
    call("unlisted", { tokensIn: 1000 });
    call("unlisted", { tokensOut: 1000 });
    // 100 input at 1 cent, 50 cache write at twice that, 200 cache read at half of it, 10 output at 2 cents
    const cost = tokenCost(s, ALL, FAKE_PRICES);
    expect(cost.usd).toBeCloseTo(1 + (50 * 10_000 * FAKE_PRICES.cacheWriteFactor) / 1e6 + 1 + 0.2, 10);
    expect(cost.wastedUsd).toBe(0);
    expect(cost.unpricedCalls).toBe(2);
  });

  it("is zero for a wiki with no request", () => {
    const s = makeStore();
    expect(searchMisses(s, ALL)).toEqual({ afterSearch: 0, missed: 0 });
    expect(tokenCost(s, ALL, FAKE_PRICES)).toEqual({
      writes: 0,
      usd: 0,
      wastedUsd: 0,
      tokens: 0,
      wastedTokens: 0,
      unpricedCalls: 0,
    });
  });
});

describe("jobRows", () => {
  it("lists a row per finder, with the interval, the writes since the last run and the cap", () => {
    const s = makeStore();
    // 3 writes, then a split, a duplicate and a rejection: only the accepted changes count.
    const kinds = [
      ChangeOutcome.Accepted,
      ChangeOutcome.Accepted,
      ChangeOutcome.Accepted,
      ChangeOutcome.Split,
      ChangeOutcome.Duplicate,
      ChangeOutcome.Rejected,
    ];
    kinds.forEach((kind, i) => {
      const at = i + 1;
      const id = enqueueRequest(s, { change: "c", justification: "j" }, T0 + at);
      outcome(s, id, kind, false, T0 + at * 10);
    });
    writeCleanupSeq(s, { [CleanupFinder.DuplicateFact]: 1 });
    writeCleanupEvery(s, { ...CLEANUP_EVERY, [CleanupFinder.DuplicateFact]: CLEANUP_EVERY_MAX });
    const rows = jobRows(s).cleanup;
    expect(rows.map((r) => r.finder)).toEqual(Object.values(CleanupFinder));
    const duplicate = rows.find((r) => r.finder === CleanupFinder.DuplicateFact);
    expect(duplicate).toMatchObject({
      lastSeq: 1,
      lastRunAt: T0 + 10,
      writesSince: 2,
      interval: CLEANUP_EVERY_MAX,
      capped: false,
      pending: false,
      lastRequest: null,
    });
    writeCleanupFull(s, [CleanupFinder.DuplicateFact]);
    expect(jobRows(s).cleanup.find((r) => r.finder === CleanupFinder.DuplicateFact)).toMatchObject({ capped: true });
  });

  it("gives pending only for a finder in meta.cleanup_pending with a queued or running cleanupRepair request", () => {
    const s = makeStore();
    const pending = (): boolean | undefined =>
      jobRows(s).cleanup.find((r) => r.finder === CleanupFinder.DuplicateFact)?.pending;
    const repair = enqueueCleanupRepair(s, { finder: CleanupFinder.DuplicateFact, factIds: ["f1", "f2"] }, T0);
    // A queued repair alone, with the finder off the list, is not pending.
    expect(pending()).toBe(false);
    writeCleanupPending(s, [CleanupFinder.DuplicateFact]);
    expect(pending()).toBe(true);
    s.db.prepare("UPDATE change_requests SET status = ? WHERE id = ?").run(RequestStatus.Running, repair);
    expect(pending()).toBe(true);
    // On the list with all repairs ended: not pending.
    s.db.prepare("UPDATE change_requests SET status = ? WHERE id = ?").run(RequestStatus.Done, repair);
    expect(pending()).toBe(false);
  });

  it("starts at the highest seq with no run time while meta holds no cleanup seq", () => {
    const s = makeStore();
    const id = enqueueRequest(s, { change: "c", justification: "j" }, T0);
    outcome(s, id, ChangeOutcome.Rejected);
    for (const row of jobRows(s).cleanup) {
      expect(row).toMatchObject({ lastSeq: 1, lastRunAt: null, writesSince: 0 });
    }
  });

  it("gives the newest cleanupRepair request of a finder and the newest reindex, with their outcome", () => {
    const s = makeStore();
    enqueueCleanupRepair(s, { finder: CleanupFinder.DuplicateFact, factIds: ["f1", "f2"] }, T0 + 1);
    const newer = enqueueCleanupRepair(s, { finder: CleanupFinder.DuplicateFact, factIds: ["f3", "f4"] }, T0 + 2);
    outcome(s, newer, ChangeOutcome.Accepted);
    finishRequest(s, newer, T0 + 3);
    enqueueOperatorEdit(s, { edit: OperatorEditKind.Cleanup, note: "n" }, T0 + 4);
    const reindex = enqueueOperatorEdit(s, { edit: OperatorEditKind.Reindex, note: "n" }, T0 + 5);
    const rows = jobRows(s);
    expect(rows.cleanup.find((r) => r.finder === CleanupFinder.DuplicateFact)?.lastRequest).toEqual({
      id: newer,
      receivedAt: T0 + 2,
      status: RequestStatus.Done,
      outcome: ChangeOutcome.Accepted,
    });
    expect(rows.reindex).toEqual({ id: reindex, receivedAt: T0 + 5, status: RequestStatus.Queued, outcome: null });
  });

  it("has no reindex request on a wiki that never reindexed", () => {
    expect(jobRows(makeStore()).reindex).toBeNull();
  });
});
