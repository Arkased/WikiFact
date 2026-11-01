// The command line of the question runner (technical/questions.md, "Test plan").
import { QUESTION_IDS } from "../../src/config/index.js";
import { Effort, QuestionId, enumValues, isMember } from "../../src/domain/index.js";
import { RunnerMode } from "../lib/enums.js";
import { parseCommandLine } from "../lib/args.js";
import { MODELS } from "./models.js";
import { DECIMAL_RADIX } from "../../src/constants.js";

/** The usage text that `--help` prints. */
export const USAGE = `The question runner (technical/questions.md, "Test plan").

  npm run eval:questions                                   every question, the O6 matrix, 3 runs
  npm run eval:questions -- Q1 Q7                          two questions
  npm run eval:questions -- Q4 --model claude-opus-5-5 --effort high --runs 5
  npm run eval:questions -- --model claude-opus-5-5 --model claude-sonnet-5-5 --effort medium --effort high
                                                      only these configurations (the lists multiply)
  npm run eval:questions -- --model <new id> --resume eval/questions/results/<file>.json
                                                      run only what the file does not hold; write a new file with both
  npm run eval:questions -- summarize [files...]           pool all runs of each configuration over the result files (--limit smoke
                                                      entries ignored), print and write the O6 proposal and config/presets.json
  npm run eval:questions -- --concurrency 12              model calls in flight at the start (default 12, models.json)
  npm run eval:questions -- --full                         no staging: every run of every configuration at once
  npm run eval:questions -- --validate                     check the set files against the input schemas; no API call
  npm run eval:questions -- --help                         this text

One pool serves the whole run. On a rate limit (429) the pool halves its limit (floor 2), retries after a pause
and climbs back by 1 every 20 good calls. \`--runs 3\` is staged: 1 run for every configuration, then the other
runs only for those whose first-run mean is within 5 points of the lowest bar of the question, or above it.

Models, prices and the pass bar live in eval/questions/models.json: a new model is a config change.
Every run writes eval/questions/results/<ISO timestamp>.json (--out overrides), rewritten after each
configuration and each question set, with \`complete: false\` until the run ends.`;

/** The model calls in flight at the start when neither the command line nor models.json says. */
const FALLBACK_START_CONCURRENCY = 12;
/** The runs per configuration when `--runs` is absent. */
const DEFAULT_RUNS = 3;

/** The parsed command line of the runner. */
export interface Args {
  mode: RunnerMode;
  qs: QuestionId[];
  models: string[];
  efforts: Effort[];
  runs: number;
  limit?: number;
  validate: boolean;
  help: boolean;
  out?: string;
  resume?: string;
  concurrency: number;
  /** No staging: every run of every configuration at once. */
  full: boolean;
  files: string[];
}

// An integer option, at least 1.
function positiveInt(text: string): number {
  return Math.max(1, Number.parseInt(text, DECIMAL_RADIX));
}

/**
 * Parses the command line of the runner.
 *
 * @param argv - the arguments after the script name
 * @returns the mode, the questions (all when none is named), the models, the efforts and the run settings
 * @sideEffects none; throws an Error on an unknown option, a missing value, an unknown effort or an unknown question
 */
export function parseArgs(argv: string[]): Args {
  const cli = parseCommandLine(argv, {
    flags: ["validate", "full", "help"],
    options: ["runs", "limit", "concurrency", "out", "resume"],
    repeatable: ["model", "effort"],
  });
  const first = cli.positionals[0];
  const summarize = isMember(RunnerMode, first) && first === RunnerMode.Summarize;
  const efforts = (cli.lists.get("effort") ?? []).map((e): Effort => {
    if (!isMember(Effort, e)) throw new Error(`--effort is one of ${enumValues(Effort).join(", ")}`);
    return e;
  });
  const names = summarize ? [] : cli.positionals;
  const qs = names.map((x): QuestionId => {
    const id = x.toUpperCase();
    if (!/^q\d+b?$/i.test(x)) throw new Error(`unknown argument ${x}`);
    if (!isMember(QuestionId, id)) throw new Error(`unknown question ${x}`);
    return id;
  });
  const runs = cli.options.get("runs");
  const limit = cli.options.get("limit");
  const concurrency = cli.options.get("concurrency");
  return {
    mode: summarize ? RunnerMode.Summarize : RunnerMode.Run,
    qs: qs.length > 0 ? qs : [...QUESTION_IDS],
    models: cli.lists.get("model") ?? [],
    efforts,
    runs: runs === undefined ? DEFAULT_RUNS : positiveInt(runs),
    limit: limit === undefined ? undefined : positiveInt(limit),
    validate: cli.flags.has("validate"),
    help: cli.flags.has("help"),
    out: cli.options.get("out"),
    resume: cli.options.get("resume"),
    concurrency:
      concurrency === undefined ? (MODELS.concurrency?.start ?? FALLBACK_START_CONCURRENCY) : positiveInt(concurrency),
    full: cli.flags.has("full"),
    files: summarize ? cli.positionals.slice(1) : [],
  };
}
