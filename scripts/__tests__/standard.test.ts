import { describe, expect, it } from "vitest";
import { StandardProblemKind } from "../../eval/lib/enums.js";
import {
  checkStandard,
  findBadScriptNames,
  findBareTodos,
  findBrokenAnchors,
  findDistSpawns,
  findLocalPaths,
  findMissingReferences,
  headingAnchors,
  pathExists,
  type RepoFile,
  type StandardInput,
} from "../lib/standard.js";

// The words that the check rejects are built here, so that this file passes its own check.
const HOME = ["C:", "Users", "someone", "project"].join("\\");
const UNIX_HOME = ["", "home", "someone", "project"].join("/");
const MARKER = ["TO", "DO"].join("");

// A markdown link target, built here so that this file's own text holds no link for the check to resolve.
const ref = (path: string, anchor: string): string => `${path}.md#${anchor}`;

const file = (path: string, text: string): RepoFile => ({ path, text });
const kinds = (problems: { kind: StandardProblemKind }[]): StandardProblemKind[] => problems.map((p) => p.kind);

function input(files: RepoFile[], over: Partial<StandardInput> = {}): StandardInput {
  return { files, allPaths: files.map((f) => f.path), npmScripts: ["check", "test"], ...over };
}

describe("findLocalPaths", () => {
  it("finds a Windows or Unix home folder and names its line", () => {
    const problems = findLocalPaths(file("a.ts", `ok\nconst p = "${HOME}";\nconst q = "${UNIX_HOME}/x";`));
    expect(problems.map((p) => p.line)).toEqual([2, 3]);
    expect(kinds(problems)).toEqual([StandardProblemKind.LocalPath, StandardProblemKind.LocalPath]);
  });

  it("passes a relative path and a path that is not a home folder", () => {
    expect(
      findLocalPaths(file("a.md", "see `src/env.ts`, ~/wikifact/wikis and /usr/bin/node and C:\\Program Files")),
    ).toEqual([]);
  });
});

describe("findBareTodos", () => {
  it("fails a marker with no issue reference", () => {
    expect(kinds(findBareTodos(file("a.ts", `// ${MARKER}: fix this`)))).toEqual([
      StandardProblemKind.TodoWithoutIssue,
    ]);
  });

  it("passes a marker with an issue reference, an identifier that holds the letters, and a file that is not code", () => {
    expect(findBareTodos(file("a.ts", `// ${MARKER} (#12): fix this`))).toEqual([]);
    expect(findBareTodos(file("a.ts", `const ${MARKER}_PROOF = 1;`))).toEqual([]);
    expect(findBareTodos(file("a.md", `${MARKER} list`))).toEqual([]);
  });
});

describe("findDistSpawns", () => {
  const spawn = `spawn("node", [join(root, "dist", "src", "cli.js"), "serve"]);`;

  it("fails an eval file that starts the built server", () => {
    expect(kinds(findDistSpawns(file("eval/replay.ts", spawn)))).toEqual([StandardProblemKind.EvalSpawnsDist]);
    expect(kinds(findDistSpawns(file("eval/lib/x.ts", "node dist/src/cli.js serve")))).toEqual([
      StandardProblemKind.EvalSpawnsDist,
    ]);
  });

  it("passes a comment, a test, and a file outside eval/", () => {
    expect(findDistSpawns(file("eval/replay.ts", "// it never runs dist/src/cli.js"))).toEqual([]);
    expect(findDistSpawns(file("eval/__tests__/a.test.ts", spawn))).toEqual([]);
    expect(findDistSpawns(file("scripts/mcp-client.ts", spawn))).toEqual([]);
  });
});

describe("pathExists", () => {
  it("accepts a tracked file and a folder with a tracked file under it, with or without a slash", () => {
    const all = ["src/env.ts", "docs/design/a.md"];
    expect(pathExists("src/env.ts", all)).toBe(true);
    expect(pathExists("docs/", all)).toBe(true);
    expect(pathExists("docs/design", all)).toBe(true);
    expect(pathExists("src/missing.ts", all)).toBe(false);
    expect(pathExists("sr", all)).toBe(false);
  });
});

describe("findMissingReferences", () => {
  const source = file("src/env.ts", 'export const NAME = "WIKIFACT_REAL";');
  const repo = (readme: string, extra: Partial<StandardInput> = {}): StandardInput =>
    input([source, file("README.md", readme)], extra);
  const check = (readme: string, extra: Partial<StandardInput> = {}) =>
    findMissingReferences(file("README.md", readme), repo(readme, extra));

  it("fails an npm script that package.json lacks", () => {
    expect(kinds(check("run `npm run gone` or npm run check"))).toEqual([StandardProblemKind.MissingNpmScript]);
    expect(kinds(check("npm test"))).toEqual([]);
    expect(kinds(check("npm test", { npmScripts: [] }))).toEqual([StandardProblemKind.MissingNpmScript]);
  });

  it("fails an environment variable that no source file mentions", () => {
    expect(check("`WIKIFACT_REAL` is read").length).toBe(0);
    expect(kinds(check("`WIKIFACT_GONE` is read"))).toEqual([StandardProblemKind.MissingEnvVar]);
  });

  it("reads the assigned variables of .env.example, commented or not", () => {
    const text = "# note\nWIKIFACT_REAL=\n# WIKIFACT_GONE=1\n";
    const example = file(".env.example", text);
    const problems = findMissingReferences(example, input([source, example]));
    expect(problems.map((p) => [p.kind, p.detail, p.line])).toEqual([
      [StandardProblemKind.MissingEnvVar, "WIKIFACT_GONE", 3],
    ]);
  });

  it("fails a repo path that does not exist, and skips a placeholder", () => {
    expect(check("see src/env.ts and [x](src/env.ts)")).toEqual([]);
    expect(kinds(check("see `src/gone.ts`."))).toEqual([StandardProblemKind.MissingPath]);
    expect(check("writes eval/results/<stamp>.json and src/*.ts and ~/wikifact/wikis/.backups/")).toEqual([]);
  });

  it("reads only README.md and .env.example", () => {
    const other = file("docs/a.md", "npm run gone");
    expect(findMissingReferences(other, input([other]))).toEqual([]);
  });
});

