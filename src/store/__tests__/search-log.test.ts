import { describe, expect, it } from "vitest";
import { RetrievalKind, SearchHitKind } from "../../domain/enums.js";
import { T0, draft, factIdOf, makeStore, write, accepted } from "../../../__tests__/helpers/store.js";
import {
  endOpenSessions,
  endSession,
  enqueueRequest,
  getSearchQuery,
  openSession,
  recordModelCall,
  recordRetrieval,
  recordSearch,
  resolveRef,
  touchSession,
  type Store,
} from "../index.js";

interface SessionRow {
  started_at: number;
  last_call_at: number;
  ended_at: number | null;
  client_name: string | null;
  client_version: string | null;
  call_count: number;
}
const sessionRow = (s: Store, id: string): SessionRow | undefined =>
  s.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;

describe("the sessions", () => {
  it("opens a session with its client, counts its calls and closes it once", () => {
    const s = makeStore();
    openSession(s, { id: "s1", startedAt: T0, clientName: "claude-code", clientVersion: "2.0" });
    expect(sessionRow(s, "s1")).toMatchObject({
      started_at: T0,
      last_call_at: T0,
      ended_at: null,
      client_name: "claude-code",
      client_version: "2.0",
      call_count: 0,
    });
    touchSession(s, "s1", T0 + 5);
    touchSession(s, "s1", T0 + 9);
    expect(sessionRow(s, "s1")).toMatchObject({ last_call_at: T0 + 9, call_count: 2 });
    endSession(s, "s1", T0 + 20);
    endSession(s, "s1", T0 + 30);
    expect(sessionRow(s, "s1")?.ended_at).toBe(T0 + 20);
  });

  it("stores NULL for a client that sends no name or version", () => {
    const s = makeStore();
    openSession(s, { id: "s1", startedAt: T0 });
    expect(sessionRow(s, "s1")).toMatchObject({ client_name: null, client_version: null });
  });

  it("closes every open session at its last call and leaves a closed one alone", () => {
    const s = makeStore();
    openSession(s, { id: "open", startedAt: T0 });
    touchSession(s, "open", T0 + 7);
    openSession(s, { id: "closed", startedAt: T0 });
    endSession(s, "closed", T0 + 3);
    expect(endOpenSessions(s, T0 + 1000)).toBe(1);
    expect(sessionRow(s, "open")?.ended_at).toBe(T0 + 7);
    expect(sessionRow(s, "closed")?.ended_at).toBe(T0 + 3);
  });
});

describe("recordSearch", () => {
  it("writes the search row and one row per result, best first", () => {
    const s = makeStore();
    openSession(s, { id: "s1", startedAt: T0 });
    recordSearch(s, {
      id: "q1",
      sessionId: "s1",
      query: "creeper",
      at: T0 + 1,
      durationMs: 12,
      results: [
        { kind: SearchHitKind.Fact, targetId: "f1", rank: 1, ref: "r1" },
        { kind: SearchHitKind.Fact, targetId: "f2", rank: 2, ref: "r2" },
      ],
    });
    expect(s.db.prepare("SELECT * FROM searches").all()).toEqual([
      { id: "q1", session_id: "s1", query: "creeper", at: T0 + 1, duration_ms: 12, result_count: 2 },
    ]);
    expect(s.db.prepare("SELECT kind, target_id, rank, ref FROM search_results ORDER BY rank").all()).toEqual([
      { kind: SearchHitKind.Fact, target_id: "f1", rank: 1, ref: "r1" },
      { kind: SearchHitKind.Fact, target_id: "f2", rank: 2, ref: "r2" },
    ]);
  });

  it("writes a search with no session and no result as a row with a count of 0", () => {
    const s = makeStore();
    recordSearch(s, { id: "q1", sessionId: null, query: "x", at: T0, durationMs: 1, results: [] });
    expect(s.db.prepare("SELECT session_id, result_count FROM searches").all()).toEqual([
      { session_id: null, result_count: 0 },
    ]);
    expect(s.db.prepare("SELECT COUNT(*) AS n FROM search_results").get()).toEqual({ n: 0 });
  });

  it("writes nothing when a result fails, because the rows share one transaction", () => {
    const s = makeStore();
    expect(() =>
      recordSearch(s, {
        id: "q1",
        sessionId: null,
        query: "x",
        at: T0,
        durationMs: 1,
        results: [
          { kind: SearchHitKind.Fact, targetId: "f1", rank: 1, ref: "r1" },
          { kind: SearchHitKind.Fact, targetId: "f1", rank: 2, ref: "r2" },
        ],
      }),
    ).toThrow();
    expect(s.db.prepare("SELECT COUNT(*) AS n FROM searches").get()).toEqual({ n: 0 });
  });
});

