import { describe, expect, it } from "vitest";
import { Arm, BenefitGroup, BenefitKind, Complexity, QuestionType, TaskType, Verdict } from "../../lib/enums.js";
import type { ResultRow } from "../rows.js";
import { heldBars, summarize, type Cell } from "../summary.js";

function row(over: Partial<ResultRow> & Pick<ResultRow, "arm">, judge = Verdict.Correct, terms = true): ResultRow {
  return {
    caseId: "c",
    kind: BenefitKind.Question,
    group: BenefitGroup.Held,
    type: QuestionType.Locate,
    complexity: Complexity.Simple,
    run: 1,
    correct: { terms, judge },
    usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
    costUsd: 1,
    turns: 2,
    toolCalls: [],
    wallMs: 1,
    ...over,
  };
}

const cell = (cells: Cell[], key: string): Cell | undefined => cells.find((c) => c.key === key);

describe("summarize", () => {
  const rows: ResultRow[] = [
    // questions, held, locate, simple: with is 2 of 2 right at 1 dollar; without is 1 of 2 right at 2 dollars
    row({ arm: Arm.With }),
    row({ arm: Arm.With, run: 2 }),
    row({ arm: Arm.Without, costUsd: 2 }),
    row({ arm: Arm.Without, costUsd: 2, run: 2 }, Verdict.Wrong, false),
    // a gap question, complex, explain: with is wrong, without is right
    row(
      { arm: Arm.With, group: BenefitGroup.Gap, type: QuestionType.Explain, complexity: Complexity.Complex },
      Verdict.Wrong,
    ),
    row({ arm: Arm.Without, group: BenefitGroup.Gap, type: QuestionType.Explain, complexity: Complexity.Complex }),
    // a held task: done in both arms, judged correct with and partial without
    row({
      arm: Arm.With,
      kind: BenefitKind.Task,
      taskType: TaskType.Bugfix,
      type: undefined,
      complexity: undefined,
      correct: { tests: true, judge: Verdict.Correct },
      toolCalls: [{ tool: "mcp__wikifact__search" }, { tool: "Read" }, { tool: "Read" }],
    }),
    row({
      arm: Arm.Without,
      kind: BenefitKind.Task,
      taskType: TaskType.Bugfix,
      type: undefined,
      complexity: undefined,
      correct: { tests: true, judge: Verdict.Partial },
      costUsd: 3,
    }),
  ];
  const summary = summarize(rows);

  it("gives the share right of each arm for a kind", () => {
    const q = cell(summary.byKind, BenefitKind.Question);
    expect(q?.with?.right).toBeCloseTo(2 / 3);
    expect(q?.without?.right).toBeCloseTo(2 / 3);
    expect(q?.with?.terms).toBeCloseTo(1);
    expect(q?.without?.terms).toBeCloseTo(2 / 3);
    expect(q?.with?.judged).toBeCloseTo(2 / 3);
    const t = cell(summary.byKind, BenefitKind.Task);
    expect(t?.with?.done).toBe(1);
    expect(t?.with?.right).toBe(1);
    expect(t?.without?.done).toBe(1);
    expect(t?.without?.right).toBe(0);
  });

  it("gives the mean and the range of the dollars, and the change of with against without in percent", () => {
    const held = cell(summary.byKindAndGroup, `${BenefitKind.Question}/${BenefitGroup.Held}`);
    expect(held?.with?.costUsd).toEqual({ mean: 1, min: 1, max: 1 });
    expect(held?.without?.costUsd).toEqual({ mean: 2, min: 2, max: 2 });
    expect(held?.deltaPct?.costUsd).toBeCloseTo(-50);
    expect(held?.deltaPct?.right).toBeCloseTo(((1 - 0.5) / 0.5) * 100);
  });

  it("splits by group, type, complexity and task type", () => {
    expect(cell(summary.byGroup, BenefitGroup.Gap)?.with?.runs).toBe(1);
    expect(cell(summary.byType, QuestionType.Explain)?.without?.right).toBe(1);
    expect(cell(summary.byType, QuestionType.Explain)?.with?.right).toBe(0);
    expect(cell(summary.byComplexity, Complexity.Complex)?.with?.runs).toBe(1);
    expect(cell(summary.byTaskType, TaskType.Bugfix)?.with?.wikiCalls).toBe(1);
    expect(cell(summary.byTaskType, TaskType.Bugfix)?.with?.fileReads).toBe(2);
    expect(cell(summary.byTaskType, TaskType.Feature)).toBeUndefined();
  });

  it("counts the tokens that the model read as input", () => {
    const withCache = summarize([
      row({ arm: Arm.With, usage: { input: 10, output: 5, cacheRead: 200, cacheWrite: 30 } }),
    ]);
    expect(withCache.overall.with?.inputTokens.mean).toBe(240);
    expect(withCache.overall.with?.outputTokens.mean).toBe(5);
  });

  it("has no change for a cell with one arm, and no change from a zero", () => {
    const one = summarize([row({ arm: Arm.With })]);
    expect(one.overall.deltaPct).toBeUndefined();
    const zero = summarize([row({ arm: Arm.With }), row({ arm: Arm.Without }, Verdict.Wrong, false)]);
    expect(zero.overall.deltaPct?.right).toBeNull();
  });
});

