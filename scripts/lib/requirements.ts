// The logic of `npm run check:requirements` (docs/requirements/README.md, "Requirements are contracts"): every
// requirement row has a test with its name, every test has a row, and every named eval exists. Pure functions over file
// contents; `scripts/check-requirements.ts` reads the files.
import ts from "typescript";
import { ProblemKind, TableState } from "../../eval/lib/enums.js";

/** The header cells of a requirement table. */
const REQUIREMENT_COLUMNS = ["Name", "Contract", "Proof today", "Gap"];

/** The start of a Proof cell for a requirement whose test is still a todo. */
const TODO_PROOF = "To do";

/** The eval names of the "Proof today" column and the file of each, relative to the project root. */
export const EVAL_FILES: Record<string, string> = {
  "question test": "eval/questions/run.ts",
  "replay test": "eval/replay.ts",
  "relevance test": "eval/relevance.ts",
  "speed test": "eval/speed.ts",
  "correction test": "eval/corrections.ts",
  "benefit test": "eval/benefit.ts",
  "console timing": "scripts/console-timing.ts",
};

/** One failure of the check. */
export interface Problem {
  kind: ProblemKind;
  /** The doc or the test file, relative to the project root with forward slashes. */
  file: string;
  /** The requirement or test name; the feature name for a file-level problem. */
  name: string;
}

/** One requirement row. */
export interface RequirementRow {
  name: string;
  /** The "Proof today" cell, trimmed. */
  proof: string;
}

/** The inputs of the check: file contents by feature name, and the eval files that exist. */
export interface CheckInput {
  /** The text of `docs/requirements/<feature>.md`, by feature. */
  docs: Map<string, string>;
  /** The text of `__tests__/requirements/<feature>.test.ts`, by feature. */
  tests: Map<string, string>;
  /** Tells whether a file exists, given its path relative to the project root. */
  exists(path: string): boolean;
}

/** The outcome of the check. */
export interface CheckResult {
  problems: Problem[];
  /** The count of requirement rows in all docs. */
  requirements: number;
  /** The count of docs that have requirement rows. */
  features: number;
}

// The cells of a table line, trimmed; an escaped pipe stays inside its cell.
function splitCells(line: string): string[] {
  const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return inner.split(/(?<!\\)\|/).map((c) => c.trim());
}

/**
 * Reads the requirement rows of a doc: the rows of each table whose header is exactly Name, Contract, Proof today, Gap.
 *
 * @param markdown - the text of a requirements file
 * @returns the rows in file order; empty when the doc has no such table
 * @sideEffects none
 */
export function parseRequirementRows(markdown: string): RequirementRow[] {
  const rows: RequirementRow[] = [];
  let state = TableState.Outside;
  for (const line of markdown.split(/\r?\n/)) {
    if (!line.trimStart().startsWith("|")) {
      state = TableState.Outside;
      continue;
    }
    const cells = splitCells(line);
    switch (state) {
      case TableState.Outside: {
        const match =
          cells.length === REQUIREMENT_COLUMNS.length && REQUIREMENT_COLUMNS.every((c, i) => cells[i] === c);
        state = match ? TableState.Header : TableState.Other;
        break;
      }
      case TableState.Header:
        state = TableState.Rows;
        break;
      case TableState.Rows:
        rows.push({ name: cells[0] ?? "", proof: cells[2] ?? "" });
        break;
      case TableState.Other:
        break;
    }
  }
  return rows;
}

/** One test of a test file. */
export interface TestName {
  name: string;
  /** True for `it.todo` and `test.todo`: a name without a body. */
  todo: boolean;
}

const TEST_FUNCTIONS = new Set(["it", "test"]);

// Tells whether a callee is `it`, `test`, or a property of them such as `it.todo` or `test.only`; `todo` marks `.todo`.
function testCallee(expr: ts.Expression): { todo: boolean } | undefined {
  if (ts.isIdentifier(expr)) return TEST_FUNCTIONS.has(expr.text) ? { todo: false } : undefined;
  if (
    ts.isPropertyAccessExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    TEST_FUNCTIONS.has(expr.expression.text)
  ) {
    return { todo: expr.name.text === "todo" };
  }
  return undefined;
}

/**
 * Reads the names of the tests of a test file: the first argument of each call to `it` or `test` (and `.todo`,
 * `.only`, `.skip`) when it is a string literal without interpolation.
 *
 * @param source - the text of a TypeScript test file
 * @returns the names in file order, duplicates kept, each with whether it is a todo
 * @sideEffects none
 */
