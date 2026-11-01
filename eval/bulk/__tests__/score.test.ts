import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ChangeOutcome, RejectReason, RequestStatus } from "../../../src/domain/index.js";
import { BULK_END_STATE, BULK_LABELS, MAY_SPLIT_EXTRA_FACTS, type BulkLabel } from "../../../fakes/bulk-expected.js";
import { rescoreResultFile } from "../rescore.js";
import { rescoreRequests, scoreRequests, type ScoreInput } from "../score.js";
import type { DuplicateReport, RequestRecord } from "../types.js";

const START = 100;

interface Built {
  requests: RequestRecord[];
  live: ScoreInput["live"];
  firstSeq: Map<string, number>;
}

function record(id: string, outcome: ChangeOutcome, over: Partial<RequestRecord> = {}): RequestRecord {
  return {
    requestId: id,
    status: RequestStatus.Done,
    outcome,
    attempts: 1,
    factIds: [],
    facts: [],
    children: [],
    ...over,
  };
}

// The records of a path that ends every request as its label says.
function perfect(count = BULK_LABELS.length): Built {
  const live: Built["live"] = [];
  const firstSeq = new Map<string, number>();
  let next = START + 1;
  const write = (id: string, isSeed: boolean): void => {
    firstSeq.set(id, isSeed ? 1 : next);
    live.push({ factId: id, seq: next++ });
  };
  const requests = BULK_LABELS.slice(0, count).map((label: BulkLabel) => {
    const id = `r${label.position}`;
    if (label.outcome === ChangeOutcome.Accepted) {
      const fact = `f${label.position}`;
      write(fact, label.replaces !== undefined);
      return record(id, label.outcome, {
        factIds: [fact],
        facts: [{ header: "h", content: `${label.fact?.content ?? ""} ${label.keeps ?? ""}` }],
      });
    }
    if (label.outcome === ChangeOutcome.Rejected) {
      return record(id, label.outcome, { rejectReason: label.reasons?.[0] ?? RejectReason.Unsupported });
    }
    if (label.outcome === ChangeOutcome.Split) {
      const children = (label.claims ?? []).map((claim, i) => {
        if (claim.outcome === ChangeOutcome.Duplicate) return record(`${id}.${i}`, ChangeOutcome.Duplicate);
        const fact = `c${label.position}.${i}`;
        write(fact, false);
        return record(`${id}.${i}`, ChangeOutcome.Accepted, { factIds: [fact] });
      });
      return record(id, ChangeOutcome.Split, { children });
    }
    return record(id, label.outcome);
  });
  return { requests, live, firstSeq };
}

const score = (b: Built, duplicates?: DuplicateReport, path = "test") =>
  scoreRequests({ ...b, startSeq: START, ...(duplicates ? { duplicates } : {}) }, path);

