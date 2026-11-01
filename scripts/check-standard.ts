// `npm run check:standard`: the `[script]` rules of docs/code-standard.md that read the files of the repo. It fails on an
// absolute local path, a to-do marker with no issue, an eval that starts a server from `dist/`, a README or
// `.env.example` reference to a script, a variable or a path that does not exist, and a `…md#anchor` link that does not
// resolve, and a script name of `package.json` outside the naming rule. The files are the tracked ones (`git ls-files`).
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { isMain } from "../eval/lib/main.js";
import { checkStandard, formatStandardProblem, type RepoFile } from "./lib/standard.js";

// The repo root from the place of this file, so that the check does not depend on the working directory.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** The files that hold no text a rule reads. */
const SKIPPED = /(?:\.(?:png|jpe?g|gif|ico|webp|woff2?|sqlite|db|pdf|zip|patch)|(?:^|\/)package-lock\.json)$/;

/**
 * Lists the tracked files of the repo.
 *
 * @returns the paths relative to the project root, with forward slashes
 * @sideEffects runs `git ls-files` in the project root
 */
async function trackedPaths(): Promise<string[]> {
  const { stdout } = await execa("git", ["ls-files", "-z"], { cwd: ROOT });
  return stdout.split("\0").filter((p) => p !== "");
}

/**
 * Runs the check over the tracked files and prints the problems.
 *
 * @returns the exit code: 0 when the repo passes, 1 when a rule fails
 * @sideEffects runs `git ls-files`; reads the tracked files and `package.json`; prints the result
 */
async function main(): Promise<number> {
  const allPaths = await trackedPaths();
  const files: RepoFile[] = allPaths
    .filter((p) => !SKIPPED.test(p))
    .map((path) => ({ path, text: readFileSync(join(ROOT, path), "utf8") }));
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
  const result = checkStandard({ files, allPaths, npmScripts: Object.keys(pkg.scripts) });
  if (result.problems.length > 0) {
    for (const p of result.problems) console.error(formatStandardProblem(p));
    return 1;
  }
  console.log(`${result.filesChecked} files checked`);
  return 0;
}

if (isMain(import.meta.url)) {
  process.exitCode = await main();
}
