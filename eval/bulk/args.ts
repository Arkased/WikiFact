import { parseCommandLine } from "../lib/args.js";
import { dirname, join } from "node:path";
import { projectRoot } from "../../src/paths.js";
import { DEFAULT_ENV, resolveWikiDb, type EnvironmentSource } from "../lib/envs.js";

/** The arguments of the bulk test after validation. */
export interface BulkArgs {
  /** The source copy (made with the SQLite backup); the test never writes it. On a resume it names the wiki config only. */
  db: string;
  /** The number of queued submissions in the sample; 0 on a resume (the result file holds it). */
  requests: number;
  /** The result file of a stopped run to continue; absent: a new run. */
  resume?: string;
  /** The most requests in one batch; absent: the config default. */
  batchSize?: number;
  /** The calls of different groups at the same time; absent: the config default. */
  concurrency?: number;
  /** The cosine distance cut of the grouping; absent: the config default. */
  groupCut?: number;
  /** The folder for the two working copies: `--work-dir`, else with `--db` the folder of `db`, else with `--wiki` `.cache/bulk-work/<env>/<wiki>/` in the repo, never a folder of the environment. */
  workDir: string;
  /** The environment and the wiki of `--wiki`, for the result file; absent with `--db`. */
  wiki?: { env: string; name: string };
  /** The result file; absent: `eval/bulk/results/<stamp>.json`. */
  out?: string;
  /** True to keep the working copies after the run. */
  keepCopies: boolean;
  /** True to run on stub questions and the fake embedder, with no model call. */
  stub: boolean;
  /** True when `--second-only` is given: no sequential copy, only the second path; a resume takes it from the result file. */
  secondOnly: boolean;
}

function positive(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} is a positive integer`);
  return n;
}

function cutOf(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (value.trim() === "" || !Number.isFinite(n) || n <= 0) throw new Error("--group-cut is a positive number");
  return n;
}

/**
 * Reads the result file of `--rescore`, which takes no other option: the run needs no wiki and no model.
 *
 * @param argv - the arguments after the script name
 * @returns the result file, or undefined when `--rescore` is not given
 * @throws {TypeError} when `--rescore` has no value, or another option is given with it
 * @sideEffects none
 */
export function parseRescoreArgs(argv: string[]): string | undefined {
  if (!argv.some((arg) => arg === "--rescore" || arg.startsWith("--rescore="))) return undefined;
  return parseCommandLine(argv, { options: ["rescore"] }).options.get("rescore");
}

/**
 * Parses and validates the command line of the bulk test.
 *
 * @param argv - the arguments after the script name
 * @param source - the list of environments and the home folder; the real ones by default, a test points them into its run folder
 * @returns the arguments
 * @throws {Error} when `--wiki` and `--db` are both missing or both given, or `--requests` is missing without `--resume`, or a number is not a positive integer or `--group-cut` is not a positive number, or `--second-only` is given with `--resume`; {TypeError} on an unknown option (the options `--arch`, `--group-only` and `--group-shared-candidate` of #60 are gone)
 * @sideEffects with `--wiki`, reads the list of environments and the home folder name, and checks that the wiki file exists
 */
export function parseBulkArgs(argv: string[], source: EnvironmentSource = {}): BulkArgs {
  const a = parseCommandLine(argv, {
    flags: ["keep-copies", "stub", "second-only"],
    options: ["env", "wiki", "db", "requests", "batch-size", "concurrency", "group-cut", "work-dir", "out", "resume"],
  });
  const db = resolveWikiDb({ env: a.options.get("env"), wiki: a.options.get("wiki"), db: a.options.get("db") }, source);
  if (!db) throw new Error("--wiki <name> or --db <source copy> is required");
  const resume = a.options.get("resume");
  const requests = positive("requests", a.options.get("requests")) ?? (resume === undefined ? undefined : 0);
  if (requests === undefined) throw new Error("--requests <n> is required");
  const batchSize = positive("batch-size", a.options.get("batch-size"));
  const concurrency = positive("concurrency", a.options.get("concurrency"));
  const groupCut = cutOf(a.options.get("group-cut"));
  const wikiName = a.options.get("wiki");
  const env = a.options.get("env") ?? DEFAULT_ENV;
  // A run on a wiki of an environment works outside the environment, in a folder of its env and wiki, so that `--resume` finds the copies and 2 wikis never share them.
  const workDir =
    a.options.get("work-dir") ??
    (wikiName === undefined ? dirname(db) : join(projectRoot(), ".cache", "bulk-work", env, wikiName));
  const out = a.options.get("out");
  if (a.flags.has("second-only") && resume !== undefined) {
    throw new Error("--second-only takes no --resume (the result file records it)");
  }
  return {
    db,
    requests,
    ...(resume === undefined ? {} : { resume }),
    ...(batchSize === undefined ? {} : { batchSize }),
    ...(concurrency === undefined ? {} : { concurrency }),
    ...(groupCut === undefined ? {} : { groupCut }),
    workDir,
    ...(wikiName === undefined ? {} : { wiki: { env, name: wikiName } }),
    ...(out === undefined ? {} : { out }),
    keepCopies: a.flags.has("keep-copies"),
    stub: a.flags.has("stub"),
    secondOnly: a.flags.has("second-only"),
  };
}
