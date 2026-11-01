import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  Arm,
  ArmChoice,
  BenefitCopy,
  BenefitGroup,
  BenefitKind,
  Complexity,
  GroupChoice,
  KindChoice,
  QuestionType,
  Verdict,
} from "../../lib/enums.js";
import {
  doneKeys,
  oldCopyMessage,
  readResultFile,
  resumeMismatches,
  writeResultFile,
  type ResultMeta,
} from "../result-file.js";
import { runKey, type ResultRow } from "../rows.js";

const meta: ResultMeta = {
  startedAt: "2026-10-19T00:00:00.000Z",
  updatedAt: "2026-10-19T00:00:01.000Z",
  commit: "abc",
  model: "m",
  judgeModel: "j",
  agent: "stub",
  runs: 1,
  concurrency: 1,
  arm: ArmChoice.Both,
  kind: KindChoice.All,
  group: GroupChoice.All,
  casesFile: "eval/benefit.json",
  cases: 1,
  preloadRounds: 3,
  passCondition: "none",
};

const row: ResultRow = {
  caseId: "c",
  kind: BenefitKind.Question,
  group: BenefitGroup.Held,
  type: QuestionType.Locate,
  complexity: Complexity.Simple,
  arm: Arm.With,
  run: 1,
  correct: { terms: true, judge: Verdict.Correct },
  usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
  costUsd: 0.5,
  turns: 2,
  toolCalls: [{ tool: "Read" }],
  wallMs: 10,
};

describe("the result file", () => {
  it("is read back as it was written, with a summary, and leaves no temporary file", () => {
    const dir = mkdtempSync(join(tmpdir(), "benefit-file-"));
    const path = join(dir, "r.json");
    writeResultFile(path, meta, [row]);
    expect(readResultFile(path)).toEqual({ meta, rows: [row] });
    expect(readdirSync(dir)).toEqual(["r.json"]);
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  it("is rewritten with every row so far, so a stopped run keeps its rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "benefit-file-"));
    const path = join(dir, "r.json");
    writeResultFile(path, meta, [row]);
    writeResultFile(path, meta, [row, { ...row, run: 2 }]);
    expect(readResultFile(path).rows).toHaveLength(2);
  });

  it("names the runs that a resumed run skips", () => {
    expect(doneKeys([row, { ...row, arm: Arm.Without }])).toEqual(
      new Set([runKey(row), runKey({ ...row, arm: Arm.Without })]),
    );
  });

  it("refuses a file that does not match the schema", () => {
    const dir = mkdtempSync(join(tmpdir(), "benefit-file-"));
    const path = join(dir, "r.json");
    // A file that exists and is JSON, but its meta lacks the commit and its row has an arm that does not exist.
    const { commit: _commit, ...noCommit } = meta;
    void _commit;
    writeFileSync(path, JSON.stringify({ meta: noCommit, rows: [{ ...row, arm: "middle" }] }));
    expect(() => readResultFile(path)).toThrow(path);
  });

  it("refuses a file whose head holds an arm, a kind or a group that does not exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "benefit-file-"));
    const path = join(dir, "r.json");
    writeFileSync(path, JSON.stringify({ meta: { ...meta, group: "sometimes" }, rows: [] }));
    expect(() => readResultFile(path)).toThrow(path);
  });
});

describe("resuming", () => {
  const same = {
    commit: meta.commit,
    model: meta.model,
    runs: meta.runs,
    arm: meta.arm,
    kind: meta.kind,
    group: meta.group,
    casesFile: meta.casesFile,
    cases: meta.cases,
    preloadRounds: meta.preloadRounds,
  };

  it("refuses a file with a row that did not read the preloaded copy", () => {
    expect(oldCopyMessage([{ ...row, copy: BenefitCopy.Preloaded }])).toBeUndefined();
    expect(
      oldCopyMessage([
        { ...row, copy: BenefitCopy.Preloaded },
        { ...row, copy: BenefitCopy.Filled },
      ]),
    ).toMatch(/before the preload.*1 rows/);
    expect(oldCopyMessage([{ ...row, copy: undefined }])).toMatch(/before the preload/);
  });

  it("may continue a file of the same setup", () => {
    expect(resumeMismatches(meta, same)).toEqual([]);
  });

  it("refuses a file that differs in the model, the runs, the arm, the cases, the preload rounds or the commit", () => {
    expect(resumeMismatches(meta, { ...same, preloadRounds: 0 })).toEqual(["preloadRounds"]);
    expect(resumeMismatches(meta, { ...same, model: "other-model" })).toEqual(["model"]);
    expect(resumeMismatches(meta, { ...same, runs: meta.runs + 1 })).toEqual(["runs"]);
    expect(resumeMismatches(meta, { ...same, arm: ArmChoice.With })).toEqual(["arm"]);
    expect(resumeMismatches(meta, { ...same, cases: meta.cases + 1 })).toEqual(["cases"]);
    expect(resumeMismatches(meta, { ...same, casesFile: "other.json" })).toEqual(["casesFile"]);
    expect(resumeMismatches(meta, { ...same, commit: "def", model: "other-model" })).toEqual(["commit", "model"]);
  });
});
