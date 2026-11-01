import { describe, expect, it } from "vitest";
import { wilsonInterval } from "../../lib/stats.js";
import { casePassRate, caseRunAccuracy, halvesAccuracy, scoreOf, type Graded } from "../accuracy.js";

const ok: Graded = { pass: true };
const bad: Graded = { pass: false };

describe("the accuracy of a configuration", () => {
  it("counts the share of cases that passed in each run", () => {
    const grid = [
      [ok, bad],
      [bad, bad],
    ];
    expect(caseRunAccuracy(grid, 2)).toEqual([0.5, 0]);
  });

  it("gives the share of runs in which each case passed, by id", () => {
    const grid = [
      [ok, bad],
      [bad, bad],
    ];
    expect(casePassRate(grid, ["a", "b"], 2)).toEqual({ a: 0.5, b: 0 });
  });

  it("counts a call that has not happened as failed, and ignores a run past the count", () => {
    const grid: Graded[][] = [[ok, ok], []];
    expect(casePassRate(grid, ["a", "b"], 1)).toEqual({ a: 1, b: 0 });
  });

  it("scores the held-out half and the tuning half apart, and gives none for a set with no held-out case", () => {
    const grid: Graded[][] = [
      [ok, bad],
      [bad, bad],
      [ok, ok],
    ];
    expect(halvesAccuracy(grid, [true, false, true], 2)).toEqual({
      heldOut: { cases: 2, mean: 0.75, ci: wilsonInterval(3, 4) },
      tuning: { cases: 1, mean: 0, ci: wilsonInterval(0, 2) },
    });
    expect(halvesAccuracy(grid, [false, false, false], 2)).toBeUndefined();
  });

  it("scores some cases with a Wilson interval over all their answers", () => {
    const grid: Graded[][] = [
      [ok, bad, ok],
      [ok, ok, ok],
    ];
    expect(scoreOf(grid, 3)).toEqual({ cases: 2, mean: 5 / 6, ci: wilsonInterval(5, 6) });
    expect(scoreOf(grid, 2).ci).toEqual(wilsonInterval(3, 4));
  });

  it("gives a NaN score for no case", () => {
    const score = scoreOf([], 3);
    expect(score.cases).toBe(0);
    expect(score.mean).toBeNaN();
    expect(score.ci[0]).toBeNaN();
  });
});
