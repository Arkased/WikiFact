// `npm run export:public -- <target>`: copies the build branch into a local clone of the public repo as 1 commit
// (docs/technical/publication.md, "The export command"). It never pushes.
import { resolve } from "node:path";
import { ARGV_USER_OFFSET } from "../src/constants.js";
import { projectRoot } from "../src/paths.js";
import { isMain } from "../eval/lib/main.js";
import { exportPublic } from "./lib/export-public.js";
import { ScriptError, runAsyncScript } from "./lib/shell.js";

/**
 * Runs the export for the target on the command line and prints the result.
 *
 * @param argument - the first argument after the script name: the local clone of the public repo
 * @returns once the export has finished
 * @throws {ScriptError} when there is no argument, or the export refuses (see `exportPublic`)
 * @sideEffects as `exportPublic`; prints one line to stdout
 */
async function main(argument: string | undefined): Promise<void> {
  if (argument === undefined) {
    throw new ScriptError("usage: npm run export:public -- <target>, the local clone of the public repo");
  }
  const target = resolve(argument);
  const r = await exportPublic(projectRoot(), target);
  console.log(
    r.committed
      ? `committed WikiFact v${r.version} in ${target}; read it, then push it yourself`
      : `nothing to commit: ${target} already holds WikiFact v${r.version}`,
  );
}

if (isMain(import.meta.url)) void runAsyncScript(() => main(process.argv[ARGV_USER_OFFSET]));
