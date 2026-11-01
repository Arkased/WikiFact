import { describe, expect, it } from "vitest";
import { HOUR_MS, bucketStart, bucketStarts, mean, p95 } from "../console/time.js";
import { DAY_MS } from "../types/index.js";

describe("buckets", () => {
  it("round a time down to its day or hour", () => {
    const t = 3 * DAY_MS + 5 * HOUR_MS + 7;
    expect(bucketStart(t, DAY_MS)).toBe(3 * DAY_MS);
    expect(bucketStart(t, HOUR_MS)).toBe(3 * DAY_MS + 5 * HOUR_MS);
  });

  it("list the bucket starts that cover a window, and none for an empty window", () => {
    expect(bucketStarts(DAY_MS + 1, 3 * DAY_MS + 1, DAY_MS)).toEqual([DAY_MS, 2 * DAY_MS, 3 * DAY_MS]);
    expect(bucketStarts(DAY_MS, 3 * DAY_MS, DAY_MS)).toEqual([DAY_MS, 2 * DAY_MS]);
    expect(bucketStarts(5, 5, HOUR_MS)).toEqual([]);
    expect(bucketStarts(9, 5, HOUR_MS)).toEqual([]);
  });
});

describe("mean and p95", () => {
  it("are undefined on an empty sample", () => {
    expect(mean([])).toBeUndefined();
    expect(p95([])).toBeUndefined();
  });

  it("take the nearest rank for p95 and the arithmetic mean", () => {
    const sample = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(p95(sample)).toBe(95);
    expect(p95([10, 20, 30])).toBe(30);
    expect(p95([7])).toBe(7);
    expect(mean([10, 20, 30])).toBe(20);
  });
});
