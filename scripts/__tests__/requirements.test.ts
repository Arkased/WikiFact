import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { projectRoot } from "../../src/paths.js";
import { ProblemKind } from "../../eval/lib/enums.js";
import { EVAL_FILES, checkRequirements, parseRequirementRows, parseTestNames } from "../lib/requirements.js";
import type { CheckInput } from "../lib/requirements.js";

function doc(rows: string[][]): string {
  const lines = ["# Feature", "", "| Name | Contract | Proof today | Gap |", "| ---- | -------- | ----------- | --- |"];
  for (const r of rows) lines.push(`| ${r.join(" | ")} |`);
  return lines.join("\n");
}

function tests(...names: string[]): string {
  return names.map((n) => `it(${JSON.stringify(n)}, () => {});`).join("\n");
}

function input(over: Partial<CheckInput> = {}): CheckInput {
  return {
    docs: new Map([["lookup", doc([["Alpha", "c", "p", "None"]])]]),
    tests: new Map([["lookup", tests("Alpha")]]),
    exists: () => true,
    ...over,
  };
}

function kinds(i: CheckInput): ProblemKind[] {
  return checkRequirements(i).problems.map((p) => p.kind);
}

describe("checkRequirements with nothing to check", () => {
  it("fails when no doc holds a requirement", () => {
    expect(kinds(input({ docs: new Map(), tests: new Map() }))).toEqual([ProblemKind.NoRequirements]);
  });
});

describe("parseRequirementRows", () => {
  it("reads the rows of a padded table and ignores other tables", () => {
    const md = [
      "| Role | Human |",
      "| ---- | ----- |",
      "| Operator | yes |",
      "",
      "| Name     | Contract | Proof today | Gap  |",
      "| -------- | -------- | ----------- | ---- |",
      "| Alpha    | c        | Eval: x     | None |",
      "| Beta one | c        | p           | None |",
    ].join("\n");
    expect(parseRequirementRows(md).map((r) => r.name)).toEqual(["Alpha", "Beta one"]);
  });

  it("skips a table whose columns differ", () => {
    expect(parseRequirementRows("| Name | Contract | Gap |\n| - | - | - |\n| A | b | c |")).toEqual([]);
  });
});

describe("parseTestNames", () => {
  it("reads quoted names, todo calls and names with quotes or commas", () => {
    const src = [
      'it("double, comma", () => {});',
      "test('single', () => {});",
      "it.todo(`back tick`);",
      'test.todo("say \\"hi\\"");',
      "it(`has ${x}`, () => {});",
      "other('not a test');",
    ].join("\n");
    expect(parseTestNames(src)).toEqual([
      { name: "double, comma", todo: false },
      { name: "single", todo: false },
      { name: "back tick", todo: true },
      { name: 'say "hi"', todo: true },
    ]);
  });
});

describe("EVAL_FILES", () => {
  it("resolves every eval name to a file that exists", () => {
    for (const [name, file] of Object.entries(EVAL_FILES))
      expect(existsSync(join(projectRoot(), file)), name).toBe(true);
  });
});

describe("checkRequirements", () => {
  it("passes and counts requirements and features", () => {
    const r = checkRequirements(
      input({
        docs: new Map([
          [
            "lookup",
            doc([
              ["A", "c", "p", "None"],
              ["B", "c", "p", "None"],
            ]),
          ],
          ["submit", doc([["C", "c", "p", "None"]])],
        ]),
        tests: new Map([
          ["lookup", tests("A", "B")],
          ["submit", tests("C")],
        ]),
      }),
    );
    expect(r).toEqual({ problems: [], requirements: 3, features: 2 });
  });

  it("fails when a feature has rows and no test file", () => {
    expect(kinds(input({ tests: new Map() }))).toEqual([ProblemKind.MissingTestFile]);
  });

  it("fails when a requirement has no test, and when a test has no requirement", () => {
    const r = checkRequirements(input({ tests: new Map([["lookup", tests("Other")]]) }));
    expect(r.problems).toContainEqual(expect.objectContaining({ kind: ProblemKind.MissingTest, name: "Alpha" }));
    expect(r.problems).toContainEqual(expect.objectContaining({ kind: ProblemKind.MissingRequirement, name: "Other" }));
  });

  it("fails when a test file has no doc", () => {
    const tests2 = new Map([
      ["lookup", tests("Alpha")],
      ["ghost", tests("Z")],
    ]);
    expect(kinds(input({ tests: tests2 }))).toEqual([ProblemKind.MissingDoc]);
  });

  it("fails on a name twice in a doc or in a test file", () => {
    const twice = doc([
      ["Alpha", "c", "p", "None"],
      ["Alpha", "c", "p", "None"],
    ]);
    expect(kinds(input({ docs: new Map([["lookup", twice]]) }))).toEqual([ProblemKind.DuplicateRequirement]);
    expect(kinds(input({ tests: new Map([["lookup", tests("Alpha", "Alpha")]]) }))).toEqual([
      ProblemKind.DuplicateTest,
    ]);
  });

  it("fails on an Eval cell that names a missing eval or none", () => {
    const withProof = (proof: string, exists: boolean): CheckInput =>
      input({ docs: new Map([["lookup", doc([["Alpha", "c", proof, "None"]])]]), exists: () => exists });
    expect(kinds(withProof("Eval: the speed test.", false))).toEqual([ProblemKind.MissingEval]);
    expect(kinds(withProof("Eval: the mystery test.", true))).toEqual([ProblemKind.UnknownEval]);
    expect(kinds(withProof("Eval: the speed test.", true))).toEqual([]);
  });

  it("finds an Eval named after other text in the Proof cell", () => {
    const withProof = (proof: string, exists: boolean): CheckInput =>
      input({ docs: new Map([["lookup", doc([["Alpha", "c", proof, "None"]])]]), exists: () => exists });
    expect(kinds(withProof("The requirement test. Eval: the speed test.", false))).toEqual([ProblemKind.MissingEval]);
    expect(kinds(withProof("The requirement test. Eval: the mystery test.", true))).toEqual([ProblemKind.UnknownEval]);
    expect(kinds(withProof("The requirement test. Eval: the speed test.", true))).toEqual([]);
  });

  it("fails when a To do row has no todo test, or a done row has only a todo test", () => {
    const withProof = (proof: string, source: string): CheckInput =>
      input({
        docs: new Map([["lookup", doc([["Alpha", "c", proof, "None"]])]]),
        tests: new Map([["lookup", source]]),
      });
    const todo = 'it.todo("Alpha");';
    expect(kinds(withProof("To do in the requirement test.", todo))).toEqual([]);
    expect(kinds(withProof("To do in the requirement test.", tests("Alpha")))).toEqual([ProblemKind.MissingTodo]);
    expect(kinds(withProof("The requirement test.", tests("Alpha")))).toEqual([]);
    expect(kinds(withProof("The requirement test.", todo))).toEqual([ProblemKind.UnexpectedTodo]);
  });
});
