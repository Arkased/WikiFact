// The requirement tests of docs/requirements/evaluation.md: one test per row, named as the row.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { loadCases, type QuestionCase } from "../../eval/benefit/cases.js";
import { readResultFile } from "../../eval/benefit/result-file.js";
import { wikiCallsOf } from "../../eval/benefit/rows.js";
import { summarize } from "../../eval/benefit/summary.js";
import {
  Arm,
  BenefitKind,
  Complexity,
  EvalTestName,
  QuestionType,
  TaskType,
  TestStatus,
} from "../../eval/lib/enums.js";
import { relativeToRoot } from "../../eval/lib/relative-path.js";
import { projectRoot } from "../../src/paths.js";
import { makeCases, makeRepo, makeWiki } from "../helpers/benefit-fixture.js";
import { useEvalFixture } from "../helpers/eval-fixture.js";
import { PROCESS_START_TIMEOUT_MS } from "../helpers/timeouts.js";

/** The timeout of the benefit test: a real `tsx` process, git worktrees and the stub runs of 4 cases, in milliseconds. */
const BENEFIT_TIMEOUT_MS = 120_000;

const { Questions, Relevance, Replay, Corrections, Speed } = EvalTestName;

// Each eval test starts up to 5 real node processes: the timeout covers a loaded machine, it is not a bound under test.
/** The test timeout, in milliseconds. */

describe("performance requirements", { timeout: PROCESS_START_TIMEOUT_MS }, () => {
  const fx = useEvalFixture();
  const { run, started, sorted, position, testOf, readIndex, reset } = fx;

  it("Eval order", async () => {
    // One command runs all the evals. The questions child stays open until the speed child has started: the run ends
    // only if the two overlap.
    const all = await run([], { [Questions]: { waitForStart: Speed } });
    expect(started()).toEqual(sorted(Questions, Relevance, Replay, Corrections, Speed));
    // The benefit test needs a wiki, so it is skipped when no flag names one.
    expect(
      all.idx.tests
        .filter((t) => t.status === TestStatus.Ran)
        .map((t) => t.name)
        .sort(),
    ).toEqual(started());
    expect(all.idx.ok).toBe(true);
    // Each eval starts after the evals it depends on ended.
    expect(position(Speed, false)).toBeLessThan(position(Questions, true));
    expect(position(Relevance, false)).toBeGreaterThan(position(Questions, true));
    expect(position(Replay, false)).toBeGreaterThan(position(Questions, true));
    expect(position(Replay, false)).toBeGreaterThan(position(Relevance, true));
    expect(position(Corrections, false)).toBeGreaterThan(position(Replay, true));
    // The run stops at the first failure and marks the rest as not run.
    reset();
    const { idx, out } = await run([], { [Replay]: { exit: 3 } });
    // speed is independent of the chain and already ran beside the questions
    expect(started()).toEqual(sorted(Questions, Relevance, Replay, Speed));
    expect(Object.fromEntries(idx.tests.map((t) => [t.name, `${t.status}:${t.exitCode ?? "-"}`]))).toEqual({
      [Questions]: `${TestStatus.Ran}:0`,
      [Relevance]: `${TestStatus.Ran}:0`,
      [Replay]: `${TestStatus.Ran}:3`,
      [Corrections]: `${TestStatus.NotRun}:-`,
      [Speed]: `${TestStatus.Ran}:0`,
      [EvalTestName.Benefit]: `${TestStatus.NotRun}:-`,
    });
    expect(idx.ok).toBe(false);
    expect(readIndex(out).ok).toBe(false);
    expect(testOf(readIndex(out), Corrections).status).toBe(TestStatus.NotRun);
  });
});

describe("system evaluation requirements", { timeout: BENEFIT_TIMEOUT_MS }, () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wf-benefit-req-"));
  });
  it("Benefit measured", async () => {
    // Any repo, any case file and any wiki: the command takes all 3 as arguments.
    const fx = await makeRepo(join(dir, "repo"));
    const made = await makeCases(dir, fx.dir);
    const { casesPath } = made;
    // One question and the task: both kinds go through both arms, and each job costs git processes. The runs of the
    // other cases, and the rows of the run, are proved in eval/benefit/__tests__/run.test.ts.
    const cases = [
      ...made.cases.filter((c) => c.kind === BenefitKind.Question).slice(0, 1),
      ...made.cases.filter((c) => c.kind === BenefitKind.Task),
    ];
    writeFileSync(casesPath, JSON.stringify(cases, null, 2));
    const wiki = await makeWiki(join(dir, "wiki"));
    const out = join(dir, "result.json");
    const run = spawnSync(
      process.execPath,
      [
        join(projectRoot(), "node_modules", "tsx", "dist", "cli.mjs"),
        join(projectRoot(), "eval", "benefit.ts"),
        ...["--stub", "--db", wiki, "--repo", fx.dir, "--commit", fx.commit, "--cases", casesPath],
        ...["--runs", "1", "--concurrency", "4", "--out", out],
      ],
      { cwd: projectRoot(), encoding: "utf8" },
    );
    expect(run.status, run.stderr).toBe(0);
    const { rows } = readResultFile(out);
    const summary = summarize(rows);
    // The file carries the summary next to the rows.
    expect(Object.keys(z.record(z.string(), z.unknown()).parse(JSON.parse(readFileSync(out, "utf8"))))).toEqual(
      expect.arrayContaining(["rows", "summary"]),
    );

    // The same cases go through 2 agents, one with the wiki tools and one without, and nothing else differs.
    for (const c of cases) {
      expect(
        rows
          .filter((r) => r.caseId === c.id)
          .map((r) => r.arm)
          .sort(),
      ).toEqual([Arm.With, Arm.Without]);
    }
    for (const r of rows) expect(wikiCallsOf(r) > 0).toBe(r.arm === Arm.With);

    // It reports, for each of the 2: the share of right answers, the share of tasks done, the tokens and the dollars.
    const question = summary.byKind.find((c) => c.key === `${BenefitKind.Question}`);
    const task = summary.byKind.find((c) => c.key === `${BenefitKind.Task}`);
    for (const arm of [question?.with, question?.without]) {
      expect(arm?.right).toBeGreaterThanOrEqual(0);
      expect(arm?.terms).toBeGreaterThanOrEqual(0);
      for (const m of [arm?.costUsd, arm?.inputTokens, arm?.outputTokens]) expect(m?.mean).toBeGreaterThanOrEqual(0);
    }
    for (const arm of [task?.with, task?.without]) {
      expect(arm?.done).toBeGreaterThanOrEqual(0);
      for (const m of [arm?.costUsd, arm?.inputTokens, arm?.outputTokens]) expect(m?.mean).toBeGreaterThanOrEqual(0);
    }
    expect(run.stdout).toContain(relativeToRoot(out));

    // The questions of the shipped file vary in type and in complexity, and its tasks are work on the repo, such as a bug fix.
    const shipped = loadCases(join("eval", "benefit.json"));
    const questions = shipped.filter((c): c is QuestionCase => c.kind === BenefitKind.Question);
    expect(new Set(questions.map((q) => q.type))).toEqual(new Set(Object.values(QuestionType)));
    expect(new Set(questions.map((q) => q.complexity))).toEqual(new Set(Object.values(Complexity)));
    const taskTypes = shipped.flatMap((c) => (c.kind === BenefitKind.Task ? [c.taskType] : []));
    expect(taskTypes).toContain(TaskType.Bugfix);
  });
});
