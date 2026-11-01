// `npm run eval:harvest -- <question> --logs <dir>`: sample cases from real use out of the call logs of a worker (technical/questions.md, "Test plan").
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { QuestionId, isMember } from "../../src/domain/index.js";
import { CaseGroup } from "../lib/enums.js";
import { parseCommandLine } from "../lib/args.js";
import { isMain } from "../lib/main.js";
import { sample } from "../lib/sample.js";
import { resultStamp } from "../lib/stamp.js";
import { compactInput, expandInput, loadSet } from "./sets.js";
import { JSON_INDENT, ARGV_USER_OFFSET } from "../../src/constants.js";

/** The sample size when `--sample` is absent. */
export const DEFAULT_SAMPLE = 30;
/** The seed when `--seed` is absent, so that a repeat of the command gives the same sample. */
export const DEFAULT_SEED = 1;
/** The digits of the number in a harvested case id. */
const ID_DIGITS = 3;

/** The folder of the harvest files. It is not a set folder: the validation of sets does not read it. */
export const HARVEST_DIR = join(dirname(fileURLToPath(import.meta.url)), "harvest");

/** The usage text that `--help` prints. */
export const HARVEST_USAGE = `Harvest cases from real use (technical/questions.md, "Test plan").

  npm run eval:harvest -- <question> --logs <dir> [--sample N] [--seed S]

Reads every worker-*-calls*.log file of the directory (current and rolled), keeps the question_call lines of the
question, drops a line whose input repeats an earlier line or an input of the set, takes a seeded sample (default ${DEFAULT_SAMPLE})
and writes eval/questions/harvest/<question>-<stamp>.json. The input of a case is in the short form of the set files (facts with id, header, content, just, refs, deleted, older),
so a labeler adds an expect and moves the case into the set. The cases hold no expect: label them first.`;

// The call lines of a worker: `worker-<wiki>-calls.log` and the rolled `worker-<wiki>-calls.<n>.log` of pino-roll.
const CALL_LOG = /^worker-.+-calls(?:\.(\d+))?\.log$/;

const callLine = z.object({
  ts: z.string(),
  event: z.literal("question_call"),
  requestId: z.string().optional(),
  question: z.string(),
  model: z.string().optional(),
  effort: z.string().optional(),
  input: z.unknown(),
  ctx: z.unknown(),
  output: z.unknown(),
});

/** One `question_call` line of a call log. `requestId`, `model` and `effort` are absent in an old stderr line. */
export type CallLine = z.infer<typeof callLine>;

/** One harvested case: no `expect`, because a label is a judgment against the rule of the question. */
export interface HarvestCase {
  id: string;
  group: CaseGroup;
  note: string;
  /** The input in the short form of the set files: the facts are compact. */
  input: unknown;
  ctx: unknown;
  /** What the observed model answered. */
  observed: unknown;
  from: { requestId?: string; model?: string; effort?: string; ts: string };
}

/** A harvest file. */
export interface HarvestFile {
  question: QuestionId;
  source: {
    /** The base names of the call log files read, oldest first, with no directory. */
    files: string[];
    /** The `question_call` lines of the question that parsed. */
    lines: number;
    /** The cases written. */
    kept: number;
    /** The lines dropped for an input equal to an earlier line or to a case of the set. */
    dropped: number;
    /** The lines of the call logs that did not parse; they are skipped. */
    unparsed: number;
  };
  cases: HarvestCase[];
}

/**
 * Serializes a value as JSON with the keys of every object in sorted order, so that equal values give equal text.
 *
 * @param v - a JSON value
 * @returns the text
 * @sideEffects none
 */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (typeof v === "object" && v !== null) {
    const entries = Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${stableJson(x)}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/**
 * Lists the call log files of a directory, the oldest first (a higher number is newer).
 *
 * @param dir - the log directory
 * @returns the paths of `worker-<wiki>-calls.log` and `worker-<wiki>-calls.<n>.log`
 * @sideEffects reads the directory
 */
export function callLogFiles(dir: string): string[] {
  const num = (n: string): number => Number(CALL_LOG.exec(n)?.[1] ?? 0);
  return readdirSync(dir)
    .filter((n) => CALL_LOG.test(n))
    .sort((a, b) => num(a) - num(b) || (a < b ? -1 : 1))
    .map((n) => join(dir, n));
}

/**
 * Reads the `question_call` lines of one question out of the call log files.
 *
 * @param files - the files, oldest first
 * @param question - the question id as the lines name it
 * @returns the lines in file order, and the count of lines that did not parse
 * @sideEffects reads the files
 */
export function readCalls(files: string[], question: string): { lines: CallLine[]; unparsed: number } {
  const lines: CallLine[] = [];
  let unparsed = 0;
  for (const f of files) {
    for (const text of readFileSync(f, "utf8").split("\n")) {
      if (text.trim() === "") continue;
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        unparsed++;
        continue;
      }
      // Another event of the same file (or of another question) is not a call line of this question.
      if (typeof raw !== "object" || raw === null || Reflect.get(raw, "event") !== callLine.shape.event.value) continue;
      const r = callLine.safeParse(raw);
      if (!r.success) unparsed++;
      else if (r.data.question === question) lines.push(r.data);
    }
  }
  return { lines, unparsed };
}

