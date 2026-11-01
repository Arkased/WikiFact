// The speed test of technical/lookup.md, "Tests". The code is in eval/speed/.
// Usage: npm run eval:speed -- [N] [--queries 200] [--fake] [--seed-fake] [--db FILE | --wiki NAME [--env NAME]] [--profile] [--out FILE]
//   N            the synthetic fact count; an error with --wiki (the wiki is measured as it is, with its own fact count).
//   --fake       fake embedder for seeding and queries.
//   --seed-fake  fake embedder for seeding only; the queries use the real one.
//   --db FILE    keep the database at FILE, and reuse it when it already holds N facts.
//   --wiki NAME  a wiki of the environment --env (default local): the test works on a copy of it, never on the wiki.
//   --profile    time each statement of the consumer search over the same queries.
//   --out FILE   write the results JSON to FILE. Default: eval/speed-results/<ISO timestamp>.json.
// Seeds N synthetic facts (default 1000), runs the queries, prints p50 and p95 in ms.
// Exit code 1 when the p95 is not under the bar of 100 ms (SPEED_BAR_MS in speed/report.ts).
import { parseCommandLine } from "./lib/args.js";
import { isMain, lowerPriority } from "./lib/main.js";
import { DEFAULT_ENV, resolveWikiDb } from "./lib/envs.js";
import { runSpeed } from "./speed/run.js";
import { ARGV_USER_OFFSET } from "../src/constants.js";

/** The fact count when none is given. */
const DEFAULT_FACTS = 1000;

/** The timed query count when `--queries` is absent. */
const DEFAULT_QUERIES = 200;

const numberOrUndefined = (v: string | undefined): number | undefined => (v === undefined ? undefined : Number(v));

async function main(): Promise<void> {
  const args = parseCommandLine(process.argv.slice(ARGV_USER_OFFSET), {
    flags: ["fake", "seed-fake", "profile"],
    options: ["queries", "env", "wiki", "db", "out"],
  });
  const facts = args.positionals[0];
  const wiki = args.options.get("wiki");
  const picked = resolveWikiDb({ env: args.options.get("env"), wiki, db: args.options.get("db") });
  const result = await runSpeed({
    facts: wiki !== undefined || facts !== undefined ? numberOrUndefined(facts) : DEFAULT_FACTS,
    queries: Number(args.options.get("queries") ?? DEFAULT_QUERIES),
    fake: args.flags.has("fake"),
    seedFake: args.flags.has("seed-fake"),
    db: wiki === undefined ? picked : undefined,
    wiki:
      wiki === undefined || picked === undefined
        ? undefined
        : { env: args.options.get("env") ?? DEFAULT_ENV, name: wiki, db: picked },
    profile: args.flags.has("profile"),
    out: args.options.get("out"),
  });
  process.exitCode = result.pass ? 0 : 1;
}

if (isMain(import.meta.url)) {
  lowerPriority();
  main().catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  });
}
