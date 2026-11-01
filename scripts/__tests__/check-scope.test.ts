import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChangeKind } from "../../eval/lib/enums.js";
import {
  describeScope,
  findProcessTests,
  MAX_SCOPED_LINE,
  parseChanges,
  readScope,
  resolveImport,
  scopeOf,
  stepsOf,
  valueImports,
  type FileChange,
} from "../lib/check-scope.js";
import { PROCESS_START_TIMEOUT_MS } from "../../__tests__/helpers/timeouts.js";

const present = (...paths: string[]): FileChange[] => paths.map((path) => ({ path, kind: ChangeKind.Present }));

describe("the scope of a change", () => {
  it("runs the tests that import a changed file, and no browser test, for a file under src/", () => {
    const scope = scopeOf(present("src/store/read.ts", "src/store/__tests__/read.test.ts"), false);
    expect(scope).toMatchObject({
      allTests: false,
      testFiles: ["src/store/read.ts", "src/store/__tests__/read.test.ts"],
      ui: false,
    });
    expect(stepsOf(scope)).toEqual([
      "typecheck",
      "lint",
      "check:format",
      "check:requirements",
      "check:standard",
      "check:dead",
      "check:plugin",
      "test:related -- src/store/read.ts src/store/__tests__/read.test.ts",
    ]);
  });

  it("runs the browser test for a change under the console or to the browser test", () => {
    expect(scopeOf(present("src/console/routes.ts"), false)).toMatchObject({ allTests: false, ui: true });
    expect(scopeOf(present("__tests__/console-ui.test.ts"), false)).toMatchObject({ allTests: false, ui: true });
    expect(stepsOf(scopeOf(present("src/console/routes.ts"), false))).toContain("test:ui");
  });

  it.each([
    "package.json",
    "package-lock.json",
    "vitest.config.ts",
    "vitest.ui.config.ts",
    "tsconfig.json",
    "tsconfig.client.json",
    "__tests__/setup.ts",
    "__tests__/global-setup.ts",
  ])("runs every test, and the browser test, for a change to %s", (path) => {
    const scope = scopeOf(present(path, "src/store/read.ts"), false);
    expect(scope).toMatchObject({ allTests: true, ui: true });
    expect(stepsOf(scope)).toEqual(expect.arrayContaining(["test", "test:ui"]));
    expect(stepsOf(scope).some((s) => s.startsWith("test:related"))).toBe(false);
  });

  it("runs every test for --full, with the same lint", () => {
    const scope = scopeOf([], true);
    expect(scope).toMatchObject({ allTests: true, ui: true });
    expect(stepsOf(scope)).toEqual([
      "typecheck",
      "lint",
      "check:format",
      "check:requirements",
      "check:standard",
      "check:dead",
      "check:plugin",
      "test",
      "test:ui",
    ]);
  });

  it("runs every test for a deleted code file, a data file, a spawned script and a long change", () => {
    expect(scopeOf([{ path: "src/old.ts", kind: ChangeKind.Gone }], false).allTests).toBe(true);
    expect(scopeOf(present("eval/benefit.json"), false).allTests).toBe(true);
    expect(scopeOf(present("__tests__/helpers/fake-eval.mjs"), false).allTests).toBe(true);
  });

  describe("the limit of the command line", () => {
    // A code path of exactly `length` characters.
    const pathOf = (length: number): string => `src/${"a".repeat(length - "src/.ts".length)}.ts`;

    it("keeps the scope at the limit and runs every test one character over", () => {
      expect(scopeOf(present(pathOf(MAX_SCOPED_LINE)), false).allTests).toBe(false);
      const over = scopeOf(present(pathOf(MAX_SCOPED_LINE + 1)), false);
      expect(over.allTests).toBe(true);
      expect(over.reason).toContain(`${MAX_SCOPED_LINE + 1} characters`);
      expect(over.reason).toContain("1 changed code files");
    });

    it("counts the process tests in the line: they can push a line that fits over the limit", () => {
      const processTest = "__tests__/p.test.ts";
      // The line is the changed path, a space and the process test.
      const room = MAX_SCOPED_LINE - processTest.length - 1;
      expect(scopeOf(present(pathOf(room)), false, [processTest]).allTests).toBe(false);
      const over = scopeOf(present(pathOf(room + 1)), false, [processTest]);
      expect(over.allTests).toBe(true);
      expect(over.reason).toContain("1 process tests");
      expect(scopeOf(present(pathOf(room + 1)), false).allTests).toBe(false);
    });
  });

  it("runs the same lint for the full check and the scoped check", () => {
    expect(stepsOf(scopeOf([], true))).toContain("lint");
    expect(stepsOf(scopeOf(present("src/a.ts"), false))).toContain("lint");
    expect(stepsOf(scopeOf(present("package.json"), false))).toContain("lint");
  });

  it("runs no test for a change to docs alone", () => {
    const scope = scopeOf(
      [...present("docs/design/updates.md", "README.md"), { path: "docs/old.md", kind: ChangeKind.Gone }],
      false,
    );
    expect(scope).toMatchObject({ allTests: false, testFiles: [], ui: false });
    expect(stepsOf(scope)).toEqual([
      "typecheck",
      "lint",
      "check:format",
      "check:requirements",
      "check:standard",
      "check:dead",
      "check:plugin",
    ]);
  });

  it("runs every process test beside the tests of the change, when a code file changed", () => {
    const processTests = ["__tests__/mcp/stdio.test.ts", "__tests__/console.test.ts"];
    expect(scopeOf(present("src/store/read.ts"), false, processTests).testFiles).toEqual([
      "src/store/read.ts",
      ...processTests,
    ]);
    // A change with no code file (docs) runs no test, process tests or not.
    const docs = scopeOf(present("docs/design/updates.md", "README.md"), false, processTests);
    expect(docs).toMatchObject({ allTests: false, testFiles: [] });
    expect(stepsOf(docs).some((step) => step.startsWith("test"))).toBe(false);
    // A process test that is itself changed runs once.
    expect(scopeOf(present(processTests[0] ?? ""), false, processTests).testFiles).toEqual(processTests);
    expect(stepsOf(scopeOf(present("src/a.ts"), false, processTests))).toContain(
      "test:related -- src/a.ts __tests__/mcp/stdio.test.ts __tests__/console.test.ts",
    );
  });

  it("says in one line what runs", () => {
    expect(describeScope(scopeOf(present("src/a.ts"), false))).toBe(
      "the tests of the change; all files linted (1 changed files: 1 code files and 0 process tests for the tests)",
    );
    expect(describeScope(scopeOf([], true))).toBe("all tests and the browser test; all files linted (--full)");
  });
});

