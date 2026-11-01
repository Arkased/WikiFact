// The test of the reads per search (docs/design/console.md, "The test of the reads per search"): the run that reads the
// searches of a wiki copy, builds the 3 samples, labels them and writes the result file.
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { loadConfig } from "../../src/config/index.js";
import { COST_DECIMALS, JSON_INDENT } from "../../src/constants.js";
import { closeStore, listSearchReads, openStoreFor } from "../../src/store/index.js";
import { stamp } from "../../src/time.js";
import { ReadLabel, ReadsSample, ReadsTargetKind, SampleVerdict } from "../lib/enums.js";
import { DEFAULT_CONCURRENCY, pool } from "../lib/pool.js";
import { relativeToRoot } from "../lib/relative-path.js";
import { writeFileAtomic } from "../lib/write-file-atomic.js";
import type { Labeler } from "./labeler.js";
import {
  AGREEMENT_BAR,
  MIN_SAMPLE,
  SAMPLE_SEED,
  SAMPLE_SIZE,
  buildSamples,
  outsideRanges,
  scoreSample,
  type Counted,
  type Labeled,
  type SampleAgreement,
  type TimeRange,
} from "./sample.js";

/** The folder of the result files. */
const RESULTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "reads-per-search-results");

/**
 * The searches to leave out of the test (docs/technical/evaluation.md, "The test of the reads per search"):
 * - the 4 fill sessions of 2026-10-17 (03:36 to 05:36 UTC, to the end of that minute), as
 *   `docs/research/no-result-searches-2026-10-19.md` leaves them out;
 * - the searches from 2026-10-29 02:43 UTC on: the searches of the usage tests of #2 and #98, whose prompts the test set
 *   (they are not the free use of the wiki), and of the research agents of those tests.
 */
export const EXCLUDED: readonly TimeRange[] = [
  { fromAt: Date.parse("2026-10-17T03:36:00Z"), toAt: Date.parse("2026-10-17T05:37:00Z") - 1 },
  { fromAt: Date.parse("2026-10-29T02:43:00Z"), toAt: Number.POSITIVE_INFINITY },
];

/**
 * Where the result goes: a new file, or the file of a stopped run.
 * - `New`: writes into `path`, or into the default file when `path` is absent.
 * - `Resume`: an earlier result file of the same seed and sample size; its labels are kept, its searches are not labeled
 *   again, and the run writes into it.
 */
export type ReadsTarget = { kind: ReadsTargetKind.New; path?: string } | { kind: ReadsTargetKind.Resume; path: string };

/** What `runReadsPerSearch` needs. */
export interface ReadsPerSearchOptions {
  /** A copy of the wiki store; it is opened read-only. */
  db: string;
  labeler: Labeler;
  /** The model of the labeler, named in the result file. */
  labelerModel: string;
  /** The result file: a new file (default `eval/reads-per-search-results/<stamp>.json`) or a stopped run's file, never both. */
  target?: ReadsTarget;
  /** The searches per sample; default `SAMPLE_SIZE`. */
  sampleSize?: number;
  /** The seed of the draw; default `SAMPLE_SEED`. */
  seed?: number;
  print?: (line: string) => void;
}

/** The result file. */
export interface ReadsPerSearchResult {
  meta: {
    stamp: string;
    /** The store copy, relative to the project root. */
    db: string;
    labelerModel: string;
    seed: number;
    sampleSize: number;
    agreementBar: number;
    minSample: number;
    /** The searches that the store holds with results and minted ids. */
    searchesWithMintedIds: number;
    /** The searches left out as fill sessions or after the cutoff. */
    excluded: number;
    /** The searches outside the fill, by count of reads: the 3 samples' populations and the 2-read searches. */
    population: Record<string, number>;
    /** The listed facts of the sampled searches that had no version at the time of the search and are not shown to the labeler. */
    omittedListedFacts: number;
    /** The cost so far, over all the runs that wrote into this file. */
    costUsd: number;
    /** True until every drawn search has a label: a partial file gives no verdict. */
    partial: boolean;
  };
  samples: (SampleAgreement & {
    /** The searches of the sample that have a label so far; `size` is the drawn size. */
    labeled: number;
    searches: {
      id: string;
      query: string;
      reads: number;
      label: string;
      reason: string;
      /** The ids of the listed facts left out of what the labeler saw. */
      omitted: string[];
    }[];
  })[];
}

// What a resume reads of an earlier result file.
const resumeSchema = z.object({
  meta: z.object({ stamp: z.string(), seed: z.number(), sampleSize: z.number(), costUsd: z.number() }),
  samples: z.array(
    z.object({ searches: z.array(z.object({ id: z.string(), label: z.nativeEnum(ReadLabel), reason: z.string() })) }),
  ),
});

