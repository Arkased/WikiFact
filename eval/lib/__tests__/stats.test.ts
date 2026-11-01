import { describe, expect, it } from "vitest";
import { intervalCounts, mean, newcombeInterval, percentile, welchInterval, wilsonInterval } from "../stats.js";

describe("percentile", () => {
  const sample = [5, 1, 3, 2, 4];
  const ten = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

  it("takes p in 0..1 by the nearest rank, on an unsorted list", () => {
    expect(percentile(sample, 0.5)).toBe(3);
    expect(percentile(sample, 0.95)).toBe(5);
    expect(percentile(ten, 0.5)).toBe(5);
    expect(percentile(ten, 0.95)).toBe(10);
  });

  it("clamps p to the ends of the list", () => {
    expect(percentile(sample, 0)).toBe(1);
    expect(percentile(sample, 1)).toBe(5);
    expect(percentile(sample, 2)).toBe(5);
  });

  it("does not reorder its input", () => {
    const xs = [3, 1, 2];
    percentile(xs, 0.5);
    expect(xs).toEqual([3, 1, 2]);
  });

  it("returns NaN for an empty list", () => {
    expect(percentile([], 0.5)).toBeNaN();
  });
});

describe("wilsonInterval", () => {
  it("gives the known 95% interval of 8 out of 10", () => {
    const [low, high] = wilsonInterval(8, 10);
    expect(low).toBeCloseTo(0.4902, 4);
    expect(high).toBeCloseTo(0.9433, 4);
  });

  it("gives the known interval of 50 out of 100", () => {
    const [low, high] = wilsonInterval(50, 100);
    expect(low).toBeCloseTo(0.4038, 4);
    expect(high).toBeCloseTo(0.5962, 4);
  });

  it("stays inside 0..1 at the ends", () => {
    const [low0, high0] = wilsonInterval(0, 10);
    expect(low0).toBe(0);
    expect(high0).toBeCloseTo(0.2775, 4);
    const [low1, high1] = wilsonInterval(10, 10);
    expect(low1).toBeCloseTo(0.7225, 4);
    expect(high1).toBe(1);
  });

  it("narrows as the answers grow, and returns NaN for none", () => {
    const width = (s: number, n: number): number => wilsonInterval(s, n)[1] - wilsonInterval(s, n)[0];
    expect(width(80, 100)).toBeLessThan(width(8, 10));
    expect(wilsonInterval(0, 0)[0]).toBeNaN();
    expect(wilsonInterval(0, 0)[1]).toBeNaN();
  });
});

describe("newcombeInterval", () => {
  it("gives the published interval of 56/70 against 48/80 (Newcombe 1998, table II)", () => {
    const [low, high] = newcombeInterval(56, 70, 48, 80);
    expect(low).toBeCloseTo(0.0524, 3);
    expect(high).toBeCloseTo(0.3339, 3);
  });

  it("is NaN when a group has no answer", () => {
    expect(newcombeInterval(1, 0, 1, 2)[0]).toBeNaN();
  });
});

describe("welchInterval", () => {
  it("centers on the difference of the means, with the normal 1.96", () => {
    // means 2 and 1, variances 2/3 and 2/3, n = 4 each: se = sqrt(2/3/4 + 2/3/4)
    const [low, high] = welchInterval([1, 2, 2, 3], [0, 1, 1, 2]);
    const half = 1.96 * Math.sqrt(2 / 3 / 4 + 2 / 3 / 4);
    expect(low).toBeCloseTo(1 - half, 6);
    expect(high).toBeCloseTo(1 + half, 6);
  });

  it("is NaN for fewer than 2 samples in a group", () => {
    expect(welchInterval([1], [1, 2])[0]).toBeNaN();
  });
});

describe("intervalCounts", () => {
  it("counts an interval that does not hold 0", () => {
    expect(intervalCounts([0.1, 0.4])).toBe(true);
    expect(intervalCounts([-0.4, -0.1])).toBe(true);
    expect(intervalCounts([-0.1, 0.4])).toBe(false);
    expect(intervalCounts([Number.NaN, Number.NaN])).toBe(false);
  });
});

describe("mean", () => {
  it("averages and returns NaN for an empty list", () => {
    expect(mean([1, 2, 3, 4])).toBe(2.5);
    expect(mean([])).toBeNaN();
  });
});
