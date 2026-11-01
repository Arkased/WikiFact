// `npm run eval:bulk-wiki [-- --stub]`: builds the wiki of the bulk test (technical/updates.md, "The wiki of the bulk test") from
// fakes/bulk-seed-facts.ts and fakes/bulk-submissions.ts into a fixed file under .cache/bulk-wiki/, which git ignores:
// bulk.sqlite, or with `--stub` (the fake embedder, no model download) bulk-stub.sqlite in another folder. The build goes
// to a temp file first and a rename puts it in place, so an earlier file is replaced whole. `npm run eval:bulk` reads the
// file with `--db`, and refuses a wiki whose embedder does not match its `--stub`. The code is in eval/bulk/wiki.ts.
import { ARGV_USER_OFFSET } from "../src/constants.js";
import { relativeToRoot } from "./lib/relative-path.js";
import { parseCommandLine } from "./lib/args.js";
import { isMain, lowerPriority } from "./lib/main.js";
import { buildBulkWiki, bulkWikiPath } from "./bulk/wiki.js";

async function main(): Promise<void> {
  const args = parseCommandLine(process.argv.slice(ARGV_USER_OFFSET), { flags: ["stub"] });
  const stub = args.flags.has("stub");
  const dbPath = bulkWikiPath(stub);
  const n = await buildBulkWiki({ dbPath, stub });
  console.log(`built ${relativeToRoot(dbPath)}: ${n.facts} facts, ${n.queued} queued submissions`);
}

if (isMain(import.meta.url)) {
  lowerPriority();
  main().catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  });
}
