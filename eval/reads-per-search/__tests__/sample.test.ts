import { describe, expect, it } from "vitest";
import type { SearchRead } from "../../../src/store/index.js";
import { ReadLabel, ReadsSample, SampleVerdict } from "../../lib/enums.js";
import {
  AGREEMENT_BAR,
  MIN_SAMPLE,
  SAMPLE_SIZE,
  buildSamples,
  expectedLabel,
  outsideRanges,
  sampleOf,
  scoreSample,
  type Labeled,
} from "../sample.js";

function searchWith(id: string, reads: number, at = 1): SearchRead {
  return {
    id,
    query: id,
    at,
    results: [],
    omitted: [],
    reads: Array.from({ length: reads }, () => ({ factId: "f", header: "h", content: "c" })),
  };
}

const many = (prefix: string, n: number, reads: number): SearchRead[] =>
  Array.from({ length: n }, (_, i) => searchWith(`${prefix}${i}`, reads));

const labeled = (labels: ReadLabel[]): Labeled[] =>
  labels.map((label, i) => ({ search: searchWith(`x${i}`, 1), count: 1, label, reason: "r" }));

describe("sampleOf", () => {
  it("puts 0, 1 and 3 or more reads in a sample and 2 reads in none", () => {
    expect(sampleOf(0)).toBe(ReadsSample.None);
    expect(sampleOf(1)).toBe(ReadsSample.One);
    expect(sampleOf(3)).toBe(ReadsSample.ThreeOrMore);
    expect(sampleOf(9)).toBe(ReadsSample.ThreeOrMore);
    expect(sampleOf(2)).toBeUndefined();
  });
});

describe("buildSamples", () => {
  const population = [...many("a", 50, 0), ...many("b", 30, 1), ...many("c", 12, 2), ...many("d", 5, 3)];
  const fewerThanSample = 5;

  it("draws SAMPLE_SIZE searches for a count with enough, all of a count with fewer, and none with 2 reads", () => {
    const s = buildSamples(population, SAMPLE_SIZE, 1);
    expect(s.get(ReadsSample.None)).toHaveLength(SAMPLE_SIZE);
    expect(s.get(ReadsSample.One)).toHaveLength(SAMPLE_SIZE);
    expect(s.get(ReadsSample.ThreeOrMore)).toHaveLength(fewerThanSample);
    expect([...s.values()].flat().every((c) => c.count !== 2)).toBe(true);
    expect(s.get(ReadsSample.One)?.every((c) => c.count === 1)).toBe(true);
  });

  it("gives the same samples for the same seed and other samples for another seed", () => {
    const ids = (seed: number): string[] =>
      (buildSamples(population, SAMPLE_SIZE, seed).get(ReadsSample.None) ?? []).map((c) => c.search.id);
    expect(ids(7)).toEqual(ids(7));
    expect(ids(7)).not.toEqual(ids(8));
  });
});

describe("outsideRanges", () => {
  it("drops the searches inside a range, ends included", () => {
    const searches = [
      searchWith("before", 0, 9),
      searchWith("start", 0, 10),
      searchWith("end", 0, 20),
      searchWith("after", 0, 21),
    ];
    const kept = outsideRanges(searches, [{ fromAt: 10, toAt: 20 }]);
    expect(kept.map((s) => s.id)).toEqual(["before", "after"]);
  });
});

describe("expectedLabel", () => {
  it("agrees 0 reads with not found, 1 read with found and 3 or more with misled", () => {
    expect(expectedLabel(ReadsSample.None)).toBe(ReadLabel.NotFound);
    expect(expectedLabel(ReadsSample.One)).toBe(ReadLabel.Found);
    expect(expectedLabel(ReadsSample.ThreeOrMore)).toBe(ReadLabel.Misled);
  });
});

describe("scoreSample", () => {
  const rows = (agree: number, other: number): Labeled[] =>
    labeled([...Array<ReadLabel>(agree).fill(ReadLabel.Found), ...Array<ReadLabel>(other).fill(ReadLabel.Misled)]);

  it("passes at 80 percent and fails under it", () => {
    const atBar = Math.ceil(AGREEMENT_BAR * SAMPLE_SIZE);
    expect(scoreSample(ReadsSample.One, rows(atBar, SAMPLE_SIZE - atBar))).toMatchObject({
      agreed: atBar,
      size: SAMPLE_SIZE,
      verdict: SampleVerdict.Passes,
    });
    expect(scoreSample(ReadsSample.One, rows(atBar - 1, SAMPLE_SIZE - atBar + 1))).toMatchObject({
      agreed: atBar - 1,
      verdict: SampleVerdict.Fails,
    });
  });

  it("gives no verdict for a sample under MIN_SAMPLE, whatever its agreement", () => {
    const s = scoreSample(ReadsSample.One, rows(MIN_SAMPLE - 1, 0));
    expect(s.verdict).toBe(SampleVerdict.NoVerdict);
    expect(s.agreement).toBe(1);
  });

  it("has no share and no verdict for an empty sample", () => {
    expect(scoreSample(ReadsSample.None, [])).toMatchObject({
      size: 0,
      agreement: null,
      verdict: SampleVerdict.NoVerdict,
    });
  });
});