describe("the value imports of a file", () => {
  it("reads static, re-exported, required and dynamic imports with a string literal", () => {
    const text = [
      'import a from "./a.js";',
      'import "./side.js";',
      'export { b } from "./b.js";',
      'export * from "./c.js";',
      'import d = require("./d.js");',
      'const e = require("./e.js");',
      'const f = await import("./f.js");',
      'import { g } from "some-package";',
      'import { execa } from "execa";',
    ].join("\n");
    expect(valueImports("x.ts", text)).toEqual({
      relative: ["./a.js", "./side.js", "./b.js", "./c.js", "./d.js", "./e.js", "./f.js"],
      spawns: true,
    });
    expect(valueImports("x.ts", 'import cp from "node:child_process";').spawns).toBe(true);
    expect(valueImports("x.mjs", 'const cp = await import("child_process");').spawns).toBe(true);
  });

  it("counts a package that starts a process by itself: the MCP stdio client, fkill, pid-port, ps-list", () => {
    for (const name of ["@modelcontextprotocol/sdk/client/stdio.js", "fkill", "pid-port", "ps-list"])
      expect(valueImports("x.ts", `import x from "${name}";`).spawns).toBe(true);
    expect(valueImports("x.ts", 'import { Client } from "@modelcontextprotocol/sdk/client/index.js";').spawns).toBe(
      false,
    );
  });

  it("finds the source file, the file as named, or the index of a folder, for a relative import", () => {
    const has =
      (...paths: string[]) =>
      (p: string) =>
        paths.includes(p);
    expect(resolveImport("a/b.ts", "./c.js", has("a/c.ts", "a/c.js"))).toBe("a/c.ts");
    expect(resolveImport("a/b.ts", "./c.mjs", has("a/c.mjs"))).toBe("a/c.mjs");
    expect(resolveImport("a/b.ts", "./c", has("a/c.ts"))).toBe("a/c.ts");
    expect(resolveImport("a/b.ts", "./c", has("a/c/index.ts"))).toBe("a/c/index.ts");
    expect(resolveImport("a/b.ts", "./c.js", has())).toBeUndefined();
  });

  it("skips a type-only import, a type-only export, a type position and a run-time specifier", () => {
    const text = [
      'import type { A } from "./a.js";',
      'import { type B, type C } from "./b.js";',
      'export type { D } from "./d.js";',
      'export { type E } from "./e.js";',
      'import type { ChildProcess } from "node:child_process";',
      'type F = typeof import("./f.js");',
      "const g = await import(path);",
      "const h = require(`./${name}.js`);",
    ].join("\n");
    expect(valueImports("x.ts", text)).toEqual({ relative: [], spawns: false });
  });

  it("keeps an import with one value specifier beside type ones, and one with a default", () => {
    const text = 'import { type A, b } from "./a.js";\nimport c, { type D } from "./c.js";';
    expect(valueImports("x.ts", text).relative).toEqual(["./a.js", "./c.js"]);
  });
});

