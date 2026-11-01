import { describe, expect, it } from "vitest";
import { RelevanceQueryForm } from "../../lib/enums.js";
import { loadRelevance, type RelevanceCase } from "../cases.js";
import { NO_ANSWER_SHARE, judgeCase, summarize } from "../run.js";
import { SearchHitKind } from "../../../src/domain/enums.js";
import type { SearchResult } from "../../../src/store/index.js";

const factHit = (header: string): SearchResult => ({ kind: SearchHitKind.Fact, header }) as unknown as SearchResult;

const base = { form: RelevanceQueryForm.Terms, note: "n" } as const;
const factCase: RelevanceCase = { ...base, id: "f", query: "q", expectHeader: "A" };
const noneCase: RelevanceCase = { ...base, id: "n", query: "q", expectNone: true };

describe("judgeCase", () => {
  it("passes a fact case at rank 1 to 3 and fails it at rank 4 or when absent", () => {
    const at = (rank: number) =>
      judgeCase(
        factCase,
        [1, 2, 3, 4].map((i) => factHit(i === rank ? "A" : `x${i}`)),
      );
    expect(at(1)).toMatchObject({ pass: true, rank: 1 });
    expect(at(3)).toMatchObject({ pass: true, rank: 3 });
    expect(at(4)).toMatchObject({ pass: false, rank: 4 });
    expect(judgeCase(factCase, [factHit("x")])).toMatchObject({ pass: false, rank: null });
  });

  it("passes an unanswerable case on an empty list, and on results that are all in allowNear", () => {
    const near: RelevanceCase = { ...noneCase, allowNear: ["x", "y"] };
    expect(judgeCase(noneCase, []).pass).toBe(true);
    expect(judgeCase(near, []).pass).toBe(true);
    expect(judgeCase(near, [factHit("x"), factHit("y")]).pass).toBe(true);
  });

  it("fails an unanswerable case with a result outside allowNear, or with any result when there is no allowNear", () => {
    const near: RelevanceCase = { ...noneCase, allowNear: ["x"] };
    expect(judgeCase(near, [factHit("x"), factHit("y")]).pass).toBe(false);
    expect(judgeCase(noneCase, [factHit("x")]).pass).toBe(false);
  });
});

describe("summarize", () => {
  it("counts each kind of case apart and passes when all hold", () => {
    const report = summarize([judgeCase(factCase, [factHit("A")]), judgeCase(noneCase, [])]);
    expect(report.answerable).toEqual({ total: 1, top3: 1, rank1: 1 });
    expect(report.unanswerable).toEqual({ total: 1, ok: 1, failedIds: [] });
    expect(report.pass).toBe(true);
  });

  it("passes the unanswerable cases at the share bar, fails them under it, and lists the failed ids", () => {
    const total = 10;
    const run = (okCount: number) =>
      summarize(
        Array.from({ length: total }, (_, i) =>
          judgeCase({ ...noneCase, id: `n${i}` }, i < okCount ? [] : [factHit("x")]),
        ),
      );
    const atBar = Math.ceil(NO_ANSWER_SHARE * total);
    expect(run(atBar).pass).toBe(true);
    expect(run(atBar - 1).pass).toBe(false);
    expect(run(atBar).unanswerable.failedIds).toEqual(Array.from({ length: total - atBar }, (_, i) => `n${atBar + i}`));
  });
});

describe("relevance.json", () => {
  it("expects only headers that its seed holds", () => {
    const file = loadRelevance();
    const headers = new Set(file.facts.map((f) => f.header));
    for (const c of file.cases) {
      if (c.expectHeader !== undefined) expect(headers.has(c.expectHeader), c.id).toBe(true);
    }
    expect(headers.size).toBe(file.facts.length);
  });
});