const NO_PAIRS: DuplicateReport = {
  complete: true,
  checkedFacts: 0,
  candidatePairs: 0,
  pairs: [],
  judge: { calls: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
};

const check = (s: ReturnType<typeof score>, name: string) => s.endState.find((c) => c.name === name);

// The expectations, from the labels and not from literals.
const MAX_EXTRA = Object.values(MAY_SPLIT_EXTRA_FACTS).reduce((sum, n) => sum + n, 0);
const NEW_RANGE = `${BULK_END_STATE.newFacts} to ${BULK_END_STATE.newFacts + MAX_EXTRA}`;
const ENDS = BULK_LABELS.length + BULK_LABELS.reduce((sum, l) => sum + (l.claims?.length ?? 0), 0);
// A split label whose claims are all clear, with at least 2 of them.
const clearSplitAt = (): number =>
  BULK_LABELS.findIndex(
    (l) =>
      l.outcome === ChangeOutcome.Split &&
      (l.claims ?? []).length >= 2 &&
      l.claims?.every((c) => c.unclear === undefined),
  );

describe("the score of a path against the labels", () => {
  it("gives no wrong end and a clean end state to a path that ends as the labels say", () => {
    const s = score(perfect(), NO_PAIRS);
    expect(s.wrong).toBe(0);
    expect(s.unclear.wrong).toBe(0);
    expect(s.endState.filter((c) => !c.ok)).toEqual([]);
    expect(check(s, "new facts")).toMatchObject({ expected: NEW_RANGE, actual: String(BULK_END_STATE.newFacts) });
    expect(check(s, "corrected seed facts")).toMatchObject({
      expected: String(BULK_END_STATE.correctedSeedFacts),
      actual: String(BULK_END_STATE.correctedSeedFacts),
    });
    // Every request and every claim of a split, the unclear labels apart.
    expect(s.right + s.unclear.right).toBe(ENDS);
    expect(s.line).toContain("0 wrong");
    expect(s.line).toContain("end state ok");
  });

  it("counts a wrong end, names its position and fails the new facts check at that position", () => {
    const b = perfect();
    const at = BULK_LABELS.findIndex(
      (l) => l.outcome === ChangeOutcome.Accepted && l.unclear === undefined && l.replaces === undefined,
    );
    b.requests[at] = record(`r${at}`, ChangeOutcome.Rejected, { rejectReason: RejectReason.Unsupported });
    const s = score(b, NO_PAIRS);
    expect(s.wrong).toBe(1);
    expect(s.ends.find((e) => !e.right)).toMatchObject({ position: at, end: "rejected unsupported" });
    expect(check(s, "new facts")).toMatchObject({ ok: false, positions: [at] });
    expect(s.line).toContain(`at ${at}`);
  });

  it("scores an unclear label apart and never as wrong", () => {
    const b = perfect();
    const at = BULK_LABELS.findIndex((l) => l.unclear !== undefined && l.outcome === ChangeOutcome.Accepted);
    b.requests[at] = record(`r${at}`, ChangeOutcome.Rejected, { rejectReason: RejectReason.Contradicted });
    const s = score(b, NO_PAIRS);
    expect(s.wrong).toBe(0);
    expect(s.unclear.wrong).toBe(1);
  });

  it("takes any count of new facts in the range when an unclear submission is split", () => {
    const b = perfect();
    const [at] = Object.keys(MAY_SPLIT_EXTRA_FACTS).map(Number);
    if (at === undefined) throw new Error("no unclear position");
    // One extra fact is inside the range of the position, and it is at most what the labels allow there.
    expect(MAY_SPLIT_EXTRA_FACTS[at]).toBeGreaterThanOrEqual(1);
    const extra = "extra-fact";
    b.live.push({ factId: extra, seq: START + 500 });
    b.firstSeq.set(extra, START + 500);
    const r = b.requests[at];
    if (!r) throw new Error("no record");
    r.factIds = [...r.factIds, extra];
    const s = score(b, NO_PAIRS);
    expect(check(s, "new facts")).toMatchObject({ ok: true, actual: String(BULK_END_STATE.newFacts + 1) });
  });

  it("fails the new facts check at a position that wrote a fact no label expects", () => {
    const b = perfect();
    const at = BULK_LABELS.findIndex((l) => l.outcome === ChangeOutcome.Duplicate);
    b.live.push({ factId: "stray", seq: START + 900 });
    b.firstSeq.set("stray", START + 900);
    const r = b.requests[at];
    if (!r) throw new Error("no record");
    r.factIds = ["stray"];
    expect(check(score(b, NO_PAIRS), "new facts")).toMatchObject({ ok: false, positions: [at] });
  });

  it("does not take an accepted request that wrote a new fact for a correction", () => {
    const b = perfect();
    const at = BULK_LABELS.findIndex((l) => l.replaces !== undefined);
    const r = b.requests[at];
    if (!r) throw new Error("no record");
    b.firstSeq.set(`f${at}`, START + 1);
    const s = score(b, NO_PAIRS);
    expect(s.ends.find((e) => e.position === at)?.right).toBe(false);
    expect(check(s, "corrected seed facts")).toMatchObject({ ok: false, positions: [at] });
  });

  it("finds the false value of a conflict group in a live fact", () => {
    const b = perfect();
    const at = BULK_LABELS.findIndex((l) => l.keeps !== undefined && l.outcome === ChangeOutcome.Accepted);
    const r = b.requests[at];
    if (!r) throw new Error("no record");
    r.facts = [{ header: "h", content: "A check retries every 10 seconds." }];
    expect(check(score(b, NO_PAIRS), "false value in a conflict group")).toMatchObject({ ok: false, positions: [at] });
  });

  it("fails the duplicate check on a pair, and on a judging that did not finish", () => {
    const b = perfect();
    const fact = { header: "h", content: "c" };
    const [p, q] = BULK_LABELS.filter((l) => l.outcome === ChangeOutcome.Accepted && l.replaces === undefined).map(
      (l) => l.position,
    );
    if (p === undefined || q === undefined) throw new Error("no 2 accepted positions");
    const pair = { a: { ...fact, factId: `f${p}` }, b: { ...fact, factId: `f${q}` }, distance: 0.1 };
    const withPair = check(score(b, { ...NO_PAIRS, pairs: [pair] }), "duplicate pairs");
    expect(withPair).toMatchObject({ ok: false, actual: String(BULK_END_STATE.duplicatePairs + 1), positions: [p, q] });
    expect(check(score(b, { ...NO_PAIRS, complete: false }), "duplicate pairs")?.ok).toBe(false);
    expect(check(score(b), "duplicate pairs")).toMatchObject({ ok: false, actual: "not judged" });
  });

  it("finds a compound fact: a compound submission written as one fact", () => {
    const b = perfect();
    const at = BULK_LABELS.findIndex((l) => l.outcome === ChangeOutcome.Split);
    b.live.push({ factId: "compound", seq: START + 800 });
    b.firstSeq.set("compound", START + 800);
    b.requests[at] = record(`r${at}`, ChangeOutcome.Accepted, { factIds: ["compound"] });
    const s = score(b, NO_PAIRS);
    expect(check(s, "compound facts")).toMatchObject({
      ok: false,
      actual: String(BULK_END_STATE.compoundFacts + 1),
      positions: [at],
    });
    expect(s.ends.find((e) => e.position === at && e.claim === undefined)?.right).toBe(false);
  });

  it("scores a sample of the first positions against the labels of those positions", () => {
    const s = score(perfect(10), NO_PAIRS);
    expect(s.wrong).toBe(0);
    expect(s.endState.filter((c) => !c.ok)).toEqual([]);
    expect(check(s, "new facts")?.expected).not.toBe(NEW_RANGE);
  });

  it("scores a missing child as a wrong end at the place of its claim", () => {
    const b = perfect();
    const at = clearSplitAt();
    const claims = BULK_LABELS[at]?.claims?.length ?? 0;
    const r = b.requests[at];
    if (!r) throw new Error("no record");
    r.children = r.children.slice(0, claims - 1);
    const s = score(b, NO_PAIRS);
    expect(s.ends.filter((e) => e.position === at && e.claim === claims)).toMatchObject([
      { end: "none", right: false },
    ]);
    expect(s.wrong).toBe(1);
  });

  it("scores a surplus child (a split that gives more children than the labels have claims) as a wrong end", () => {
    const b = perfect();
    const at = clearSplitAt();
    const claims = BULK_LABELS[at]?.claims?.length ?? 0;
    const r = b.requests[at];
    if (!r) throw new Error("no record");
    r.children = [...r.children, record("surplus", ChangeOutcome.Duplicate)];
    const s = score(b, NO_PAIRS);
    // The surplus child is the end after the last claim; no label accepts any end for it.
    expect(s.ends.filter((e) => e.position === at && e.claim === claims + 1)).toMatchObject([
      { end: ChangeOutcome.Duplicate, accepted: [], right: false, unclear: false },
    ]);
    expect(s.wrong).toBe(1);
    expect(s.line).toContain(`${at}.${claims + 1}`);
    // The labeled ends are untouched.
    expect(s.right).toBe(score(perfect(), NO_PAIRS).right);
  });
});

// A split whose claim is labelled "duplicate of position q", with q accepted as a new fact and both labels clear.
function equalPair(): { parent: number; child: number; target: number } {
  for (const l of BULK_LABELS) {
    for (const [child, claim] of (l.claims ?? []).entries()) {
      const target =
        claim.duplicateOf !== undefined && "position" in claim.duplicateOf ? claim.duplicateOf.position : -1;
      const q = BULK_LABELS[target];
      if (q?.outcome === ChangeOutcome.Accepted && q.replaces === undefined && q.unclear === undefined) {
        if (claim.unclear === undefined && l.unclear === undefined) return { parent: l.position, child, target };
      }
    }
  }
  throw new Error("no equal pair in the labels");
}

// The ends of the pair in a score: the child and the request q.
function pairEnds(s: ReturnType<typeof score>, p: ReturnType<typeof equalPair>) {
  return {
    child: s.ends.find((e) => e.position === p.parent && e.claim === p.child + 1),
    request: s.ends.find((e) => e.position === p.target && e.claim === undefined),
  };
}

// The pair run in the other order: the child writes the fact and the request q duplicates it.
function flip(b: Built, p: ReturnType<typeof equalPair>, parts: { child: boolean; request: boolean }): void {
  const parent = b.requests[p.parent];
  const request = b.requests[p.target];
  if (!parent || !request) throw new Error("no record");
  if (parts.child) parent.children[p.child] = record("flipped-child", ChangeOutcome.Accepted, { factIds: ["flip"] });
  if (parts.request) b.requests[p.target] = record(request.requestId, ChangeOutcome.Duplicate, { duplicateOf: "flip" });
}

describe("an equal pair in either order", () => {
  it("takes the labelled order as right: the duplicate ends as a duplicate and the request q as a new fact", () => {
    const p = equalPair();
    const e = pairEnds(score(perfect(), NO_PAIRS), p);
    expect(e.child).toMatchObject({ end: ChangeOutcome.Duplicate, right: true });
    expect(e.request).toMatchObject({ end: ChangeOutcome.Accepted, right: true });
  });

  it("takes the other order as right: the labelled duplicate ends as a new fact, the request q as a duplicate of its fact", () => {
    const p = equalPair();
    const b = perfect();
    flip(b, p, { child: true, request: true });
    const e = pairEnds(score(b, NO_PAIRS), p);
    expect(e.child).toMatchObject({ end: ChangeOutcome.Accepted, right: true });
    expect(e.request).toMatchObject({ end: ChangeOutcome.Duplicate, right: true });
  });

  it("keeps a half-inverted pair wrong: only the duplicate end flipped", () => {
    const p = equalPair();
    const b = perfect();
    flip(b, p, { child: true, request: false });
    const e = pairEnds(score(b, NO_PAIRS), p);
    expect(e.child).toMatchObject({ right: false });
    // The request q still ends as the label says.
    expect(e.request).toMatchObject({ right: true });
  });

  it("keeps a half-inverted pair wrong: only the request q flipped, or flipped to a fact of another request", () => {
    const p = equalPair();
    const only = perfect();
    flip(only, p, { child: false, request: true });
    expect(pairEnds(score(only, NO_PAIRS), p)).toMatchObject({ child: { right: true }, request: { right: false } });
    // The child wrote a fact, but the request q duplicates another fact: neither side is right.
    const other = perfect();
    flip(other, p, { child: true, request: true });
    const q = other.requests[p.target];
    if (!q) throw new Error("no record");
    q.duplicateOf = "another";
    expect(pairEnds(score(other, NO_PAIRS), p)).toMatchObject({ child: { right: false }, request: { right: false } });
  });
});

describe("a new score of a result file", () => {
  it("scores the request ends again, keeps the checks of the end state and the other keys, and rebuilds the line", () => {
    const p = equalPair();
    const b = perfect();
    flip(b, p, { child: true, request: true });
    // The earlier score: the pair of the other order is wrong, and the end state holds a failed check from the copy.
    const earlier = score(b, NO_PAIRS, "batch");
    for (const e of Object.values(pairEnds(earlier, p))) if (e) e.right = false;
    earlier.endState = [{ name: "from the copy", expected: "1", actual: "2", ok: false, positions: [3] }];
    const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const file = {
      startedAt: "t",
      complete: true,
      source: "s",
      requests: b.requests.length,
      queuedInSource: 100,
      startSeq: START,
      batchSize: 10,
      concurrency: 4,
      stub: true,
      note: "a key that the schema does not know",
      batch: {
        path: "batch",
        complete: true,
        startedAtMs: 0,
        wallMs: 0,
        snapshotMs: 0,
        usage: { calls: 0, tokens: zero, usd: 0, unpricedCalls: 0, callsByQuestion: {} },
        outcomes: {},
        steps: 0,
        batches: [],
        attemptErrors: [],
        requests: b.requests,
        score: earlier,
      },
    };
    const path = join(mkdtempSync(join(tmpdir(), "wikifact-rescore-")), "result.json");
    writeFileSync(path, JSON.stringify(file));
    const lines = rescoreResultFile(path);
    const written = JSON.parse(readFileSync(path, "utf8")) as { note: string; batch: { score: typeof earlier } };
    const after = written.batch.score;
    expect(written.note).toBe(file.note);
    expect(lines).toEqual([after.line]);
    expect(after.wrong).toBe(0);
    expect(pairEnds(after, p)).toMatchObject({ child: { right: true }, request: { right: true } });
    expect(after.endState).toEqual(earlier.endState);
    expect(after.line).toContain("from the copy");
  });
});

describe("the labels that a path may split", () => {
  it("MAY_SPLIT_EXTRA_FACTS names only positions whose label is unclear and accepted", () => {
    for (const key of Object.keys(MAY_SPLIT_EXTRA_FACTS)) {
      const label = BULK_LABELS[Number(key)];
      expect(label?.outcome).toBe(ChangeOutcome.Accepted);
      expect(label?.unclear).toBeDefined();
    }
  });
});

describe("how a new score decides a correction for a top-level request", () => {
  const accepted = (l: BulkLabel): boolean => l.outcome === ChangeOutcome.Accepted && l.unclear === undefined;
  const correctionAt = BULK_LABELS.findIndex((l) => accepted(l) && l.replaces !== undefined);
  const newFactAt = BULK_LABELS.findIndex((l) => accepted(l) && l.replaces === undefined && l.claims === undefined);
  // A label that accepts neither a correction nor a new fact, in an equal pair with a request q that is accepted as new.
  const neither = BULK_LABELS.find((l) => {
    const q = BULK_LABELS[l.duplicateOf !== undefined && "position" in l.duplicateOf ? l.duplicateOf.position : -1];
    return l.outcome === ChangeOutcome.Duplicate && l.unclear === undefined && q !== undefined && accepted(q);
  });
  const endAt = (s: ReturnType<typeof score>, position: number) =>
    s.ends.find((e) => e.position === position && e.claim === undefined);
  const noField = (s: ReturnType<typeof score>): void => {
    for (const e of s.ends) delete e.correction;
  };

  it("reads the field of the earlier end when it is present, over what the label and the verdict would say", () => {
    const b = perfect();
    const earlier = score(b, NO_PAIRS);
    const c = endAt(earlier, correctionAt);
    const n = endAt(earlier, newFactAt);
    if (!c || !n) throw new Error("no end");
    // A reading from the verdict would take the first as a new fact and the second as a correction: both wrong.
    Object.assign(c, { correction: true, right: false });
    Object.assign(n, { correction: false, right: false });
    const after = rescoreRequests(b.requests, earlier, "test");
    expect(endAt(after, correctionAt)).toMatchObject({ right: true, correction: true });
    expect(endAt(after, newFactAt)).toMatchObject({ right: true, correction: false });
  });

  it("reads an old file with a right correction as a correction", () => {
    const b = perfect();
    const earlier = score(b, NO_PAIRS);
    noField(earlier);
    const after = rescoreRequests(b.requests, earlier, "test");
    expect(endAt(after, correctionAt)).toMatchObject({ right: true, correction: true });
    expect(after.wrong).toBe(0);
  });

  it("reads an old file with a wrong new-fact end as a correction, so the end stays wrong", () => {
    const b = perfect();
    const earlier = score(b, NO_PAIRS);
    noField(earlier);
    const n = endAt(earlier, newFactAt);
    if (!n) throw new Error("no end");
    n.right = false;
    const after = rescoreRequests(b.requests, earlier, "test");
    expect(endAt(after, newFactAt)).toMatchObject({ right: false, correction: true });
  });

  it("keeps the earlier verdict of the end and of its pair for an old file with a label of neither kind", () => {
    if (!neither?.duplicateOf || !("position" in neither.duplicateOf)) throw new Error("no label");
    const q = neither.duplicateOf.position;
    const b = perfect();
    const before = b.requests[neither.position];
    if (!before) throw new Error("no record");
    // The request ends as accepted, which no label of its kind accepts: the scorer alone would call it wrong.
    b.requests[neither.position] = record(before.requestId, ChangeOutcome.Accepted, { factIds: ["x"] });
    const earlier = score(perfect(), NO_PAIRS);
    noField(earlier);
    const end = endAt(earlier, neither.position);
    const pair = endAt(earlier, q);
    if (!end || !pair) throw new Error("no end");
    // The opposite of what the scorer says for both.
    end.right = true;
    pair.right = false;
    const after = rescoreRequests(b.requests, earlier, "test");
    expect(endAt(after, neither.position)).toMatchObject({ right: true });
    expect(endAt(after, neither.position)?.correction).toBeUndefined();
    expect(endAt(after, q)?.right).toBe(false);
    // An end outside the pair is scored again.
    expect(endAt(after, correctionAt)?.right).toBe(true);
  });

  it("keeps the same verdicts when the output of a rescore is rescored again", () => {
    if (!neither?.duplicateOf || !("position" in neither.duplicateOf)) throw new Error("no label");
    const q = neither.duplicateOf.position;
    const b = perfect();
    const before = b.requests[neither.position];
    if (!before) throw new Error("no record");
    b.requests[neither.position] = record(before.requestId, ChangeOutcome.Accepted, { factIds: ["x"] });
    const earlier = score(perfect(), NO_PAIRS);
    noField(earlier);
    const end = endAt(earlier, neither.position);
    const pair = endAt(earlier, q);
    if (!end || !pair) throw new Error("no end");
    end.right = true;
    pair.right = false;
    const first = rescoreRequests(b.requests, earlier, "test");
    const second = rescoreRequests(b.requests, first, "test");
    expect(second.ends).toEqual(first.ends);
    expect(endAt(second, neither.position)?.right).toBe(true);
    expect(endAt(second, q)?.right).toBe(false);
  });
});
