// `npm run eval:bulk -- --db <copy> --requests <n> [--batch-size N] [--concurrency N] [--group-cut <cut>] [--work-dir DIR]
//                       [--out FILE] [--keep-copies] [--stub] [--second-only]`
// `npm run eval:bulk -- --db <copy> --resume <result file> [--work-dir DIR]`   continues a stopped run on its kept copies
//                                                                        (takes the batch size, the concurrency, the cut and --second-only from the file: no --second-only)
// `npm run eval:bulk -- --rescore <result file>`   scores the request ends of each path of the file again with the current
//                                                  scorer and writes the file back; no model call, no copy, no other option
//
// `--second-only` runs no benchmark copy: only the second path, scored against the labels; the file holds no sequential path
// and no differences.
//
// technical/updates.md, "High volume mode", "The test of both paths": takes the first `n` queued submissions of a copy of
// a wiki, runs them 1 at a time on a second copy and as batches of the worker (src/updates/batch/, started with no wait)
// on a third, from the same start, and writes eval/bulk/results/<stamp>.json with, per path, the wall time,
// the tokens, the dollars, the calls, the outcome of each request, the duplicate pairs left among the live facts (judged
// by Q1) and the facts that differ. The two paths run one after the other. A rate limit stops the run; the file keeps
// what was measured. The code is in eval/bulk/.
//
// `--db` is a copy made with the SQLite backup API, or the wiki of `npm run eval:bulk-wiki` (technical/updates.md, "The wiki of
// the bulk test"); it is never written. `--stub` runs the harness on stub questions and the fake embedder, with no model
// call. The source has to be made with the same embedder: the run stops with an error on a stub wiki without `--stub`, and
// on a real wiki with it.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadConfig, loadPrices, type Config } from "../src/config/index.js";
import { ARGV_USER_OFFSET, EXIT_USAGE } from "../src/constants.js";
import { CallerKind } from "../src/domain/index.js";
import { setEmbedder } from "../src/embed/index.js";
import { loadEnvFile, readEnv } from "../src/env.js";
import type { Logger } from "../src/log/index.js";
import { projectRoot } from "../src/paths.js";
import type { Store } from "../src/store/index.js";
import { buildQuestions, selectTransport, type Questions } from "../src/updates/index.js";
import { fakeEmbed } from "../fakes/fake-embedder.js";
import { stubGroupCall } from "../fakes/stub-group-call.js";
import { StubQuestions } from "../fakes/stub-questions.js";
import { parseBulkArgs, parseRescoreArgs, type BulkArgs } from "./bulk/args.js";
import { rescoreResultFile } from "./bulk/rescore.js";
import { formatSummary, unfinishedLine } from "./bulk/report.js";
import { assertEmbedderMatches } from "./bulk/wiki.js";
import { readResultFile } from "./bulk/resume.js";
import { runBulkTest } from "./bulk/run.js";
import { hasCredentials } from "./lib/credentials.js";
import { isMain, lowerPriority } from "./lib/main.js";
import { required } from "./lib/required-value.js";
import { resultStamp } from "./lib/stamp.js";

async function main(): Promise<void> {
  const argv = process.argv.slice(ARGV_USER_OFFSET);
  const rescore = parseRescoreArgs(argv);
  if (rescore !== undefined) {
    for (const line of rescoreResultFile(rescore)) console.log(`score ${line}`);
    console.log(`results written to ${rescore}`);
    return;
  }
  loadEnvFile();
  const parsed = parseBulkArgs(argv);
  // A resume continues the run of its file: the sample size, the batch size, the concurrency, the cut and the stub mode are the file's.
  const resume = parsed.resume === undefined ? undefined : readResultFile(parsed.resume);
  const args: BulkArgs = resume
    ? {
        ...parsed,
        requests: resume.requests,
        batchSize: resume.batchSize,
        concurrency: resume.concurrency,
        stub: resume.stub,
        ...(resume.groupCut === undefined ? {} : { groupCut: resume.groupCut }),
      }
    : parsed;
  const base = loadConfig(args.db);
  assertEmbedderMatches(base.embeddingModel, args.stub);
  const config: Config = {
    ...base,
    highVolume: {
      ...base.highVolume,
      ...(args.batchSize === undefined ? {} : { batchSize: args.batchSize }),
      ...(args.concurrency === undefined ? {} : { concurrency: args.concurrency }),
      ...(args.groupCut === undefined ? {} : { groupCut: args.groupCut }),
    },
  };
  const outPath = parsed.resume ?? args.out ?? join(projectRoot(), "eval", "bulk", "results", `${resultStamp()}.json`);
  if (args.stub) setEmbedder(fakeEmbed);
  let makeQuestions: (store: Store) => Questions;
  let judge: Questions;
  if (args.stub) {
    makeQuestions = () => {
      const q = new StubQuestions();
      q.group = stubGroupCall();
      return q;
    };
    judge = new StubQuestions();
  } else {
    if (!hasCredentials(readEnv())) {
      console.error(
        "Blocked: no Anthropic credentials found. Run through `npm run eval:bulk`, or use --stub for the harness alone.",
      );
      process.exitCode = EXIT_USAGE;
      return;
    }
    const transport = required(selectTransport(CallerKind.Eval, readEnv()), "no transport was selected").transport;
    const build = (store?: Store): Questions =>
      buildQuestions({ settings: config.questions, timeoutSeconds: config.questionTimeout, transport, store });
    makeQuestions = build;
    judge = build();
  }
  mkdirSync(dirname(outPath), { recursive: true });
  const logPath = outPath.replace(/\.json$/, ".log");
  const log: Logger = (l) => appendFileSync(logPath, JSON.stringify(l) + "\n");
  const file = await runBulkTest({
    db: args.db,
    requests: args.requests,
    workDir: args.workDir,
    ...(args.wiki ? { wiki: args.wiki } : {}),
    outPath,
    config,
    makeQuestions,
    judge,
    prices: loadPrices(),
    log,
    keepCopies: args.keepCopies,
    stub: args.stub,
    // A resume takes second-only from its file (`runBulkTest` reads it there), not from the flags.
    ...(args.secondOnly ? { secondOnly: true } : {}),
    ...(resume ? { resume } : {}),
    say: (s) => console.log(s),
  });
  console.log("\n" + formatSummary(file));
  console.log(`results written to ${outPath}`);
  if (file.stoppedBy !== undefined) process.exitCode = 1;
  const unfinished = unfinishedLine(file);
  if (unfinished !== undefined) {
    console.error(unfinished);
    process.exitCode = 1;
  }
}

if (isMain(import.meta.url)) {
  lowerPriority();
  main().catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  });
}
