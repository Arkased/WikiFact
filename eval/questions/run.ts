// The question runner (technical/questions.md, "Test plan"). `npm run eval:questions -- --help` prints the usage.
import { CallerKind } from "../../src/domain/index.js";
import { loadEnvFile, readEnv } from "../../src/env.js";
import { selectTransport } from "../../src/updates/index.js";
import { hasCredentials } from "../lib/credentials.js";
import { isMain, lowerPriority } from "../lib/main.js";
import { USAGE, parseArgs } from "./args.js";
import { defaultOut, readResultFile, resultFilesIn } from "./results.js";
import { runSets } from "./run-sets.js";
import { summarize } from "./summarize.js";
import { validateSets } from "./validate.js";
import { RunnerMode } from "../lib/enums.js";
import { ARGV_USER_OFFSET, NO_CREDENTIALS_EXIT_CODE } from "../../src/constants.js";

async function main(): Promise<void> {
  loadEnvFile();
  const args = parseArgs(process.argv.slice(ARGV_USER_OFFSET));
  if (args.help) {
    console.log(USAGE);
    return;
  }
  if (args.mode === RunnerMode.Summarize) {
    summarize(args.files.length ? args.files : resultFilesIn(), args.out);
    return;
  }
  if (args.validate) {
    process.exitCode = validateSets(args.qs) === 0 ? 0 : 1;
    return;
  }
  if (!hasCredentials(readEnv())) {
    console.error(
      [
        "Blocked: no Anthropic credentials found.",
        "Set ANTHROPIC_API_KEY, or run `claude auth login` (the CLI transport), then run this command again.",
        "`npm run eval:questions -- --validate` checks the sets without the API.",
      ].join("\n"),
    );
    process.exitCode = NO_CREDENTIALS_EXIT_CODE;
    return;
  }
  const sel = selectTransport(CallerKind.Eval, readEnv());
  console.log(`transport rule: ${sel.rule}`);
  const resume = args.resume ? { file: readResultFile(args.resume), path: args.resume } : undefined;
  await runSets(args, {
    transport: sel.transport,
    transportName: sel.name,
    outPath: args.out ?? defaultOut(),
    resume,
  });
}

if (isMain(import.meta.url)) {
  lowerPriority();
  main().catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  });
}
