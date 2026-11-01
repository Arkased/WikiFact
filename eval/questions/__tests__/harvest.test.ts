import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { QuestionId } from "../../../src/domain/enums.js";
import { callLogFiles, harvest, parseIntegerOption, stableJson, type HarvestFile } from "../harvest.js";
import { sample } from "../../lib/sample.js";
import { expandInput, loadSet } from "../sets.js";

const tmp = (): string => mkdtempSync(join(tmpdir(), "qharv-"));

// One question_call line.
const line = (input: unknown, extra: Record<string, unknown> = {}, question: string = QuestionId.Q2): string =>
  JSON.stringify({
    ts: "2026-10-12T10:00:00.000Z",
    level: "info",
    event: "question_call",
    requestId: "R1",
    question,
    model: "claude-sonnet-5-5",
    effort: "low",
    input,
    ctx: { subject: "s" },
    output: { matches: [] },
    ...extra,
  });

function run(logs: string, o: { sample?: number; seed?: number } = {}): { file: HarvestFile; path: string } {
  return harvest({ question: QuestionId.Q2, logs, outDir: join(logs, "out"), print: () => undefined, ...o });
}

describe("harvest", () => {
  it("stable JSON ignores the key order", () => {
    expect(stableJson({ a: 1, b: { c: [1, { e: 1, d: 2 }] } })).toBe(
      stableJson({ b: { c: [1, { d: 2, e: 1 }] }, a: 1 }),
    );
  });

  it("reads current and rolled call logs, oldest first, and no other file", () => {
    const dir = tmp();
    for (const n of [
      "worker-w-calls.2.log",
      "worker-w-calls.10.log",
      "worker-w-calls.1.log",
      "worker-w.1.log",
      "service.1.log",
    ])
      writeFileSync(join(dir, n), "");
    expect(callLogFiles(dir).map((p) => p.slice(dir.length + 1))).toEqual([
      "worker-w-calls.1.log",
      "worker-w-calls.2.log",
      "worker-w-calls.10.log",
    ]);
  });

  it("drops a repeated input and an input of the set", () => {
    const dir = tmp();
    const inSet = loadSet(QuestionId.Q2).cases[0]?.input;
    writeFileSync(
      join(dir, "worker-w-calls.1.log"),
      [
        line({ a: 1, b: 2 }),
        line({ b: 2, a: 1 }, { requestId: "R2" }), // the same input, another key order
        line({ a: 3 }),
        line(inSet),
        line({ other: 1 }, {}, QuestionId.Q3), // another question
      ].join("\n") + "\n",
    );
    const { file } = run(dir);
    expect(file.source).toMatchObject({ lines: 4, kept: 2, dropped: 2, unparsed: 0 });
    expect(file.cases.map((c) => c.input)).toEqual(expect.arrayContaining([{ a: 1, b: 2 }, { a: 3 }]));
    expect(file.cases.find((c) => stableJson(c.input) === stableJson({ a: 1, b: 2 }))?.from.requestId).toBe("R1"); // the earlier line stays
  });

  it("counts and skips a bad line, and accepts an old line without the request fields", () => {
    const dir = tmp();
    const old = JSON.stringify({
      ts: "2026-10-01T00:00:00.000Z",
      event: "question_call",
      question: QuestionId.Q2,
      input: { a: 1 },
      ctx: {},
      output: {},
    });
    writeFileSync(join(dir, "worker-w-calls.log"), ["not json", '{"event":"question_call"}', old, ""].join("\n"));
    const { file } = run(dir);
    expect(file.source).toMatchObject({ lines: 1, kept: 1, dropped: 0, unparsed: 2 });
    expect(file.cases[0]?.from).toEqual({ ts: "2026-10-01T00:00:00.000Z" });
  });

  it("takes the same seeded sample twice and another with another seed", () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    expect(sample(items, 10, 7)).toEqual(sample(items, 10, 7));
    expect(sample(items, 10, 7)).not.toEqual(sample(items, 10, 8));
    expect(new Set(sample(items, 10, 7)).size).toBe(10);
    expect(sample(items, 100, 7)).toHaveLength(50);

    const dir = tmp();
    writeFileSync(join(dir, "worker-w-calls.log"), items.map((i) => line({ n: i })).join("\n") + "\n");
    const a = run(dir, { sample: 5, seed: 3 }).file;
    const b = run(dir, { sample: 5, seed: 3 }).file;
    expect(a.cases.map((c) => c.input)).toEqual(b.cases.map((c) => c.input));
    expect(a.cases).toHaveLength(5);
    expect(a.source).toMatchObject({ lines: 50, kept: 5, dropped: 0 });
  });

  it("refuses a sample that is not a positive integer and a seed that is not an integer", () => {
    expect(parseIntegerOption("sample", "5", 1)).toBe(5);
    expect(parseIntegerOption("seed", "-3", Number.MIN_SAFE_INTEGER)).toBe(-3);
    for (const bad of ["0", "-1", "abc", "1.5", "", "10x"]) {
      expect(() => parseIntegerOption("sample", bad, 1)).toThrow(/--sample/);
    }
    for (const bad of ["abc", "1.5", "", "1e3"]) {
      expect(() => parseIntegerOption("seed", bad, Number.MIN_SAFE_INTEGER)).toThrow(/--seed/);
    }
  });

  it("writes the facts of a case in the short form of the sets, with the deleted older version", () => {
    const dir = tmp();
    const short = {
      id: "F1",
      header: "h",
      content: "now",
      just: "j",
      older: [{ content: "gone", deleted: true }],
    };
    const input = {
      change: "c",
      justification: "j",
      existing: expandInput(QuestionId.Q4, { existing: short }).existing,
    };
    writeFileSync(join(dir, "worker-w-calls.log"), line(input, {}, QuestionId.Q4) + "\n");
    const { file, path } = harvest({
      question: QuestionId.Q4,
      logs: dir,
      outDir: join(dir, "out"),
      print: () => undefined,
    });
    expect(file.cases[0]?.input).toEqual({ change: "c", justification: "j", existing: short });
    // The written case expands back to the facts that the question took.
    const disk = JSON.parse(readFileSync(path, "utf8")) as HarvestFile;
    expect(expandInput(QuestionId.Q4, disk.cases[0]?.input as Record<string, unknown>)).toEqual(input);
  });

  it("refuses a directory without a call log", () => {
    expect(() => run(tmp())).toThrow(/calls/);
  });
});
