import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BUG_FILE,
  BUGGY,
  FIXED,
  IDS,
  makeCases,
  makeRepo,
  type FixtureRepo,
} from "../../../__tests__/helpers/benefit-fixture.js";
import { BenefitKind } from "../../lib/enums.js";
import type { BenefitCase, QuestionCase } from "../cases.js";
import type { TaskChecker } from "../task-check.js";
import { PROCESS_START_TIMEOUT_MS } from "../../../__tests__/helpers/timeouts.js";
import { verifyCases } from "../verify.js";

let dir: string;
let fx: FixtureRepo;
let cases: BenefitCase[];
let casesPath: string;
let worktree: string;

// One repo and one worktree for the file: `verifyCases` resets the worktree before each step, so no test depends on the
// state that another left, and each test starts no git process of its own for the fixture.
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "benefit-verify-"));
  fx = await makeRepo(join(dir, "repo"));
  ({ cases, casesPath } = await makeCases(dir, fx.dir));
  worktree = join(dir, "wt");
  await fx.repo.addWorktree(fx.commit, worktree);
}, PROCESS_START_TIMEOUT_MS);
afterAll(async () => {
  await fx.repo.removeWorktree(worktree);
});

// A checker whose tests pass when the bug file holds the fixed text and the hidden test file is in place.
const byFile: TaskChecker = (wt) => {
  const fixed = readFileSync(join(wt, BUG_FILE), "utf8") === FIXED && existsSync(join(wt, "src", "value.test.ts"));
  return Promise.resolve({ testsPass: fixed, typecheckPass: true, output: "" });
};

describe("the proof of the cases", { timeout: PROCESS_START_TIMEOUT_MS }, () => {
  it("passes when the hidden test fails on the setup and passes with the reference patch", async () => {
    const lines: string[] = [];
    const report = await verifyCases({
      cases,
      casesPath,
      repo: fx.repo,
      commit: fx.commit,
      worktree,
      checker: byFile,
      log: (l) => lines.push(l),
    });
    expect(report.ok).toBe(true);
    expect(report.tasks).toEqual([
      {
        id: IDS.task,
        before: { testsPass: false, typecheckPass: true },
        after: { testsPass: true, typecheckPass: true },
        ok: true,
      },
    ]);
  });

  it("fails a task whose hidden test passes on the setup", async () => {
    const always: TaskChecker = () => Promise.resolve({ testsPass: true, typecheckPass: true, output: "" });
    const report = await verifyCases({
      cases,
      casesPath,
      repo: fx.repo,
      commit: fx.commit,
      worktree,
      checker: always,
      log: () => undefined,
    });
    expect(report.ok).toBe(false);
    expect(report.tasks[0]?.ok).toBe(false);
  });

  it("fails a task whose type check fails with the reference patch", async () => {
    const noTypes: TaskChecker = async (wt) => ({ ...(await byFile(wt, [])), typecheckPass: false });
    const report = await verifyCases({
      cases,
      casesPath,
      repo: fx.repo,
      commit: fx.commit,
      worktree,
      checker: noTypes,
      log: () => undefined,
    });
    expect(report.tasks[0]?.ok).toBe(false);
  });

  it("leaves the worktree on the buggy state for no step: each step starts from a clean tree", async () => {
    const starts: string[] = [];
    const spy: TaskChecker = async (wt, tests) => {
      starts.push(readFileSync(join(wt, BUG_FILE), "utf8"));
      return byFile(wt, tests);
    };
    await verifyCases({
      cases,
      casesPath,
      repo: fx.repo,
      commit: fx.commit,
      worktree,
      checker: spy,
      log: () => undefined,
    });
    expect(starts).toEqual([BUGGY, FIXED]);
  });

  it("records a task whose reference patch does not apply as failed and goes on", async () => {
    const broken: BenefitCase[] = cases.map((c) =>
      c.kind === BenefitKind.Task ? { ...c, referencePatch: "missing.patch" } : c,
    );
    const lines: string[] = [];
    const report = await verifyCases({
      cases: broken,
      casesPath,
      repo: fx.repo,
      commit: fx.commit,
      worktree,
      checker: byFile,
      log: (l) => lines.push(l),
    });
    expect(report.ok).toBe(false);
    expect(report.tasks[0]?.ok).toBe(false);
    expect(report.tasks[0]?.error).toContain("git apply");
    expect(report.questions.length).toBeGreaterThan(0);
    expect(lines.some((l) => l.includes("NOT OK"))).toBe(true);
  });

  it("stops the proof on an error that is not a failed patch", async () => {
    const broken: TaskChecker = () => Promise.reject(new Error("the checker cannot start"));
    await expect(
      verifyCases({
        cases,
        casesPath,
        repo: fx.repo,
        commit: fx.commit,
        worktree,
        checker: broken,
        log: () => undefined,
      }),
    ).rejects.toThrow("the checker cannot start");
  });

  it("reports a proof line that is not at the commit", async () => {
    // The questions alone: the proof of a question reads the commit and needs no task step.
    const bad: BenefitCase[] = cases
      .filter((c): c is QuestionCase => c.kind === BenefitKind.Question)
      .map((c) =>
        c.id === IDS.held
          ? {
              ...c,
              proof: [
                { file: "src/missing.ts", line: 3 },
                { file: BUG_FILE, line: 999 },
              ],
            }
          : c,
      );
    const report = await verifyCases({
      cases: bad,
      casesPath,
      repo: fx.repo,
      commit: fx.commit,
      worktree,
      checker: byFile,
      log: () => undefined,
    });
    expect(report.ok).toBe(false);
    expect(report.questions.find((q) => q.id === IDS.held)?.missing).toEqual(["src/missing.ts:3", `${BUG_FILE}:999`]);
  });
});
