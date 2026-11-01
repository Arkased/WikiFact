// The scope of `npm run check` (docs/code-standard.md#6-tools): which tests a change needs. The
// default check runs the tests that import a changed file (`vitest related`) and, when at least 1 code file changed,
// every process test: a test whose value imports reach `child_process`, `node:child_process`, `execa`, or a package in
// `PROCESS_MODULES`. A change with no code file, no data file and no deleted file (docs only) runs no test. `--full` and a change to a config file run all tests.
// Lint (no cache), the typecheck and the other steps always cover the whole repo.
import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { execa } from "execa";
import ts from "typescript";
import { ChangeKind } from "../../eval/lib/enums.js";
import { errorMessage } from "../../src/must.js";

/** The fields of one entry of `git diff --name-status -z`: the status, then the path. */
const FIELDS_PER_ENTRY = 2;

/** One changed file. */
export interface FileChange {
  /** The path relative to the project root, with forward slashes. */
  path: string;
  /** What happened to the file. */
  kind: ChangeKind;
}

/** The runs a change needs. */
export interface CheckScope {
  /** True when every test runs. */
  allTests: boolean;
  /** The changed code files and the process tests to hand to `vitest related`, when `allTests` is false; empty means no unit test runs. */
  testFiles: string[];
  /** True when the browser test runs. */
  ui: boolean;
  /** One line for the reader: why the scope is what it is. */
  reason: string;
}

/**
 * The most characters of test file paths handed to `vitest related` on a command line; more makes the run full. The line
 * of cmd.exe is limited to 8191 characters, and the process tests (about 3,700) always take a part of it.
 */
export const MAX_SCOPED_LINE = 7000;

/** The files whose change can alter any test: they run every test. */
const TEST_GLOBAL = [
  /^package(-lock)?\.json$/,
  /^vitest(\.ui)?\.config\.ts$/,
  /^tsconfig[^/]*\.json$/,
  /^__tests__\/(setup|global-setup)\.ts$/,
];

/** The folders whose non-code files (JSON data, fixtures) the tests read by path, so that no import graph shows it. */
const DATA_FOLDERS = ["src/", "eval/", "fakes/", "scripts/", "__tests__/", "config/"];

/** The browser test: it has its own config and step. */
const UI_TEST = "__tests__/console-ui.test.ts";

