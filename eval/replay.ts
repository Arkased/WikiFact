// `npm run eval:replay [-- --stub] [-- --case r05] [-- --verbose] [-- --quality budget|standard|premium]
//                 [-- --concurrency N] [-- --out FILE]`
//
// technical/updates.md, "Tests": the replay test: 12 recorded change requests with expected outcomes, run through `runOnce`
// (the whole pipeline) on a seeded store. Each case starts from a fresh copy of the seed, so one miss does not
// move the next case. The code is in eval/replay/.
//
// Pass condition: no duplicate and no compound fact, the 2 costly failures. Any other miss is reported only.
//   - A case tagged "duplicate" fails when the pipeline writes a second fact for a scope that a live fact holds.
//   - A case tagged "compound" fails when the compound submission is not rejected at step 1 with no fact written.
//   - Every case fails when 2 live facts share a header after the run.
//
// Real run: the real embedder and the real questions. Needs credentials (ANTHROPIC_API_KEY or `ant auth login`).
// `--stub` runs the same harness against `StubQuestions` that a script in the case answers, and the fake embedder.
// It proves the harness and the checks without the API. It says nothing about the model.
import { loadPresets, parseConfig } from "../src/config/index.js";
import { CallerKind, Quality, enumValues, isMember } from "../src/domain/index.js";
import { setEmbedder } from "../src/embed/index.js";
import { loadEnvFile, readEnv } from "../src/env.js";
import { buildQuestions, selectTransport } from "../src/updates/index.js";
import { fakeEmbed } from "../fakes/fake-embedder.js";
import { scriptedStub } from "../fakes/scripted-stub.js";
import { parseCommandLine } from "./lib/args.js";
import { RunMode } from "./lib/enums.js";
import { hasCredentials } from "./lib/credentials.js";
import { isMain, lowerPriority } from "./lib/main.js";
import { DEFAULT_CONCURRENCY } from "./lib/pool.js";
import { required } from "./lib/required-value.js";
import { loadReplay } from "./replay/load.js";
import { printReport } from "./replay/report.js";
import { defaultReplayOut, runReplayToFile } from "./replay/result-file.js";
import { ARGV_USER_OFFSET, EXIT_USAGE } from "../src/constants.js";

async function main(): Promise<void> {
  loadEnvFile();
  const args = parseCommandLine(process.argv.slice(ARGV_USER_OFFSET), {
    flags: ["stub", "verbose"],
    options: ["case", "quality", "concurrency", "out"],
  });
  const stub = args.flags.has("stub");
  const only = args.options.get("case");
  const verbose = args.flags.has("verbose");
  const quality = args.options.get("quality"); // a preset of technical/questions.md, "Quality presets", default standard
  if (quality !== undefined && !isMember(Quality, quality))
    throw new Error(`--quality is one of ${enumValues(Quality).join(", ")}`);
  const file = loadReplay();
  const config = parseConfig({ subject: file.subject, ...(quality ? { quality } : {}) }, { presets: loadPresets() });

  if (stub) setEmbedder(fakeEmbed);
  else if (!hasCredentials(readEnv())) {
    console.error(
      [
        "Blocked: no Anthropic credentials found.",
        "Set ANTHROPIC_API_KEY, or run `ant auth login`, then run `npm run eval:replay` again.",
        "`npm run eval:replay -- --stub` runs the harness against the stub with no API call.",
      ].join("\n"),
    );
    process.exitCode = EXIT_USAGE;
    return;
  }

  const concurrencyArg = args.options.get("concurrency");
  const concurrency =
    concurrencyArg === undefined ? DEFAULT_CONCURRENCY : Math.max(1, Number.parseInt(concurrencyArg, 10));
  const out = args.options.get("out") ?? defaultReplayOut();
  const selected = stub ? undefined : selectTransport(CallerKind.Eval, readEnv());
  // One Questions per case, so the token usage of a case is its own when cases run in parallel.
  const real = (): ReturnType<typeof buildQuestions> =>
    buildQuestions({
      settings: config.questions,
      timeoutSeconds: config.questionTimeout,
      transport: required(selected, "no transport was selected").transport,
    });
  const { report } = await runReplayToFile(
    {
      config,
      only,
      concurrency,
      makeQuestions: (c, ids) => (stub ? scriptedStub(c, ids) : real()),
      log: verbose ? (l) => console.error(JSON.stringify(l)) : undefined,
    },
    {
      mode: stub ? RunMode.Stub : RunMode.Real,
      transport: selected?.name ?? RunMode.Stub,
      models: stub ? [] : [...new Set(Object.values(config.questions).map((s) => s.model))],
    },
    out,
  );
  console.log(
    stub
      ? "replay with StubQuestions (proves the harness, not the model)\n"
      : `replay with the real questions (${selected?.name ?? ""} transport, concurrency ${concurrency})\n`,
  );
  printReport(report);
  console.log(`results written to ${out}`);
  process.exitCode = report.pass ? 0 : 1;
}

if (isMain(import.meta.url)) {
  lowerPriority();
  main().catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  });
}
