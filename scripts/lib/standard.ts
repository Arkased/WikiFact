// The logic of `npm run check:standard` (docs/code-standard.md, the `[script]` rules that read the files of the repo):
// no absolute local path, no to-do marker without an issue, no eval that starts a server from `dist/`, no README or
// `.env.example` line that names a script, a variable or a path that does not exist, and no `…md#anchor` link that does
// not resolve. Pure functions over file contents; `scripts/check-standard.ts` reads the files.
import { posix } from "node:path";
import { NPM_SCRIPT_GROUPS, NPM_UNGROUPED_SCRIPTS, StandardProblemKind } from "../../eval/lib/enums.js";

/** One text file of the repo. */
export interface RepoFile {
  /** The path relative to the project root, with forward slashes. */
  path: string;
  text: string;
}

/** The inputs of the check. */
export interface StandardInput {
  /** The tracked text files. */
  files: RepoFile[];
  /** Every tracked path, binary files included. */
  allPaths: string[];
  /** The names of the scripts of `package.json`. */
  npmScripts: string[];
}

/** One failure of the check. */
export interface StandardProblem {
  kind: StandardProblemKind;
  /** The file, relative to the project root. */
  file: string;
  /** The line of the failure, counted from 1. */
  line: number;
  /** What is wrong, in one phrase that names the offending text. */
  detail: string;
}

/** What the check reports. */
export interface StandardResult {
  problems: StandardProblem[];
  filesChecked: number;
}