/**
 * Drops the lines whose input repeats an earlier line or an input of the set.
 *
 * @param lines - the call lines, oldest first
 * @param known - the inputs that the set already holds
 * @returns the lines that stay, and the count that went
 * @sideEffects none
 */
export function dedupe(lines: CallLine[], known: unknown[]): { kept: CallLine[]; dropped: number } {
  const seen = new Set(known.map(stableJson));
  const kept: CallLine[] = [];
  for (const l of lines) {
    const key = stableJson(l.input);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(l);
  }
  return { kept, dropped: lines.length - kept.length };
}

// The inputs of the set, in the form of the set file and in the expanded form that the call log holds.
function setInputs(q: QuestionId): unknown[] {
  return loadSet(q).cases.flatMap((c) => {
    try {
      return [c.input, expandInput(q, c.input)];
    } catch {
      return [c.input];
    }
  });
}

/** What `harvest` needs. */
export interface HarvestOptions {
  question: QuestionId;
  logs: string;
  sample?: number;
  seed?: number;
  /** The folder to write to; default: `eval/questions/harvest/`. */
  outDir?: string;
  print?: (s: string) => void;
}

/**
 * Harvests cases from the call logs of a directory and writes the harvest file.
 *
 * @param o - the question, the log directory, the sample size and seed, the output folder and the print function
 * @returns the harvest file and its path
 * @throws {Error} when the directory has no call log
 * @sideEffects reads the log files and the set; writes `<outDir>/<question>-<stamp>.json`; prints the counts through `print`
 */
export function harvest(o: HarvestOptions): { file: HarvestFile; path: string } {
  const print = o.print ?? console.log;
  const files = callLogFiles(o.logs);
  if (files.length === 0) throw new Error(`no worker-*-calls*.log file in ${o.logs}`);
  const { lines, unparsed } = readCalls(files, o.question);
  const { kept, dropped } = dedupe(lines, setInputs(o.question));
  const picked = sample(kept, o.sample ?? DEFAULT_SAMPLE, o.seed ?? DEFAULT_SEED);
  const cases = picked.map((l, i): HarvestCase => {
    const from: HarvestCase["from"] = { ts: l.ts };
    if (l.requestId !== undefined) from.requestId = l.requestId;
    if (l.model !== undefined) from.model = l.model;
    if (l.effort !== undefined) from.effort = l.effort;
    return {
      id: `${o.question.toLowerCase()}-h${String(i + 1).padStart(ID_DIGITS, "0")}`,
      group: CaseGroup.RealUse,
      note: "real use: not labeled",
      input: typeof l.input === "object" && l.input !== null ? compactInput(o.question, { ...l.input }) : l.input,
      ctx: l.ctx,
      observed: l.output,
      from,
    };
  });
  const file: HarvestFile = {
    question: o.question,
    source: { files: files.map((f) => basename(f)), lines: lines.length, kept: cases.length, dropped, unparsed },
    cases,
  };
  const path = join(o.outDir ?? HARVEST_DIR, `${o.question}-${resultStamp()}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(file, null, JSON_INDENT) + "\n");
  print(
    `${o.question}: ${files.length} call log file(s), ${lines.length} call line(s), ${unparsed} unparsed, ${dropped} dropped as repeats, ${cases.length} kept`,
  );
  print(`harvest written to ${path}`);
  return { file, path };
}

/**
 * Parses the value of an integer option.
 *
 * @param name - the option name, for the error message
 * @param value - the text after the option
 * @param min - the least value allowed
 * @returns the integer
 * @throws {Error} when the text is not a whole decimal integer of at least `min`
 * @sideEffects none
 */
export function parseIntegerOption(name: string, value: string, min: number): number {
  const n = Number(value);
  if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(n) || n < min) {
    throw new Error(`--${name} must be an integer of at least ${min}, got "${value}"`);
  }
  return n;
}

function main(): void {
  const args = parseCommandLine(process.argv.slice(ARGV_USER_OFFSET), {
    flags: ["help"],
    options: ["logs", "sample", "seed"],
  });
  const q = args.positionals[0];
  const logs = args.options.get("logs");
  if (args.flags.has("help") || q === undefined || logs === undefined || !isMember(QuestionId, q)) {
    console.log(HARVEST_USAGE);
    process.exitCode = args.flags.has("help") ? 0 : 1;
    return;
  }
  const num = (name: string, min: number): number | undefined => {
    const v = args.options.get(name);
    return v === undefined ? undefined : parseIntegerOption(name, v, min);
  };
  harvest({ question: q, logs, sample: num("sample", 1), seed: num("seed", Number.MIN_SAFE_INTEGER) });
}

if (isMain(import.meta.url)) {
  try {
    main();
  } catch (e: unknown) {
    console.error(e);
    process.exitCode = 1;
  }
}
