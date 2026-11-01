// `npm run check:plugin`: fails when the tracked bundles of `plugin/dist/` differ from a fresh build of `plugin/src/`
// (docs/technical/publication.md#the-plugin). It builds into a temp folder and compares the files, line ends aside
// (git may check the bundles out with CRLF), and requires that git tracks each bundle.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { isMain } from "../eval/lib/main.js";
import { buildPlugin } from "./lib/plugin-build.js";

// The repo root from the place of this file, so that the check does not depend on the working directory.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = "plugin/dist";

const readFolder = (dir: string): Map<string, string> =>
  new Map(readdirSync(dir).map((name) => [name, readFileSync(join(dir, name), "utf8").replace(/\r\n/g, "\n")]));

// Compares the bundles of a folder with a fresh build: one line per missing file, extra file or file that differs.
function diffFolders(actual: string, fresh: string): string[] {
  const have = readFolder(actual);
  const want = readFolder(fresh);
  const problems: string[] = [];
  for (const [name, text] of want) {
    if (!have.has(name)) problems.push(`${DIST}/${name} is missing`);
    else if (have.get(name) !== text) problems.push(`${DIST}/${name} differs from a fresh build`);
  }
  for (const name of have.keys()) if (!want.has(name)) problems.push(`${DIST}/${name} has no source entry`);
  return problems;
}

/**
 * Compares the bundles with a fresh build and with the files that git tracks.
 *
 * @param actual - the folder to check
 * @param fresh - the folder of the fresh build
 * @param tracked - the paths that git tracks under `plugin/dist`, from the repo root with forward slashes
 * @returns one line per bundle that is missing, extra, different (line ends aside) or not tracked; empty when equal
 * @sideEffects reads the files of both folders
 */
export function findProblems(actual: string, fresh: string, tracked: ReadonlySet<string>): string[] {
  const problems = diffFolders(actual, fresh);
  for (const name of readdirSync(fresh)) {
    if (!tracked.has(`${DIST}/${name}`)) problems.push(`${DIST}/${name} is not tracked by git`);
  }
  return problems;
}

/**
 * Runs the check.
 *
 * @returns the exit code: 0 when the bundles are the fresh build and tracked, else 1
 * @sideEffects builds into a temp folder and deletes it; runs `git ls-files`; prints the result
 */
async function main(): Promise<number> {
  const fresh = mkdtempSync(join(tmpdir(), "wikifact-plugin-"));
  try {
    await buildPlugin(ROOT, fresh);
    const { stdout } = await execa("git", ["ls-files", "-z", "--", DIST], { cwd: ROOT });
    const tracked = new Set(stdout.split("\0").filter((p) => p !== ""));
    const problems = findProblems(join(ROOT, DIST), fresh, tracked);
    for (const line of problems) console.error(line);
    if (problems.length > 0) {
      console.error("check:plugin: run `npm run build` and commit plugin/dist/");
      return 1;
    }
    console.log(`${DIST}: the tracked bundles equal a fresh build`);
    return 0;
  } finally {
    rmSync(fresh, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) {
  process.exitCode = await main();
}