export function parseTestNames(source: string): TestName[] {
  const file = ts.createSourceFile("test.ts", source, ts.ScriptTarget.Latest, true);
  const names: TestName[] = [];
  const visit = (node: ts.Node): void => {
    const callee = ts.isCallExpression(node) ? testCallee(node.expression) : undefined;
    if (ts.isCallExpression(node) && callee !== undefined) {
      const first = node.arguments[0];
      if (first !== undefined && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))) {
        names.push({ name: first.text, todo: callee.todo });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return names;
}

// The names that occur more than once, each once.
function repeated(names: string[]): string[] {
  const seen = new Set<string>();
  const again = new Set<string>();
  for (const n of names) (seen.has(n) ? again : seen).add(n);
  return [...again];
}

// The problems of the "Eval:" cells of one doc.
function evalProblems(file: string, rows: RequirementRow[], exists: (path: string) => boolean): Problem[] {
  const problems: Problem[] = [];
  for (const row of rows) {
    const at = row.proof.indexOf("Eval:");
    if (at < 0) continue;
    const named = Object.keys(EVAL_FILES).filter((e) => row.proof.slice(at).includes(e));
    if (named.length === 0) problems.push({ kind: ProblemKind.UnknownEval, file, name: row.name });
    for (const e of named) {
      if (!exists(EVAL_FILES[e] ?? "")) problems.push({ kind: ProblemKind.MissingEval, file, name: row.name });
    }
  }
  return problems;
}

/**
 * Checks the requirement docs against the requirement tests.
 *
 * @param input - the contents of the docs and the tests by feature, and a file existence check
 * @returns the problems (empty on success) and the counts of requirements and features checked
 * @sideEffects calls `input.exists`
 */
export function checkRequirements(input: CheckInput): CheckResult {
  const problems: Problem[] = [];
  let requirements = 0;
  let features = 0;
  for (const [feature, markdown] of input.docs) {
    const docFile = `docs/requirements/${feature}.md`;
    const rows = parseRequirementRows(markdown);
    if (rows.length === 0) continue;
    features += 1;
    requirements += rows.length;
    const names = rows.map((r) => r.name);
    for (const name of repeated(names)) problems.push({ kind: ProblemKind.DuplicateRequirement, file: docFile, name });
    problems.push(...evalProblems(docFile, rows, (path) => input.exists(path)));
    const source = input.tests.get(feature);
    const testFile = `__tests__/requirements/${feature}.test.ts`;
    if (source === undefined) {
      problems.push({ kind: ProblemKind.MissingTestFile, file: testFile, name: feature });
      continue;
    }
    const parsed = parseTestNames(source);
    const tests = new Set(parsed.map((t) => t.name));
    for (const row of rows) {
      if (!tests.has(row.name)) continue;
      const wantTodo = row.proof.startsWith(TODO_PROOF);
      if (parsed.some((t) => t.name === row.name && t.todo === wantTodo)) continue;
      const kind = wantTodo ? ProblemKind.MissingTodo : ProblemKind.UnexpectedTodo;
      problems.push({ kind, file: testFile, name: row.name });
    }
    for (const name of new Set(names)) {
      if (!tests.has(name)) problems.push({ kind: ProblemKind.MissingTest, file: testFile, name });
    }
  }
  for (const [feature, source] of input.tests) {
    const testFile = `__tests__/requirements/${feature}.test.ts`;
    const names = parseTestNames(source).map((t) => t.name);
    for (const name of repeated(names)) problems.push({ kind: ProblemKind.DuplicateTest, file: testFile, name });
    const markdown = input.docs.get(feature);
    if (markdown === undefined) {
      problems.push({ kind: ProblemKind.MissingDoc, file: testFile, name: feature });
      continue;
    }
    const known = new Set(parseRequirementRows(markdown).map((r) => r.name));
    for (const name of new Set(names)) {
      if (!known.has(name)) problems.push({ kind: ProblemKind.MissingRequirement, file: testFile, name });
    }
  }
  if (features === 0) problems.push({ kind: ProblemKind.NoRequirements, file: "docs/requirements", name: "" });
  return { problems, requirements, features };
}

/**
 * Formats a problem as one line for the terminal.
 *
 * @param p - the problem to report
 * @returns `<file>: <kind>: "<name>"`, so a reader can open the file and search the name
 * @sideEffects none
 */
export function formatProblem(p: Problem): string {
  return `${p.file}: ${p.kind}: "${p.name}"`;
}
