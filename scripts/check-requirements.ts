// `npm run check:requirements`: fails when a requirement in docs/requirements/ has no test with its name in
// __tests__/requirements/, when such a test has no requirement, or when a named eval does not exist.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "../eval/lib/main.js";
import { checkRequirements, formatProblem } from "./lib/requirements.js";

// The repo root from the place of this file, so that the check does not depend on the working directory.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS_DIR = join(ROOT, "docs/requirements");
const TESTS_DIR = join(ROOT, "__tests__/requirements");

// The text of each file of a folder that ends with the suffix, by file name without the suffix.
function readFolder(dir: string, suffix: string, skip: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of readdirSync(dir)) {
    if (f.endsWith(suffix) && !skip.includes(f))
      out.set(f.slice(0, -suffix.length), readFileSync(join(dir, f), "utf8"));
  }
  return out;
}

if (isMain(import.meta.url)) {
  const missing = [DOCS_DIR, TESTS_DIR].filter((d) => !existsSync(d));
  if (missing.length > 0) {
    console.error(`check:requirements: folder not found: ${missing.join(", ")}`);
    process.exit(1);
  }
  const docs = readFolder(DOCS_DIR, ".md", ["README.md"]);
  const tests = readFolder(TESTS_DIR, ".test.ts", []);
  const result = checkRequirements({ docs, tests, exists: (path) => existsSync(join(ROOT, path)) });
  if (result.problems.length > 0) {
    for (const p of result.problems) console.error(formatProblem(p));
    process.exitCode = 1;
  } else {
    console.log(`${result.requirements} requirements in ${result.features} features checked`);
  }
}
