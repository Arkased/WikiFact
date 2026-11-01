import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BenefitGroup, BenefitKind, Complexity, GroupChoice, KindChoice, QuestionType } from "../../lib/enums.js";
import {
  checkBalance,
  checkCases,
  loadCases,
  parseCases,
  selectCases,
  taskFolder,
  type BenefitCase,
} from "../cases.js";

const question = (over: Record<string, unknown>) => ({
  id: "q",
  kind: BenefitKind.Question,
  group: BenefitGroup.Held,
  type: QuestionType.Locate,
  complexity: Complexity.Simple,
  question: "Where?",
  answer: "Here.",
  answerContains: ["here"],
  proof: [{ file: "a.ts", line: 1 }],
  ...over,
});

describe("the cases file", () => {
  it("names the case that does not match the schema", () => {
    expect(() => parseCases(JSON.stringify([question({ id: "bad", complexity: "medium" })]))).toThrow(/bad/);
  });

  it("flags a stale case with no staleFact, and a staleFact on a case that is not stale", () => {
    const stale = parseCases(JSON.stringify([question({ id: "stale-case", group: BenefitGroup.Stale })]));
    expect(checkCases(stale).map((p) => p.includes("stale-case"))).toEqual([true]);
    const held = parseCases(JSON.stringify([question({ id: "held-case", staleFact: { header: "h", content: "c" } })]));
    expect(checkCases(held).map((p) => p.includes("held-case"))).toEqual([true]);
  });

  it("flags a stale task whose staleFact has no justification", () => {
    const task = (justification?: string) => ({
      id: "stale-task",
      kind: BenefitKind.Task,
      taskType: "feature",
      group: BenefitGroup.Stale,
      issue: "Do it.",
      hiddenTests: ["a.test.ts"],
      referencePatch: "reference.patch",
      staleFact: { header: "h", content: "c", ...(justification ? { justification } : {}) },
    });
    expect(checkCases(parseCases(JSON.stringify([task()])))).toHaveLength(1);
    expect(checkCases(parseCases(JSON.stringify([task("Stated in a.ts at line 1.")])))).toEqual([]);
  });

  it("flags an id used twice", () => {
    const twice = parseCases(JSON.stringify([question({ id: "dup-case" }), question({ id: "dup-case" })]));
    expect(checkCases(twice).map((p) => p.includes("dup-case"))).toEqual([true]);
  });

  it("asks each group of questions for 1 simple and 1 complex question of each type", () => {
    const all: unknown[] = [];
    for (const type of Object.values(QuestionType))
      for (const complexity of Object.values(Complexity))
        all.push(question({ id: `${type}-${complexity}`, type, complexity }));
    expect(checkBalance(parseCases(JSON.stringify(all)))).toEqual([]);
    expect(checkBalance(parseCases(JSON.stringify(all.slice(1))))).toHaveLength(1);
  });

  it("accepts a file of any size, as long as its cases are sound", () => {
    expect(checkCases(parseCases(JSON.stringify([question({})])))).toEqual([]);
  });

  it("accepts the shipped file, and its questions are balanced", () => {
    const cases = loadCases(join("eval", "benefit.json"));
    expect(checkBalance(cases)).toEqual([]);
  });

  it("keeps the task files next to the cases file, in a folder named as the file", () => {
    expect(taskFolder(join("eval", "benefit.json"), "t1")).toBe(join("eval", "benefit", "tasks", "t1"));
  });
});

describe("selectCases", () => {
  it("filters by kind and group, then limits", () => {
    const cases = parseCases(
      JSON.stringify([
        question({ id: "held" }),
        question({ id: "gap", group: BenefitGroup.Gap }),
        question({ id: "stale", group: BenefitGroup.Stale, staleFact: { header: "h", content: "c" } }),
        {
          id: "task",
          kind: BenefitKind.Task,
          taskType: "feature",
          group: BenefitGroup.Held,
          issue: "Do it.",
          hiddenTests: ["a.test.ts"],
          referencePatch: "reference.patch",
        },
      ]),
    );
    const ids = (cs: BenefitCase[]): string[] => cs.map((c) => c.id);
    const all = { kind: KindChoice.All, group: GroupChoice.All };
    expect(ids(selectCases(cases, all))).toEqual(["held", "gap", "stale", "task"]);
    expect(ids(selectCases(cases, { ...all, kind: KindChoice.Task }))).toEqual(["task"]);
    expect(ids(selectCases(cases, { ...all, group: GroupChoice.Stale }))).toEqual(["stale"]);
    expect(ids(selectCases(cases, { ...all, group: GroupChoice.Held }))).toEqual(["held", "task"]);
    expect(ids(selectCases(cases, { ...all, limit: 2 }))).toEqual(["held", "gap"]);
  });
});
