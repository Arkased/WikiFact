// `tsx scripts/quiet-step.ts <npm script> [-- <arguments>]`: runs 1 step of `npm run check` with its output captured and
// prints the pass line, or the output and the FAIL line (scripts/lib/quiet-step.ts, #52). Exits with the code of the step.
import { isMain } from "../eval/lib/main.js";
import { ARGV_USER_OFFSET } from "../src/constants.js";
import { readEnv } from "../src/env.js";
import { CHECK_RESULTS_ENV, launchStep, runQuietStep } from "./lib/quiet-step.js";

if (isMain(import.meta.url)) {
  process.exitCode = await runQuietStep(process.argv.slice(ARGV_USER_OFFSET).join(" "), {
    launch: launchStep,
    write: (text) => void process.stdout.write(text),
    now: () => performance.now(),
    resultsDir: readEnv().raw[CHECK_RESULTS_ENV],
  });
}