describe("the changes of git", () => {
  it("reads a status list and the untracked files, and counts a path once", () => {
    expect(parseChanges("M\0src/a.ts\0D\0src/b.ts\0A\0src/c.ts\0", "src/c.ts\0src/d.ts\0")).toEqual([
      { path: "src/a.ts", kind: ChangeKind.Present },
      { path: "src/b.ts", kind: ChangeKind.Gone },
      { path: "src/c.ts", kind: ChangeKind.Present },
      { path: "src/d.ts", kind: ChangeKind.Present },
    ]);
    expect(parseChanges("", "")).toEqual([]);
  });

  // The one case with a real git: a committed change, an uncommitted one and an untracked file since the merge base.
  it(
    "reads the change since the merge base with build, committed or not",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "check-scope-"));
      const git = (...args: string[]): Promise<unknown> =>
        execa("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir });
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
      writeFileSync(join(dir, "src", "b.ts"), "export const b = 1;\n");
      await git("init", "-q", "-b", "build");
      await git("add", "-A");
      await git("commit", "-q", "-m", "base");
      await git("checkout", "-q", "-b", "work");
      writeFileSync(join(dir, "src", "a.ts"), "export const a = 2;\n");
      await git("commit", "-q", "-am", "committed change");
      writeFileSync(join(dir, "src", "b.ts"), "export const b = 2;\n");
      writeFileSync(join(dir, "src", "c.ts"), "export const c = 1;\n");
      const scope = await readScope(false, dir);
      expect(scope.allTests).toBe(false);
      expect([...scope.testFiles].sort()).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
      expect((await readScope(true, dir)).allTests).toBe(true);
    },
    PROCESS_START_TIMEOUT_MS,
  );

  // A test is a process test when its value imports reach a module that imports a process module; a type-only import
  // does not count, and the lookup is the same whatever the test does with the module.
  it(
    "finds the tests whose value imports reach a process module",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "check-scope-spawn-"));
      const put = (path: string, text: string): void => {
        mkdirSync(join(dir, path, ".."), { recursive: true });
        writeFileSync(join(dir, path), text);
      };
      put("src/entry.ts", 'import { execa } from "execa";\nexport const run = execa;\n');
      put("src/lib/index.ts", 'export { run } from "../entry.js";\n');
      put("src/typed.ts", 'import type { run } from "./entry.js";\nexport type Run = typeof run;\n');
      put("src/plain.ts", "export const plain = 1;\n");
      put("src/__tests__/direct.test.ts", 'import { spawn } from "node:child_process";\nexport { spawn };\n');
      put("src/__tests__/deep.test.ts", 'import { run } from "../lib/index.js";\nexport { run };\n');
      put("src/__tests__/helpers/boot.mjs", 'import { fork } from "child_process";\nexport const boot = fork;\n');
      put("src/__tests__/via-mjs.test.ts", 'import { boot } from "./helpers/boot.mjs";\nexport { boot };\n');
      put("src/__tests__/lazy.test.ts", 'export const load = () => import("../entry.js");\n');
      put("src/__tests__/required.test.ts", 'const { run } = require("../entry.js");\nexport { run };\n');
      put("src/__tests__/type-only.test.ts", 'import type { run } from "../entry.js";\nexport type R = typeof run;\n');
      put("src/__tests__/type-spec.test.ts", 'import { type run } from "../entry.js";\nexport type R = typeof run;\n');
      put("src/__tests__/export-type.test.ts", 'export type { run } from "../entry.js";\n');
      put("src/__tests__/typed-module.test.ts", 'import { type Run } from "../typed.js";\nexport type R = Run;\n');
      put("src/__tests__/plain.test.ts", 'import { plain } from "../plain.js";\nexport { plain };\n');
      put("src/__tests__/cycle-a.test.ts", 'import "./cycle-b.test.js";\n');
      put("src/__tests__/cycle-b.test.ts", 'import "./cycle-a.test.js";\n');
      put("__tests__/console-ui.test.ts", 'import { execa } from "execa";\nexport { execa };\n');
      const git = (...args: string[]): Promise<unknown> =>
        execa("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir });
      await git("init", "-q", "-b", "build");
      await git("add", "-A");
      expect(await findProcessTests(dir)).toEqual([
        "src/__tests__/deep.test.ts",
        "src/__tests__/direct.test.ts",
        "src/__tests__/lazy.test.ts",
        "src/__tests__/required.test.ts",
        "src/__tests__/via-mjs.test.ts",
      ]);
    },
    PROCESS_START_TIMEOUT_MS,
  );

  afterEach(() => vi.unstubAllEnvs());

  it("runs every test when git cannot name the change", async () => {
    const dir = mkdtempSync(join(tmpdir(), "check-scope-nogit-"));
    // The test temp folder can sit inside a git work tree; the ceiling keeps git from looking above `dir`.
    vi.stubEnv("GIT_CEILING_DIRECTORIES", dirname(dir));
    const scope = await readScope(false, dir);
    expect(scope.allTests).toBe(true);
    expect(scope.reason).toContain("could not be read from git");
  });
});
