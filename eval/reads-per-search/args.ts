import { parseCommandLine } from "../lib/args.js";
import { ReadsTargetKind } from "../lib/enums.js";
import type { ReadsTarget } from "./run.js";

/** The usage line of the test of the reads per search. */
export const READS_USAGE = "Usage: npm run eval:reads-per-search -- --db <copy.sqlite> [--out FILE | --resume FILE]";

/** The options of the command line, or the usage error to print. */
export type ReadsArgs = { ok: true; db: string; target: ReadsTarget } | { ok: false; error: string };

/**
 * Parses the command line of `npm run eval:reads-per-search`.
 *
 * @param argv - the arguments after the script name
 * @returns the store copy and the result target, or the message of the usage error (no `--db`, or `--resume` with `--out`)
 * @sideEffects none; throws a TypeError on an unknown option
 */
export function parseReadsArgs(argv: string[]): ReadsArgs {
  const args = parseCommandLine(argv, { options: ["db", "out", "resume"] });
  const db = args.options.get("db");
  if (db === undefined || db === "") return { ok: false, error: READS_USAGE };
  const out = args.options.get("out");
  const resume = args.options.get("resume");
  if (resume !== undefined && out !== undefined) {
    return {
      ok: false,
      error: "--resume and --out cannot be used together: a resume writes into the file it continues.",
    };
  }
  const target: ReadsTarget =
    resume !== undefined ? { kind: ReadsTargetKind.Resume, path: resume } : { kind: ReadsTargetKind.New, path: out };
  return { ok: true, db, target };
}