/** The home folder of a user, on Windows (drive, `Users`, name) or on Unix (`Users` or `home`, name). */
const LOCAL_PATH =
  /[A-Za-z]:[\\/]+(?:Users|Documents and Settings)[\\/]+[^\\/\s"'`]+|(?<![\w.~-])\/(?:Users|home)\/[A-Za-z][\w.-]*\//;

// The marker word is built in two parts so that this file passes its own check.
const TODO_MARKER = new RegExp(`\\b${"TO"}${"DO"}\\b`);
const ISSUE_REFERENCE = /#\d+/;
const CODE_EXTENSIONS = [".ts", ".mjs", ".js", ".cjs", ".yml", ".yaml", ".sh", ".ps1"];

/** A server started from the built output: `dist/src/cli` or `"dist", "src"`. */
const DIST_SPAWN = /dist[\\/]+src[\\/]+cli|["']dist["']\s*,\s*["']src["']/;

const NPM_RUN = /\bnpm run ([\w:-]+)/g;
const NPM_BUILTIN_SCRIPTS = /\bnpm (test|start)\b/g;
const ENV_ASSIGNMENT = /^#?\s*([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)=/;
const ENV_IN_BACKTICKS = /`([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)`/g;
/** The folders of the repo whose paths README names; a path in README that starts with one must exist. */
const REPO_PATH = /(?<![\w/.~-])((?:src|eval|fakes|scripts|config|docs|reports|__tests__|wikis)\/[\w./@-]*)/g;
/** The characters after a path that make it a pattern, not a path: `eval/<test>`, `src/*.ts`, `{a,b}`. */
const PLACEHOLDER_AFTER_PATH = "<*{[";
const DOC_LINK = /([\w./@:-]+\.md)#([A-Za-z0-9_-]+)/g;
const SAME_FILE_LINK = /\]\(#([A-Za-z0-9_-]+)\)/g;
const SOURCE_EXTENSIONS = [".ts", ".mjs", ".js"];
const SOURCE_FOLDERS = ["src/", "eval/", "scripts/", "fakes/"];
const LINE_SPLIT = /\r?\n/;
const COMMENT_START = /^\s*(?:\/\/|\/\*|\*)/;

function hasExtension(path: string, extensions: string[]): boolean {
  return extensions.some((e) => path.endsWith(e));
}

function problem(kind: StandardProblemKind, file: string, index: number, detail: string): StandardProblem {
  return { kind, file, line: index + 1, detail };
}

/**
 * Finds the absolute paths of a local machine in a file.
 *
 * @param file - the file to read
 * @returns one problem per line that holds a user home folder
 * @sideEffects none
 */
export function findLocalPaths(file: RepoFile): StandardProblem[] {
  const out: StandardProblem[] = [];
  file.text.split(LINE_SPLIT).forEach((line, i) => {
    const m = LOCAL_PATH.exec(line);
    if (m) out.push(problem(StandardProblemKind.LocalPath, file.path, i, m[0]));
  });
  return out;
}

/**
 * Finds the to-do markers of a code file that name no issue.
 *
 * @param file - the file to read; a file that is not code gives no problem
 * @returns one problem per marker line without `#N`
 * @sideEffects none
 */
export function findBareTodos(file: RepoFile): StandardProblem[] {
  if (!hasExtension(file.path, CODE_EXTENSIONS)) return [];
  const out: StandardProblem[] = [];
  file.text.split(LINE_SPLIT).forEach((line, i) => {
    if (TODO_MARKER.test(line) && !ISSUE_REFERENCE.test(line)) {
      out.push(problem(StandardProblemKind.TodoWithoutIssue, file.path, i, line.trim()));
    }
  });
  return out;
}

/**
 * Finds the places where an eval file starts a server from `dist/`. Comment lines and tests are not read.
 *
 * @param file - the file to read; a file outside `eval/` gives no problem
 * @returns one problem per line that names the built entry point
 * @sideEffects none
 */
export function findDistSpawns(file: RepoFile): StandardProblem[] {
  if (
    !file.path.startsWith("eval/") ||
    file.path.includes("/__tests__/") ||
    !hasExtension(file.path, SOURCE_EXTENSIONS)
  ) {
    return [];
  }
  const out: StandardProblem[] = [];
  file.text.split(LINE_SPLIT).forEach((line, i) => {
    if (!COMMENT_START.test(line) && DIST_SPAWN.test(line)) {
      out.push(problem(StandardProblemKind.EvalSpawnsDist, file.path, i, line.trim()));
    }
  });
  return out;
}

/**
 * Tells whether a repo path exists as a tracked file or as a folder with a tracked file under it.
 *
 * @param path - the path relative to the project root; a trailing slash is allowed
 * @param allPaths - every tracked path
 * @returns true when the path names a tracked file or folder
 * @sideEffects none
 */
export function pathExists(path: string, allPaths: string[]): boolean {
  const bare = path.replace(/\/+$/, "");
  return allPaths.some((p) => p === bare || p.startsWith(`${bare}/`));
}

/**
 * Finds the references of README and `.env.example` that point to nothing: an npm script, an environment variable or
 * a repo path that does not exist.
 *
 * @param file - `README.md` or `.env.example`; any other file gives no problem
 * @param input - the repo, to look the names up in
 * @returns one problem per missing reference
 * @sideEffects none
 */
export function findMissingReferences(file: RepoFile, input: StandardInput): StandardProblem[] {
  if (file.path !== "README.md" && file.path !== ".env.example") return [];
  const sourceText = input.files
    .filter((f) => SOURCE_FOLDERS.some((d) => f.path.startsWith(d)) && hasExtension(f.path, SOURCE_EXTENSIONS))
    .map((f) => f.text)
    .join("\n");
  const out: StandardProblem[] = [];
  file.text.split(LINE_SPLIT).forEach((line, i) => {
    const scripts = [...line.matchAll(NPM_RUN), ...line.matchAll(NPM_BUILTIN_SCRIPTS)].map((m) => m[1] ?? "");
    for (const name of scripts) {
      if (!input.npmScripts.includes(name)) {
        out.push(problem(StandardProblemKind.MissingNpmScript, file.path, i, `npm run ${name}`));
      }
    }
    const vars = [...line.matchAll(ENV_IN_BACKTICKS)].map((m) => m[1] ?? "");
    const assigned = ENV_ASSIGNMENT.exec(line)?.[1];
    if (assigned !== undefined) vars.push(assigned);
    for (const name of vars) {
      if (!sourceText.includes(name)) out.push(problem(StandardProblemKind.MissingEnvVar, file.path, i, name));
    }
    for (const m of line.matchAll(REPO_PATH)) {
      const path = (m[1] ?? "").replace(/[.,;:]+$/, "");
      const next = line[(m.index ?? 0) + (m[1] ?? "").length] ?? "";
      if (PLACEHOLDER_AFTER_PATH.includes(next) || path.endsWith("/*")) continue;
      if (!pathExists(path, input.allPaths)) out.push(problem(StandardProblemKind.MissingPath, file.path, i, path));
    }
  });
  return out;
}

/**
 * Gives the anchors that the headings of a markdown file make, by the rule of GitHub: lower case, punctuation removed,
 * spaces to hyphens, a repeated heading numbered `-1`, `-2`. Headings in code fences are not headings.
 *
 * @param markdown - the text of the file
 * @returns the anchors in file order
 * @sideEffects none
 */
export function headingAnchors(markdown: string): string[] {
  const anchors: string[] = [];
  const seen = new Map<string, number>();
  let inFence = false;
  for (const line of markdown.split(LINE_SPLIT)) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    const m = inFence ? null : /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const base = (m[1] ?? "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/<[^>]+>/g, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "")
      .trim()
      .replace(/\s/g, "-");
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    anchors.push(n === 0 ? base : `${base}-${n}`);
  }
  return anchors;
}

// The candidate paths of a `…md` reference, first match wins: from the folder of the citing file (a markdown link), from
// the project root (`docs/…`), from `docs/` (a code comment that cites `technical/…`).
function docCandidates(from: string, target: string): string[] {
  const clean = target.replace(/^\.\//, "");
  return [posix.join(posix.dirname(from), clean), clean, posix.join("docs", clean)].map((p) => posix.normalize(p));
}

/**
 * Finds the `…md#anchor` links of a file that do not resolve: the markdown file is not in the repo, or no heading of
 * it gives the anchor. A `#anchor` link with no file is read against the headings of the file itself. A link to a URL
 * is not read.
 *
 * @param file - the file to read
 * @param input - the repo, to look the cited files up in
 * @returns one problem per broken link
 * @sideEffects none
 */
export function findBrokenAnchors(file: RepoFile, input: StandardInput): StandardProblem[] {
  const byPath = new Map(input.files.map((f) => [f.path, f]));
  const anchorsOf = (path: string): string[] => headingAnchors(byPath.get(path)?.text ?? "");
  const out: StandardProblem[] = [];
  file.text.split(LINE_SPLIT).forEach((line, i) => {
    for (const m of line.matchAll(DOC_LINK)) {
      const [, target = "", anchor = ""] = m;
      if (target.includes("://")) continue;
      const found = docCandidates(file.path, target).find((c) => byPath.has(c));
      if (found === undefined) {
        out.push(problem(StandardProblemKind.MissingDocFile, file.path, i, `${target}#${anchor}`));
      } else if (!anchorsOf(found).includes(anchor)) {
        out.push(problem(StandardProblemKind.MissingAnchor, file.path, i, `${target}#${anchor}`));
      }
    }
    if (!file.path.endsWith(".md")) return;
    for (const m of line.matchAll(SAME_FILE_LINK)) {
      const anchor = m[1] ?? "";
      if (!anchorsOf(file.path).includes(anchor)) {
        out.push(problem(StandardProblemKind.MissingAnchor, file.path, i, `#${anchor}`));
      }
    }
  });
  return out;
}

/** The form of a script name, or of its part after the group: lower case words joined by `-`. */
const SCRIPT_WORDS = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Finds the scripts of `package.json` whose name is outside the naming rule: one of the ungrouped names, or
 * `<group>:<name>` with a known group and a name of lower case words joined by `-`.
 *
 * @param npmScripts - the names of the scripts
 * @returns one problem per bad name, on `package.json`
 * @sideEffects none
 */
export function findBadScriptNames(npmScripts: string[]): StandardProblem[] {
  const problems: StandardProblem[] = [];
  for (const script of npmScripts) {
    if (NPM_UNGROUPED_SCRIPTS.includes(script)) continue;
    const [group, name, ...rest] = script.split(":");
    const grouped =
      group !== undefined && NPM_SCRIPT_GROUPS.includes(group) && rest.length === 0 && SCRIPT_WORDS.test(name ?? "");
    if (!grouped)
      problems.push(
        problem(
          StandardProblemKind.BadNpmScriptName,
          "package.json",
          0,
          `the script "${script}" is not an ungrouped name, nor <group>:<name> with the group in ${NPM_SCRIPT_GROUPS.join(", ")} and a name of lower case words joined by "-"`,
        ),
      );
  }
  return problems;
}

/**
 * Runs every check over the repo.
 *
 * @param input - the tracked files, their paths and the npm scripts
 * @returns the problems in file order, and the number of files read
 * @sideEffects none
 */
export function checkStandard(input: StandardInput): StandardResult {
  const problems: StandardProblem[] = findBadScriptNames(input.npmScripts);
  for (const file of input.files) {
    problems.push(
      ...findLocalPaths(file),
      ...findBareTodos(file),
      ...findDistSpawns(file),
      ...findMissingReferences(file, input),
      ...findBrokenAnchors(file, input),
    );
  }
  return { problems, filesChecked: input.files.length };
}

/**
 * Formats a problem as one line for the terminal.
 *
 * @param p - one failure of the check, with the file, the line, the kind and the offending text
 * @returns `file:line: kind: detail`
 * @sideEffects none
 */
export function formatStandardProblem(p: StandardProblem): string {
  return `${p.file}:${p.line}: ${p.kind}: ${p.detail}`;
}