/**
 * Runs the test: reads the searches of the copy, leaves out the fill and the cutoff, draws the 3 samples, has the labeler
 * mark each search, scores the agreement of each sample and writes the result file.
 *
 * The file is written after every label (the whole file, through a temp file and a rename), so an error of the labeler, a
 * Ctrl+C or a kill keeps the labels and the cost so far. A `Resume` target continues such a file.
 *
 * @param o - the copy, the labeler and the options
 * @returns the result and the path of the file
 * @throws {Error} when the labeler fails on a search (the file keeps the labels so far), or when a `Resume` target names a
 *   file of another seed or sample size
 * @sideEffects opens the copy read-only; one labeler call (a model call) per search without a label; writes the result
 *   file after each label; prints lines
 */
export async function runReadsPerSearch(
  o: ReadsPerSearchOptions,
): Promise<{ result: ReadsPerSearchResult; path: string }> {
  const print = o.print ?? console.log;
  const resume = o.target?.kind === ReadsTargetKind.Resume ? o.target.path : undefined;
  const store = openStoreFor(loadConfig(o.db), o.db, { readonly: true });
  const all = (() => {
    try {
      return listSearchReads(store);
    } finally {
      closeStore(store);
    }
  })();
  const kept = outsideRanges(all, [...EXCLUDED]);
  const size = o.sampleSize ?? SAMPLE_SIZE;
  const seed = o.seed ?? SAMPLE_SEED;
  const samples = buildSamples(kept, size, seed);
  const jobs: { sample: ReadsSample; item: Counted }[] = [...samples].flatMap(([sample, items]) =>
    items.map((item) => ({ sample, item })),
  );
  const labels = new Map<string, { label: ReadLabel; reason: string }>();
  let costUsd = 0;
  let stampText = stamp();
  if (resume !== undefined) {
    const earlier = resumeSchema.parse(JSON.parse(readFileSync(resume, "utf8")));
    if (earlier.meta.seed !== seed || earlier.meta.sampleSize !== size) {
      throw new Error(`cannot resume ${resume}: it has another seed or sample size`);
    }
    stampText = earlier.meta.stamp;
    costUsd = earlier.meta.costUsd;
    for (const s of earlier.samples) for (const l of s.searches) labels.set(l.id, { label: l.label, reason: l.reason });
  }
  const population: Record<string, number> = {};
  for (const c of kept) population[String(c.reads.length)] = (population[String(c.reads.length)] ?? 0) + 1;
  const path = o.target?.path ?? join(RESULTS_DIR, `${stampText}.json`);
  mkdirSync(dirname(path), { recursive: true });

  // The result of the labels so far, in the order of the jobs.
  const snapshot = (): ReadsPerSearchResult => ({
    meta: {
      stamp: stampText,
      db: relativeToRoot(o.db),
      labelerModel: o.labelerModel,
      seed,
      sampleSize: size,
      agreementBar: AGREEMENT_BAR,
      minSample: MIN_SAMPLE,
      searchesWithMintedIds: all.length,
      excluded: all.length - kept.length,
      population,
      omittedListedFacts: jobs.reduce((n, j) => n + j.item.search.omitted.length, 0),
      costUsd,
      partial: jobs.some((j) => !labels.has(j.item.search.id)),
    },
    samples: [ReadsSample.None, ReadsSample.One, ReadsSample.ThreeOrMore].map((s) => {
      const drawn = jobs.filter((j) => j.sample === s).length;
      const rows = jobs.flatMap((j): Labeled[] => {
        const l = labels.get(j.item.search.id);
        return j.sample === s && l !== undefined ? [{ ...j.item, ...l }] : [];
      });
      const scored = scoreSample(s, rows);
      return {
        ...scored,
        size: drawn,
        labeled: rows.length,
        verdict: rows.length === drawn ? scored.verdict : SampleVerdict.NoVerdict,
        searches: rows.map((l) => ({
          id: l.search.id,
          query: l.search.query,
          reads: l.count,
          label: l.label,
          reason: l.reason,
          omitted: l.search.omitted,
        })),
      };
    }),
  });
  const save = (): ReadsPerSearchResult => {
    const result = snapshot();
    writeFileAtomic(path, JSON.stringify(result, null, JSON_INDENT) + "\n");
    return result;
  };

  save();
  await pool(
    DEFAULT_CONCURRENCY,
    jobs
      .filter((j) => !labels.has(j.item.search.id))
      .map((j) => async (): Promise<void> => {
        const r = await o.labeler.label(j.item.search);
        costUsd += r.costUsd;
        labels.set(j.item.search.id, { label: r.label, reason: r.reason });
        save();
      }),
  );
  const result = save();
  for (const s of result.samples) print(`${s.sample}: ${describe(s)}`);
  print(`cost $${costUsd.toFixed(COST_DECIMALS)}; written to ${relativeToRoot(path)}`);
  return { result, path };
}

// One line for a sample: the agreed count, the share and the verdict.
function describe(s: { size: number; agreed: number; agreement: number | null; verdict: SampleVerdict }): string {
  const share = s.agreement === null ? "n/a" : `${(s.agreement * 100).toFixed(0)}%`;
  return `${s.agreed} of ${s.size} agree (${share}), ${s.verdict}`;
}
