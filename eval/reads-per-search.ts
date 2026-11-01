// The test of the reads per search of docs/design/console.md, "The test of the reads per search". The code is in eval/reads-per-search/.
// Usage: npm run eval:reads-per-search -- --db <copy.sqlite> [--out FILE | --resume FILE]
//   --db FILE      a copy of the wiki store; it is opened read-only. Never the live file.
//   --out FILE     write the result JSON to FILE. Default: eval/reads-per-search-results/<stamp>.json.
//   --resume FILE  continue an earlier result file (same seed and sample size): label only the searches that have no label, write into FILE.
//                  It cannot be combined with --out: a resume always writes into FILE.
// Takes 3 samples of 20 searches (0, 1 and 3 or more reads), has a model of a higher tier label each one, and prints the agreement of each sample.
import { loadPresets, loadPrices } from "../src/config/index.js";
import { EXIT_USAGE, ARGV_USER_OFFSET, NO_CREDENTIALS_EXIT_CODE } from "../src/constants.js";
import { CallerKind, QuestionId } from "../src/domain/index.js";
import { loadEnvFile, readEnv } from "../src/env.js";
import { selectTransport } from "../src/updates/index.js";
import { hasCredentials } from "./lib/credentials.js";
import { isMain, lowerPriority } from "./lib/main.js";
import { parseReadsArgs } from "./reads-per-search/args.js";
import { modelLabeler } from "./reads-per-search/labeler.js";
import { runReadsPerSearch } from "./reads-per-search/run.js";

/** The question whose `standard` setting labels: the same one that judges in the benefit test. */
const LABELER_QUESTION = QuestionId.Q2;

async function main(): Promise<number> {
  loadEnvFile();
  const parsed = parseReadsArgs(process.argv.slice(ARGV_USER_OFFSET));
  if (!parsed.ok) {
    console.error(parsed.error);
    return EXIT_USAGE;
  }
  const env = readEnv();
  if (!hasCredentials(env)) {
    console.error("Blocked: no Anthropic credentials found. Set ANTHROPIC_API_KEY, or run `ant auth login`.");
    return NO_CREDENTIALS_EXIT_CODE;
  }
  const settings = loadPresets().presets.standard?.[LABELER_QUESTION];
  if (!settings) {
    console.error("The standard preset has no setting for the judgment question of the labeler.");
    return EXIT_USAGE;
  }
  const { transport } = selectTransport(CallerKind.Eval, env);
  await runReadsPerSearch({
    db: parsed.db,
    labeler: modelLabeler(transport, settings, loadPrices()),
    labelerModel: `${settings.model} (${settings.effort})`,
    target: parsed.target,
  });
  return 0;
}

if (isMain(import.meta.url)) {
  lowerPriority();
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e: unknown) => {
      console.error(e);
      process.exitCode = 1;
    });
}
