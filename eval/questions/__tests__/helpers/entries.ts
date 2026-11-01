// Result entries and files for the tests of summarize.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effort, QuestionId } from "../../../../src/domain/enums.js";
import type { Entry } from "../../results.js";
import { loadSet } from "../../sets.js";

/**
 * Builds a result entry of one configuration.
 *
 * @param q - the question
 * @param promptHash - the hash of the prompt that the run measured; absent for an old entry
 * @param finishedAt - the time the run ended
 * @param over - fields that replace the defaults
 * @returns the entry
 * @sideEffects none
 */
export const hashedEntry = (
  q: QuestionId,
  promptHash?: string,
  finishedAt = "2026-10-09T10:00:00.000Z",
  over: Partial<Entry> = {},
): Entry => ({
  question: q,
  model: "claude-sonnet-5-5",
  effort: Effort.Low,
  effortSent: true,
  cases: 1,
  runs: 1,
  runAccuracy: [1],
  mean: 1,
  allRunsPass: true,
  unstable: [],
  failing: [],
  errors: 0,
  usage: { input: 1, output: 1 },
  costEstimateUsd: 0,
  startedAt: finishedAt,
  finishedAt,
  ...(promptHash === undefined ? {} : { promptHash }),
  ...over,
});

/**
 * Makes an entry cover the whole set of its question, so that summarize does not take it for a smoke run.
 *
 * @param e - the entry
 * @returns a copy with the case count of the set
 * @sideEffects none
 */
export function fullSet(e: Entry): Entry {
  return { ...e, cases: loadSet(e.question).cases.length };
}

/**
 * Writes result files into a new `results` folder.
 *
 * @param files - the entries of each file, by file name
 * @returns the folder, the paths of the files in the order given
 * @sideEffects creates a temp folder and the files
 */
export function writeResultFiles(files: Record<string, Entry[]>): { dir: string; paths: string[] } {
  const root = mkdtempSync(join(tmpdir(), "qres-"));
  const dir = join(root, "results");
  mkdirSync(dir, { recursive: true });
  const paths = Object.entries(files).map(([name, results]) => {
    const path = join(dir, name);
    writeFileSync(
      path,
      JSON.stringify({ startedAt: "x", complete: true, transport: "fake", runs: 1, bar: {}, results, summary: [] }),
    );
    return path;
  });
  return { dir, paths };
}