describe("the ref of a result", () => {
  it("is unique over the wiki, and resolves to its search, kind and target", () => {
    const s = makeStore();
    recordSearch(s, {
      id: "q1",
      sessionId: null,
      query: "x",
      at: T0,
      durationMs: 1,
      results: [{ kind: SearchHitKind.Fact, targetId: "f1", rank: 1, ref: "r1" }],
    });
    expect(resolveRef(s, "r1")).toEqual({ searchId: "q1", kind: SearchHitKind.Fact, targetId: "f1" });
    expect(resolveRef(s, "nope")).toBeUndefined();
    expect(() =>
      recordSearch(s, {
        id: "q2",
        sessionId: null,
        query: "y",
        at: T0,
        durationMs: 1,
        results: [{ kind: SearchHitKind.Fact, targetId: "f2", rank: 1, ref: "r1" }],
      }),
    ).toThrow();
    expect(getSearchQuery(s, "q1")).toBe("x");
    expect(getSearchQuery(s, "q2")).toBeUndefined();
  });
});

describe("the ref of a read", () => {
  it("stores the ref of a fact read, and NULL when none is given", () => {
    const s = makeStore();
    write(s, accepted([draft()]), T0);
    const factId = factIdOf(s);
    recordSearch(s, {
      id: "q1",
      sessionId: null,
      query: "x",
      at: T0,
      durationMs: 1,
      results: [{ kind: SearchHitKind.Fact, targetId: factId, rank: 1, ref: "rf" }],
    });
    recordRetrieval(s, factId, { now: T0 + 1, ref: "rf" });
    recordRetrieval(s, factId, { now: T0 + 2 });
    recordRetrieval(s, factId, { now: T0 + 3, kind: RetrievalKind.Confirm });
    expect(s.db.prepare("SELECT ref FROM retrievals ORDER BY at").all()).toEqual([
      { ref: "rf" },
      { ref: null },
      { ref: null },
    ]);
  });

  it("refuses a ref that no search minted", () => {
    const s = makeStore();
    write(s, accepted([draft()]), T0);
    expect(() => recordRetrieval(s, factIdOf(s), { now: T0 + 1, ref: "nope" })).toThrow();
  });
});

describe("recordModelCall", () => {
  it("writes the row with the 4 token counts and refuses an unknown request", () => {
    const s = makeStore();
    const requestId = enqueueRequest(s, { change: "c", justification: "j" }, T0);
    const id = recordModelCall(s, {
      requestId,
      question: "Q4",
      model: "m",
      effort: "low",
      tokensIn: 1,
      tokensOut: 2,
      tokensCacheRead: 3,
      tokensCacheWrite: 4,
      durationMs: 50,
      at: T0 + 1,
    });
    expect(s.db.prepare("SELECT * FROM model_calls").all()).toEqual([
      {
        id,
        request_id: requestId,
        question: "Q4",
        model: "m",
        effort: "low",
        tokens_in: 1,
        tokens_out: 2,
        tokens_cache_read: 3,
        tokens_cache_write: 4,
        duration_ms: 50,
        at: T0 + 1,
      },
    ]);
    expect(() =>
      recordModelCall(s, {
        requestId: "missing",
        question: "Q4",
        model: "m",
        effort: "low",
        tokensIn: 0,
        tokensOut: 0,
        tokensCacheRead: 0,
        tokensCacheWrite: 0,
        durationMs: 0,
        at: T0,
      }),
    ).toThrow();
  });
});