/** The paths whose change runs the browser test. */
const UI_PATHS = [/^src\/console\//, /^__tests__\/console-ui\.test\.ts$/];

/** The source files whose imports are read. */
const READABLE_CODE = /\.(ts|mts|js|mjs)$/;

/** Code that `vitest related` follows by its imports. */
const IMPORTED_CODE = /\.(ts|mts)$/;

/** Code that a test starts as a process (fake children, helper scripts): no import shows the test that uses it. */
const SPAWNED_CODE = /\.(mjs|js)$/;

/** The code files that ESLint checks; a change to one of them is code, not data. */
const LINTED_CODE = /\.(ts|mts|mjs|js)$/;

const anyMatch = (patterns: RegExp[], path: string): boolean => patterns.some((p) => p.test(path));

/**
 * Parses the output of `git diff --name-status -z --no-renames` and `git ls-files --others -z` into changes.
 *
 * @param nameStatus - the NUL-separated `status`, `path` pairs of the diff
 * @param untracked - the NUL-separated paths of the files git does not track yet
 * @returns one change per path; a path in both lists counts once
 * @sideEffects none
 */
export function parseChanges(nameStatus: string, untracked: string): FileChange[] {
  const byPath = new Map<string, FileChange>();
  const fields = nameStatus.split("\0").filter((f) => f !== "");
  for (let i = 0; i + 1 < fields.length; i += FIELDS_PER_ENTRY) {
    const status = fields[i] ?? "";
    const path = fields[i + 1] ?? "";
    byPath.set(path, { path, kind: status.startsWith("D") ? ChangeKind.Gone : ChangeKind.Present });
  }
  for (const path of untracked.split("\0").filter((f) => f !== ""))
    byPath.set(path, { path, kind: ChangeKind.Present });
  return [...byPath.values()];
}

/**
 * Decides which tests a change needs.
 *
 * @param changes - the files changed since the merge base with `build`, committed or not
 * @param full - true for `npm run check -- --full`: every test
 * @param processTests - the tests that can start a process (`findProcessTests`); they run when at least 1 code file changed
 * @returns the scope
 * @sideEffects none
 */
export function scopeOf(changes: FileChange[], full: boolean, processTests: string[] = []): CheckScope {
  if (full) return everything("--full");
  const paths = changes.map((c) => c.path);
  const global = paths.find((p) => anyMatch(TEST_GLOBAL, p));
  const gone = changes.find((c) => c.kind === ChangeKind.Gone && posix.extname(c.path) !== ".md");
  const data = paths.find(
    (p) => !LINTED_CODE.test(p) && posix.extname(p) !== ".md" && DATA_FOLDERS.some((f) => p.startsWith(f)),
  );
  const spawned = paths.find((p) => SPAWNED_CODE.test(p) && p !== "eslint.config.js");
  const present = changes.filter((c) => c.kind === ChangeKind.Present).map((c) => c.path);
  const changedCode = present.filter((p) => IMPORTED_CODE.test(p));
  // The process tests prove the code that a change touched; a change with no code file (docs) runs none.
  const testFiles = changedCode.length > 0 ? [...new Set([...changedCode, ...processTests])] : [];
  const line = testFiles.join(" ").length;
  const why =
    global !== undefined
      ? `${global} changed`
      : gone !== undefined
        ? `${gone.path} was deleted`
        : data !== undefined
          ? `${data} is data that tests read by path`
          : spawned !== undefined
            ? `${spawned} is started as a process by tests`
            : line > MAX_SCOPED_LINE
              ? `the test paths of ${changedCode.length} changed code files and ${processTests.length} process tests take ${line} characters, over the ${MAX_SCOPED_LINE} of one command line`
              : undefined;
  const ui = paths.some((p) => anyMatch(UI_PATHS, p));
  if (why !== undefined) return { allTests: true, testFiles: [], ui: true, reason: why };
  return {
    allTests: false,
    testFiles,
    ui,
    reason: `${paths.length} changed files: ${changedCode.length} code files and ${testFiles.length > 0 ? processTests.length : 0} process tests for the tests${ui ? ", the browser test" : ""}`,
  };
}

function everything(reason: string): CheckScope {
  return { allTests: true, testFiles: [], ui: true, reason };
}

/** The branch whose merge base with HEAD starts the change that the check covers. */
const BASE_BRANCH = "build";

const isFileSync = (path: string): boolean => statSync(path, { throwIfNoEntry: false })?.isFile() === true;

/** The modules whose import lets a file start a process. */
const PROCESS_MODULES = new Set([
  ...["node:child_process", "child_process", "execa"],
  // Packages of the repo that start a process themselves (read in their sources): the MCP SDK stdio client, fkill and
  // pid-port (through execa) and ps-list (through child_process).
  ...["@modelcontextprotocol/sdk/client/stdio.js", "fkill", "pid-port", "ps-list"],
]);

// A test file that vitest runs; the browser test has its own config and step.
const isUnitTest = (path: string): boolean =>
  path.includes("__tests__/") &&
  path.endsWith(".test.ts") &&
  !path.startsWith(".claude/worktrees/") &&
  path !== UI_TEST;

/** What one source file imports by value. */
export interface ValueImports {
  /** The relative specifiers, to resolve against the file. */
  relative: string[];
  /** True when the file imports a process module. */
  spawns: boolean;
}

const stringArgument = (call: ts.CallExpression): string | undefined => {
  const arg = call.arguments[0];
  return arg !== undefined && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))
    ? arg.text
    : undefined;
};

const allTypeOnly = (elements: readonly { isTypeOnly: boolean }[]): boolean =>
  elements.length > 0 && elements.every((e) => e.isTypeOnly);

/**
 * Reads the modules a source file imports by value, from its syntax tree: a static `import`, an `export … from`, a
 * `require("…")` and an `import("…")` with a string literal. An `import type`, an `export type`, a declaration whose
 * specifiers are all `type` and an `import("…")` in a type position are not read: they leave no import at run time.
 *
 * @param fileName - the path of the file, for the language of its extension
 * @param text - the source text
 * @returns the relative specifiers, and whether a process module is among the imports
 * @sideEffects none
 */