describe("headingAnchors", () => {
  it("makes the anchors of GitHub: lower case, no punctuation, hyphens, numbered repeats", () => {
    const md = ["# Title", "## The `store` API", "## Open settings", "### Open settings", "## Q&A: why?"].join("\n");
    expect(headingAnchors(md)).toEqual(["title", "the-store-api", "open-settings", "open-settings-1", "qa-why"]);
  });

  it("skips a heading inside a code fence and takes the text of a link", () => {
    const md = ["```", "# not a heading", "```", "## [Roles](x.md)"].join("\n");
    expect(headingAnchors(md)).toEqual(["roles"]);
  });
});

describe("findBrokenAnchors", () => {
  const doc = file("docs/technical/lookup.md", "# Lookup\n\n## Scores\n");
  const check = (citing: RepoFile, extra: RepoFile[] = []) => findBrokenAnchors(citing, input([doc, citing, ...extra]));

  it("passes a link whose heading exists, from a code comment, a markdown link and a docs path", () => {
    expect(check(file("src/a.ts", `// ${ref("technical/lookup", "scores")}`))).toEqual([]);
    expect(check(file("docs/design/a.md", `[x](${ref("../technical/lookup", "scores")})`))).toEqual([]);
    expect(check(file("src/b.ts", `// ${ref("docs/technical/lookup", "lookup")}`))).toEqual([]);
  });

  it("fails an anchor that no heading gives", () => {
    expect(kinds(check(file("src/a.ts", `// ${ref("technical/lookup", "gone")}`)))).toEqual([
      StandardProblemKind.MissingAnchor,
    ]);
  });

  it("fails a file that is not in the repo", () => {
    expect(kinds(check(file("src/a.ts", `// ${ref("technical/none", "scores")}`)))).toEqual([
      StandardProblemKind.MissingDocFile,
    ]);
  });

  it("resolves a link against the folder of the citing file before the project root", () => {
    const readme = file("docs/technical/README.md", "# Technical\n\n## Open settings\n");
    const root = file("README.md", "# Root\n");
    const citing = file("docs/technical/a.md", `see [x](${ref("README", "open-settings")})`);
    expect(findBrokenAnchors(citing, input([readme, root, citing]))).toEqual([]);
  });

  it("reads a link to a heading of the same file, and skips a URL", () => {
    expect(check(file("docs/a.md", "# A\n\n[x](#a) [y](#gone)"))).toHaveLength(1);
    expect(check(file("docs/b.md", "https://github.com/o/r/blob/build/docs/x.md#gone"))).toEqual([]);
  });
});

describe("findBadScriptNames", () => {
  it("passes the ungrouped names and a known group with a lower case name", () => {
    const names = ["build", "clean-temp", "check", "check:dead", "test:ui", "eval:reads-per-search", "demo:seed"];
    expect(findBadScriptNames(names)).toEqual([]);
  });

  it("fails a bad form, a bad group and an upper case name, and names each script", () => {
    const bad = ["bulk-test", "misc:run", "eval:Speed", "eval:a:b", "eval:", "format:check"];
    const problems = findBadScriptNames(bad);
    expect(kinds(problems)).toEqual(bad.map(() => StandardProblemKind.BadNpmScriptName));
    bad.forEach((name, i) => expect(problems[i]?.detail).toContain(`"${name}"`));
  });

  it("runs inside checkStandard", () => {
    const result = checkStandard(input([file("src/a.ts", "export const a = 1;")], { npmScripts: ["speed"] }));
    expect(kinds(result.problems)).toEqual([StandardProblemKind.BadNpmScriptName]);
  });
});

describe("checkStandard", () => {
  it("passes a clean repo and counts the files", () => {
    const result = checkStandard(input([file("src/a.ts", "export const a = 1;")]));
    expect(result.problems).toEqual([]);
    expect(result.filesChecked).toBe(1);
  });

  it("collects the problems of every rule", () => {
    const files = [file("src/a.ts", `// ${MARKER}\nconst p = "${HOME}";`), file("README.md", "npm run gone")];
    expect(kinds(checkStandard(input(files)).problems).sort()).toEqual(
      [
        StandardProblemKind.LocalPath,
        StandardProblemKind.MissingNpmScript,
        StandardProblemKind.TodoWithoutIssue,
      ].sort(),
    );
  });
});