describe("the intervals of a cell", () => {
  it("gives each share right a Wilson interval and each difference a Newcombe and a Welch interval", () => {
    const rows = [
      ...[1, 2, 3, 4].map((run) => row({ arm: Arm.With, run, costUsd: 1 + run / 100 })),
      ...[1, 2, 3, 4].map((run) => row({ arm: Arm.Without, run, costUsd: 2 + run / 100 })),
    ];
    const c = summarize(rows).overall;
    expect(c.with?.ci[0]).toBeLessThan(c.with?.right ?? 0);
    expect(c.with?.ci[1]).toBeCloseTo(1);
    expect(c.diff?.right.value).toBe(0);
    expect(c.diff?.right.counts).toBe(false);
    expect(c.diff?.costUsd.value).toBeCloseTo(-1);
    expect(c.diff?.costUsd.counts).toBe(true);
  });

  it("has no difference for a cell with one arm", () => {
    expect(summarize([row({ arm: Arm.With })]).overall.diff).toBeUndefined();
  });
});

describe("heldBars", () => {
  const runs = (arm: Arm, n: number, over: Partial<ResultRow> = {}, rightEvery = 1): ResultRow[] =>
    Array.from({ length: n }, (_, i) =>
      row(
        { arm, run: i + 1, ...over, costUsd: (over.costUsd ?? 1) + i / 1000 },
        i % rightEvery === 0 ? Verdict.Correct : Verdict.Wrong,
        i % rightEvery === 0,
      ),
    );

  it("is met when the share is not lower by a difference that counts and the dollars are lower by one", () => {
    const bars = heldBars(summarize([...runs(Arm.With, 10), ...runs(Arm.Without, 10, { costUsd: 2 })]));
    const bar = bars.find((b) => b.kind === BenefitKind.Question);
    expect(bar?.met).toBe(true);
    expect(bar?.costDiff?.counts).toBe(true);
  });

  it("is not met when the dollars differ by less than the interval, however the means lie", () => {
    const noisy = (arm: Arm, base: number): ResultRow[] =>
      [0, 4, 0, 4].map((x, i) => row({ arm, run: i + 1, costUsd: base + x }));
    const bars = heldBars(summarize([...noisy(Arm.With, 1), ...noisy(Arm.Without, 1.5)]));
    expect(bars.find((b) => b.kind === BenefitKind.Question)?.met).toBe(false);
  });

  it("is not met when the share is lower by a difference that counts", () => {
    const bars = heldBars(summarize([...runs(Arm.With, 20, {}, 4), ...runs(Arm.Without, 20, { costUsd: 2 })]));
    expect(bars.find((b) => b.kind === BenefitKind.Question)?.met).toBe(false);
  });

  it("judges a task on the share done", () => {
    const task = (arm: Arm, n: number, costUsd: number): ResultRow[] =>
      Array.from({ length: n }, (_, i) =>
        row({
          arm,
          run: i + 1,
          kind: BenefitKind.Task,
          taskType: TaskType.Bugfix,
          correct: { tests: true, judge: Verdict.Correct },
          costUsd: costUsd + i / 1000,
        }),
      );
    const bars = heldBars(summarize([...task(Arm.With, 10, 1), ...task(Arm.Without, 10, 2)]));
    const bar = bars.find((b) => b.kind === BenefitKind.Task);
    expect(bar?.met).toBe(true);
    expect(bar?.shareDiff?.value).toBe(0);
  });

  it("is null when an arm has no run in the group", () => {
    expect(heldBars(summarize([row({ arm: Arm.With })]))[0]?.met).toBeNull();
  });
});
