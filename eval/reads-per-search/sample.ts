// The samples and the agreement rule of the test of the reads per search (docs/design/console.md, "The test of the
// reads per search"). No model call here.
import type { SearchRead } from "../../src/store/index.js";
import { ReadLabel, ReadsSample, SampleVerdict } from "../lib/enums.js";
import { sample } from "../lib/sample.js";

/** The searches per sample (design: 20 for each count). */
export const SAMPLE_SIZE = 20;
/** The seed of the draw, so that a repeat of the command gives the same samples. */
export const SAMPLE_SEED = 1;
/** The share of a sample that must agree for the interpretation to be tested (design: at least 80%). */
export const AGREEMENT_BAR = 0.8;
/** A sample under this many searches gives no verdict. */
export const MIN_SAMPLE = 10;
/** The count of reads from which a search is in the sample `ThreeOrMore`. */
const MANY_READS = 3;

/** A time range in ms since the epoch, both ends included. */
export interface TimeRange {
  fromAt: number;
  toAt: number;
}

/** A search of a sample, with its count of reads. */
export interface Counted {
  search: SearchRead;
  /** The read rows that link to the search. */
  count: number;
}

/** A search with its label. */
export interface Labeled extends Counted {
  label: ReadLabel;
  /** One sentence from the labeler. */
  reason: string;
}

/** The agreement of one sample. */
export interface SampleAgreement {
  sample: ReadsSample;
  /** The searches in the sample. */
  size: number;
  /** The searches whose label agrees with the count. */
  agreed: number;
  /** `agreed` divided by `size`; null for an empty sample. */
  agreement: number | null;
  verdict: SampleVerdict;
}

/**
 * Tells which sample a count of reads belongs to.
 *
 * @param count - the read rows that link to a search
 * @returns the sample, or undefined for 2 reads, which no sample holds
 * @sideEffects none
 */
export function sampleOf(count: number): ReadsSample | undefined {
  if (count === 0) return ReadsSample.None;
  if (count === 1) return ReadsSample.One;
  return count >= MANY_READS ? ReadsSample.ThreeOrMore : undefined;
}

/**
 * Tells the label that a count of reads agrees with: 0 reads with "not found", 1 read with "found", 3 or more with "misled".
 *
 * @param s - the sample
 * @returns the label that agrees
 * @sideEffects none
 */
export function expectedLabel(s: ReadsSample): ReadLabel {
  switch (s) {
    case ReadsSample.None:
      return ReadLabel.NotFound;
    case ReadsSample.One:
      return ReadLabel.Found;
    case ReadsSample.ThreeOrMore:
      return ReadLabel.Misled;
  }
}

/**
 * Drops the searches that lie in a time range to leave out (the fill sessions, the searches after the cutoff).
 *
 * @param searches - the searches
 * @param excluded - the ranges to leave out
 * @returns the searches outside every range, in the order given
 * @sideEffects none
 */
export function outsideRanges(searches: SearchRead[], excluded: TimeRange[]): SearchRead[] {
  return searches.filter((s) => !excluded.some((r) => s.at >= r.fromAt && s.at <= r.toAt));
}

/**
 * Builds the 3 samples: for each count 0, 1 and 3 or more, `size` searches drawn at random, or all of them when fewer.
 *
 * @param searches - the searches with their reads
 * @param size - the searches per sample
 * @param seed - the seed of the draw; the same seed and searches give the same samples
 * @returns the searches of each sample, with their counts; the 2-read searches are in none
 * @sideEffects none
 */
export function buildSamples(searches: SearchRead[], size: number, seed: number): Map<ReadsSample, Counted[]> {
  const counted = searches.map((search): Counted => ({ search, count: search.reads.length }));
  const samples = new Map<ReadsSample, Counted[]>();
  for (const s of [ReadsSample.None, ReadsSample.One, ReadsSample.ThreeOrMore]) {
    samples.set(
      s,
      sample(
        counted.filter((c) => sampleOf(c.count) === s),
        size,
        seed,
      ),
    );
  }
  return samples;
}

/**
 * Scores one sample: the share of its searches whose label agrees with the count.
 *
 * @param s - the sample
 * @param labeled - the labeled searches of the sample
 * @returns the counts, the share, and the verdict: "passes" at `AGREEMENT_BAR` or more, "fails" under it, "no verdict"
 *   for a sample under `MIN_SAMPLE` searches
 * @sideEffects none
 */
export function scoreSample(s: ReadsSample, labeled: Labeled[]): SampleAgreement {
  const agreed = labeled.filter((l) => l.label === expectedLabel(s)).length;
  const agreement = labeled.length === 0 ? null : agreed / labeled.length;
  let verdict = SampleVerdict.NoVerdict;
  if (agreement !== null && labeled.length >= MIN_SAMPLE) {
    verdict = agreement >= AGREEMENT_BAR ? SampleVerdict.Passes : SampleVerdict.Fails;
  }
  return { sample: s, size: labeled.length, agreed, agreement, verdict };
}