export function valueImports(fileName: string, text: string): ValueImports {
  const kind = /\.(m?js)$/.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false, kind);
  const found: ValueImports = { relative: [], spawns: false };
  const add = (specifier: string | undefined): void => {
    if (specifier === undefined) return;
    if (PROCESS_MODULES.has(specifier)) found.spawns = true;
    else if (specifier.startsWith(".")) found.relative.push(specifier);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const typeOnly =
        clause !== undefined &&
        (clause.isTypeOnly ||
          (clause.name === undefined &&
            bindings !== undefined &&
            ts.isNamedImports(bindings) &&
            allTypeOnly(bindings.elements)));
      if (!typeOnly && ts.isStringLiteral(node.moduleSpecifier)) add(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node)) {
      const typeOnly =
        node.isTypeOnly ||
        (node.exportClause !== undefined &&
          ts.isNamedExports(node.exportClause) &&
          allTypeOnly(node.exportClause.elements));
      if (!typeOnly && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier))
        add(node.moduleSpecifier.text);
    } else if (ts.isImportEqualsDeclaration(node)) {
      const ref = node.moduleReference;
      if (!node.isTypeOnly && ts.isExternalModuleReference(ref) && ts.isStringLiteral(ref.expression))
        add(ref.expression.text);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require"))
        add(stringArgument(node));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/**
 * Finds the unit tests that can start a process: the closure of the value imports of the test, through relative imports of
 * project files, reaches a module that imports `child_process`, `node:child_process` or `execa`, or a package of `PROCESS_MODULES` that
 * spawns by itself (the MCP SDK stdio client, `fkill`, `pid-port`, `ps-list`). The closure follows
 * the same files whatever the test does with them, so it is a superset of the tests that do start one.
 *
 * @param cwd - the project root
 * @returns the paths of the tests, relative to `cwd`, sorted
 * @sideEffects runs `git ls-files` in `cwd`; reads the test files and the sources they reach
 */
export async function findProcessTests(cwd: string): Promise<string[]> {
  const listed = await execa("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd });
  const tests = listed.stdout.split("\0").filter(isUnitTest);
  const modules = new Map<string, ValueImports>();
  const read = async (path: string): Promise<ValueImports> => {
    const known = modules.get(path);
    if (known !== undefined) return known;
    // Data that a module imports (JSON) has no imports.
    const found = READABLE_CODE.test(path)
      ? valueImports(path, await readFile(join(cwd, path), "utf8"))
      : { relative: [], spawns: false };
    modules.set(path, found);
    return found;
  };
  const out: string[] = [];
  for (const test of tests) {
    const seen = new Set<string>();
    const queue = [test];
    let spawns = false;
    for (let path = queue.pop(); path !== undefined && !spawns; path = queue.pop()) {
      if (seen.has(path)) continue;
      seen.add(path);
      const imports = await read(path);
      spawns = imports.spawns;
      for (const specifier of imports.relative) {
        const next = resolveImport(path, specifier, (p) => isFileSync(join(cwd, p)));
        if (next !== undefined) queue.push(next);
      }
    }
    if (spawns) out.push(test);
  }
  return out.sort();
}

/**
 * Finds the file that a relative import names: `./x.js` is the source `x.ts` when that exists, else the file as named
 * (a `.js` or `.mjs` helper), then `x.ts`, then the `index.ts` of a folder.
 *
 * @param from - the path of the importing file, from the project root
 * @param specifier - the relative specifier of the import
 * @param exists - tells whether a path from the project root is a file of the project
 * @returns the path of the file, or undefined when no candidate exists
 * @sideEffects whatever `exists` does
 */
export function resolveImport(from: string, specifier: string, exists: (path: string) => boolean): string | undefined {
  const base = posix.join(posix.dirname(from), specifier);
  const candidates = [base.replace(/\.(m?)js$/, ".$1ts"), base, `${base}.ts`, `${base}/index.ts`];
  return candidates.find(exists);
}

/**
 * Reads the scope of the change from git: the files that differ from the merge base with `build`, committed or not.
 * A check that cannot ask git runs the full scope.
 *
 * @param full - true when `--full` was given
 * @param cwd - the project root
 * @returns the scope
 * @sideEffects runs `git merge-base`, `git diff` and `git ls-files` in `cwd`; reads the process tests
 */
export async function readScope(full: boolean, cwd: string): Promise<CheckScope> {
  if (full) return everything("--full");
  try {
    const base = (await execa("git", ["merge-base", "HEAD", BASE_BRANCH], { cwd })).stdout.trim();
    const diff = await execa("git", ["diff", "--no-renames", "--name-status", "-z", base], { cwd });
    const others = await execa("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd });
    return scopeOf(parseChanges(diff.stdout, others.stdout), false, await findProcessTests(cwd));
  } catch (error) {
    return everything(`the change could not be read from git (${errorMessage(error)})`);
  }
}

/**
 * Says in one line what a scope runs and why.
 *
 * @param scope - the scope
 * @returns the line for the reader
 * @sideEffects none
 */
export function describeScope(scope: CheckScope): string {
  const tests = scope.allTests ? "all tests" : scope.testFiles.length > 0 ? "the tests of the change" : "no test";
  return `${tests}${scope.ui ? " and the browser test" : ""}; all files linted (${scope.reason})`;
}

/**
 * Lists the npm scripts that the check runs at the same time, with their arguments, for `run-p`.
 *
 * @param scope - the scope of the change
 * @returns the tasks: the whole-repo steps always, and the tests and the browser test by the scope
 * @sideEffects none
 */
export function stepsOf(scope: CheckScope): string[] {
  const steps = [
    "typecheck",
    "lint",
    "check:format",
    "check:requirements",
    "check:standard",
    "check:dead",
    "check:plugin",
  ];
  if (scope.allTests) steps.push("test");
  else if (scope.testFiles.length > 0) steps.push(`test:related -- ${scope.testFiles.join(" ")}`);
  if (scope.ui) steps.push("test:ui");
  return steps;
}
