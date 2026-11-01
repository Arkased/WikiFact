// `npm run eval:corrections -- [--cap 5|10|20|all] [--hook] [--stub] [--concurrency 6] [--limit n] [--model m] [--consumer claude|sdk] [--keep]`
// The correction test of technical/submit.md, "Tests". The pieces live in eval/corrections/.
//
// Consumer, first that works: Claude Code headless mode (`claude -p`), the Anthropic SDK (ANTHROPIC_API_KEY), or --stub.
// Worker: the real questions when ANTHROPIC_API_KEY is set, else a stub that accepts every submission.
// The stub acceptances are not real numbers.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CallerKind, enumValues, isMember } from "../src/domain/index.js";
import { setEmbedder } from "../src/embed/index.js";
import { loadConfig } from "../src/config/index.js";
import { loadEnvFile, readEnv } from "../src/env.js";
import { errorMessage } from "../src/must.js";
import { createQuestions, findClaudeBinary } from "../src/updates/index.js";
import { fakeEmbed } from "../fakes/fake-embedder.js";
import { acceptAllQuestions, stubConsumer } from "../fakes/stub-consumer.js";
import { claudeConsumer } from "./corrections/consumers/claude.js";
import { sdkConsumer } from "./corrections/consumers/sdk.js";
import type { Consumer } from "./corrections/consumers/types.js";
import { RESULTS_DIR } from "./corrections/paths.js";
import { formatTable } from "./corrections/report.js";
import { runCorrections, type RunReport } from "./corrections/run.js";
import { FAKE_EMBEDDER_FLOOR } from "./lib/fake-embedder-floor.js";
import { parseCommandLine, type ParsedArgs } from "./lib/args.js";
import { ConsumerName, WorkerMode } from "./lib/enums.js";
import { isMain, lowerPriority } from "./lib/main.js";
import { DEFAULT_CONCURRENCY } from "./lib/pool.js";
import { resultStamp } from "./lib/stamp.js";
import { JSON_INDENT, ARGV_USER_OFFSET } from "../src/constants.js";

/** The model of the SDK consumer when `--model` is not given. */
const DEFAULT_SDK_MODEL = "claude-sonnet-5-5";
/** The search caps that `--cap all` and `--stub` run. */
const ALL_CAPS = [5, 10, 20];
/** The cap of a real run when `--cap` is not given. */
const DEFAULT_CAP = 10;
/** The exit code for a wrong command line. */
const USAGE_EXIT_CODE = 2;

/** The command line, checked. */
interface CommandOptions {
  stub: boolean;
  hook: boolean;
  keep: boolean;
  consumer?: ConsumerName;
  limit?: number;
  model?: string;
  concurrency: number;
  caps: number[];
}

/** A wrong command line; the message is for the user. */
class UsageError extends Error {}

function parseOptions(argv: string[]): CommandOptions {
  let args: ParsedArgs;
  try {
    args = parseCommandLine(argv, {
      flags: ["stub", "hook", "keep"],
      options: ["cap", "consumer", "limit", "model", "concurrency"],
    });
  } catch (e) {
    throw new UsageError(errorMessage(e));
  }
  const consumer = args.options.get("consumer");
  if (consumer !== undefined && !isMember(ConsumerName, consumer)) {
    throw new UsageError(`--consumer takes one of ${enumValues(ConsumerName).join(", ")}`);
  }
  const concurrencyText = args.options.get("concurrency");
  const concurrency = concurrencyText !== undefined ? Number(concurrencyText) : DEFAULT_CONCURRENCY;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new UsageError("--concurrency takes a whole number of 1 or more");
  }
  const stub = args.flags.has("stub");
  const cap = args.options.get("cap");
  const caps = cap === "all" ? ALL_CAPS : cap !== undefined ? [Number(cap)] : stub ? ALL_CAPS : [DEFAULT_CAP];
  if (caps.some((c) => !ALL_CAPS.includes(c))) throw new UsageError("--cap takes 5, 10, 20 or all");
  const limit = args.options.get("limit");
  return {
    stub,
    hook: args.flags.has("hook"),
    keep: args.flags.has("keep"),
    consumer,
    limit: limit !== undefined ? Number(limit) : undefined,
    model: args.options.get("model"),
    concurrency,
    caps,
  };
}

/** The consumer and its name for the report. */
interface Chosen {
  consumer: Consumer;
  name: string;
}

function chooseConsumer(opts: CommandOptions): Chosen {
  if (opts.stub) {
    setEmbedder(fakeEmbed);
    return { consumer: stubConsumer(), name: "stub (scripted, fake embedder)" };
  }
  const env = readEnv();
  const bin = findClaudeBinary(env);
  if ((opts.consumer === undefined || opts.consumer === ConsumerName.Claude) && bin) {
    return { consumer: claudeConsumer(bin), name: `claude -p${opts.model ? ` --model ${opts.model}` : ""}` };
  }
  if ((opts.consumer === undefined || opts.consumer === ConsumerName.Sdk) && env.apiKey) {
    const model = opts.model ?? DEFAULT_SDK_MODEL;
    return { consumer: sdkConsumer(model), name: `anthropic sdk ${model}` };
  }
  throw new UsageError(
    "No consumer works: no `claude` binary and no ANTHROPIC_API_KEY. Run with --stub to prove the harness.",
  );
}

async function run(argv: string[]): Promise<void> {
  loadEnvFile();
  const opts = parseOptions(argv);
  const { consumer, name: consumerName } = chooseConsumer(opts);
  const workerMode = readEnv().apiKey && !opts.stub ? WorkerMode.Real : WorkerMode.Stub;
  const dir = mkdtempSync(join(tmpdir(), "wikifact-corrections-"));
  console.log(`consumer: ${consumerName}`);
  console.log(
    `worker: ${workerMode === WorkerMode.Real ? "real questions" : "STUB questions that accept every submission (not real acceptances)"}`,
  );
  console.log(`hook: ${opts.hook ? "on" : "off"}; caps: ${opts.caps.join(", ")}; dir: ${dir}\n`);

  try {
    const reports: RunReport[] = [];
    for (const cap of opts.caps) {
      const questions =
        workerMode === WorkerMode.Real
          ? createQuestions(loadConfig(join(dir, "x")), undefined, { kind: CallerKind.Eval })
          : acceptAllQuestions();
      reports.push(
        await runCorrections({
          cap,
          relevanceFloor: opts.stub ? FAKE_EMBEDDER_FLOOR : undefined,
          hook: opts.hook,
          consumer,
          consumerName,
          workerMode,
          questions,
          dir,
          limit: opts.limit,
          concurrency: opts.concurrency,
          model: opts.model,
          log: (s) => console.error(`[cap ${cap}] ${s}`),
        }),
      );
    }

    console.log(formatTable(reports));
    mkdirSync(RESULTS_DIR, { recursive: true });
    const file = join(RESULTS_DIR, `${resultStamp()}${opts.stub ? "-stub" : ""}${opts.hook ? "-hook" : ""}.json`);
    writeFileSync(
      file,
      JSON.stringify({ consumer: consumerName, workerMode, hook: opts.hook, reports }, null, JSON_INDENT),
    );
    console.log(`\nresults: ${file}`);
  } finally {
    if (!opts.keep) rmSync(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  try {
    await run(process.argv.slice(ARGV_USER_OFFSET));
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    console.error(e.message);
    process.exitCode = USAGE_EXIT_CODE;
  }
}

if (isMain(import.meta.url)) {
  lowerPriority();
  main().catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  });
}
