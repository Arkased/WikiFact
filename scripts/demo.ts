// `npm run demo [-- <serve options>]`: serves the demo wiki from a copy in `wikis/wikifact/`
// (docs/technical/publication.md#the-demo-copy). It runs from the built tree.
import { join } from "node:path";
import { execa } from "execa";
import { ARGV_USER_OFFSET } from "../src/constants.js";
import { projectRoot } from "../src/paths.js";
import { isMain } from "../eval/lib/main.js";
import { copyDemoWiki, requireBuilt } from "./lib/demo-copy.js";
import { runAsyncScript } from "./lib/shell.js";

/** The port of the demo service. */
const DEMO_PORT = "7777";

/**
 * Makes the copy when it is missing, then runs the service with the stdio of this process.
 *
 * @param extra - the arguments after the script name, passed to `serve`
 * @returns once the service has exited; its exit code becomes the one of this process
 * @throws {Error} when the build is missing or the demo files are missing (the script prints the message to stderr and exits with 1)
 * @sideEffects as `copyDemoWiki`; runs `dist/src/cli.js` as a child process
 */
async function main(extra: string[]): Promise<void> {
  const root = projectRoot();
  const cli = join(root, "dist", "src", "cli.js");
  requireBuilt(cli);
  copyDemoWiki(root);
  const r = await execa(process.execPath, [cli, "serve", "--wikis", "./wikis", "--http", DEMO_PORT, ...extra], {
    cwd: root,
    stdio: "inherit",
    reject: false,
  });
  process.exitCode = r.exitCode ?? 1;
}

if (isMain(import.meta.url)) void runAsyncScript(() => main(process.argv.slice(ARGV_USER_OFFSET)));
