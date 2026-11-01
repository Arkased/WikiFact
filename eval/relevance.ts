// `npm run eval:relevance [-- --fake] [-- --out FILE]`
//
// technical/lookup.md, "Tests": the relevance test: the replay seed plus the facts of eval/relevance.json, with the real embedder,
// and the queries of that file. It records a read on 2 facts first, so that the usefulness multiplier is in play.
// Pass condition: every answerable query has its fact in the top 3, at least 90 percent of the terms-form ones at rank 1, and at
// least NO_ANSWER_SHARE of the unanswerable queries return an empty list or only allowed neighbors. Exit code 1 on a fail. The code is in eval/relevance/.
// `--fake` swaps in the fake embedder: it proves the harness, not the ranking.
import { setEmbedder } from "../src/embed/index.js";
import { fakeEmbed } from "../fakes/fake-embedder.js";
import { parseCommandLine } from "./lib/args.js";
import { isMain, lowerPriority } from "./lib/main.js";
import { defaultRelevanceOut, runRelevanceToFile } from "./relevance/run.js";
import { ARGV_USER_OFFSET } from "../src/constants.js";

async function main(): Promise<void> {
  const args = parseCommandLine(process.argv.slice(ARGV_USER_OFFSET), { flags: ["fake"], options: ["out"] });
  if (args.flags.has("fake")) setEmbedder(fakeEmbed);
  const report = await runRelevanceToFile(args.options.get("out") ?? defaultRelevanceOut(), (l) => console.log(l));
  process.exitCode = report.pass ? 0 : 1;
}

if (isMain(import.meta.url)) {
  lowerPriority();
  main().catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  });
}
