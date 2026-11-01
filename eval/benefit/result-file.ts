// The result file of the benefit test (technical/evaluation.md, "The result file"): written after each run, so a
// stopped run leaves its rows, and read back to resume.
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "../lib/write-file-atomic.js";
import { ArmChoice, BenefitCopy, GroupChoice, KindChoice, PreloadStop } from "../lib/enums.js";
import { resultRow, runKey, type ResultRow } from "./rows.js";
import { heldBars, summarize, type HeldBar, type Summary } from "./summary.js";
import { JSON_INDENT } from "../../src/constants.js";

/** The folder of the result files, relative to the project root. */
export const BENEFIT_RESULTS_DIR = join("eval", "benefit-results");

const preloadMeta = z.object({
  /** The most rounds (`--preload-rounds`). */
  mostRounds: z.number(),
  /** The rounds that ran, each with the changes the worker accepted in it. */
  rounds: z.array(z.object({ accepted: z.number() })),
  /** Why the preload ended; absent while it has not ended (a stopped run): `--resume` then makes the copy again. */
  stoppedBy: z.nativeEnum(PreloadStop).optional(),
});

/** The preload of a run, as the head of the result file holds it. */
export type PreloadMeta = z.infer<typeof preloadMeta>;

const meta = z.object({
  startedAt: z.string(),
  updatedAt: z.string(),
  commit: z.string(),
  model: z.string(),
  judgeModel: z.string(),
  agent: z.string(),
  runs: z.number(),
  concurrency: z.number(),
  arm: z.nativeEnum(ArmChoice),
  kind: z.nativeEnum(KindChoice),
  group: z.nativeEnum(GroupChoice),
  casesFile: z.string(),
  cases: z.number(),
  /** `--preload-rounds`; a file from before the preload reads as 0. */
  preloadRounds: z.number().default(0),
  /** The preload; absent when it is off or no case reads the preload copy. */
  preload: preloadMeta.optional(),
  /** Why the run stopped before its last job, e.g. a rate limit; absent for a run that did all its jobs. */
  stoppedBy: z.string().optional(),
  /** The bar: none at the first runs; the held group is reported in `heldBars`. */
  passCondition: z.string(),
});

/** The facts about a run that go in the head of its result file. */
export type ResultMeta = z.infer<typeof meta>;

const fileSchema = z.object({ meta, rows: z.array(resultRow) });

/** The result file as it is written. */
interface ResultFile {
  meta: ResultMeta;
  rows: ResultRow[];
  summary: Summary;
  heldBars: HeldBar[];
}

/**
 * Writes the result file: the head, the rows and the summary of the rows so far. It writes a temporary file and renames
 * it, so a stop in the middle never leaves a half file.
 *
 * @param path - the result file
 * @param head - the head
 * @param rows - the rows so far
 * @sideEffects creates the folder; writes the file
 */
export function writeResultFile(path: string, head: ResultMeta, rows: ResultRow[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const summary = summarize(rows);
  const body: ResultFile = { meta: head, rows, summary, heldBars: heldBars(summary) };
  writeFileAtomic(path, JSON.stringify(body, null, JSON_INDENT));
}

/**
 * Reads a result file of an earlier run, to resume it.
 *
 * @param path - the result file
 * @returns the head and the rows
 * @throws {Error} when the file cannot be read or does not match the schema
 * @sideEffects reads the file
 */
export function readResultFile(path: string): { meta: ResultMeta; rows: ResultRow[] } {
  const parsed = fileSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) throw new Error(`the result file ${path} is invalid: ${parsed.error.issues[0]?.message ?? ""}`);
  return { meta: parsed.data.meta, rows: parsed.data.rows };
}

/** The parts of the head that a resumed run must share with the file it continues: rows of another setup do not mix. */
export type ResumeIdentity = Pick<
  ResultMeta,
  "commit" | "model" | "runs" | "arm" | "kind" | "group" | "casesFile" | "cases" | "preloadRounds"
>;

/**
 * Checks that a run may continue an earlier file: the commit, the model, the runs, the arm, the kind, the group, the
 * cases file and the number of cases are the same. The head of the file is never rewritten with other values.
 *
 * @param earlier - the head of the earlier file
 * @param now - the same parts for the run that wants to continue
 * @returns the names of the parts that differ; empty when the run may continue
 * @sideEffects none
 */
export function resumeMismatches(earlier: ResumeIdentity, now: ResumeIdentity): string[] {
  const keys: (keyof ResumeIdentity)[] = [
    "commit",
    "model",
    "runs",
    "arm",
    "kind",
    "group",
    "casesFile",
    "cases",
    "preloadRounds",
  ];
  return keys.filter((k) => earlier[k] !== now[k]);
}

/**
 * The keys of the runs that a resumed run skips.
 *
 * @param rows - the rows of the earlier file
 * @returns the set of run keys
 * @sideEffects none
 */
export function doneKeys(rows: ResultRow[]): Set<string> {
  return new Set(rows.map(runKey));
}

/**
 * Checks that no row of an earlier file came from before the preload: a row with no `copy` or with `copy: "filled"`
 * read the filled wiki, and the new rows read the preloaded copy, so one file would mix both.
 *
 * @param rows - the rows of the earlier file
 * @returns the reason to refuse, or undefined when every row read the preloaded copy
 * @sideEffects none
 */
export function oldCopyMessage(rows: ResultRow[]): string | undefined {
  const old = rows.filter((r) => r.copy !== BenefitCopy.Preloaded).length;
  return old > 0
    ? `--resume names a result file from before the preload: ${String(old)} rows did not read the preloaded copy; start the run again`
    : undefined;
}
