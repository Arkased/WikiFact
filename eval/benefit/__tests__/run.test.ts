import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PROCESS_START_TIMEOUT_MS } from "../../../__tests__/helpers/timeouts.js";
import { stubAgent } from "../../../fakes/stub-benefit.js";
import { loadConfig } from "../../../src/config/index.js";
import { closeStore, exportFacts, openStoreFor } from "../../../src/store/index.js";
import { Arm, ArmChoice, BenefitKind, GroupChoice, KindChoice, Verdict } from "../../lib/enums.js";
import type { AgentJob, AgentRunner } from "../agent.js";
import { WIKI_TOOLS } from "../arms.js";
import { readResultFile } from "../result-file.js";
import { resultRow, runKey, wikiCallsOf, type ResultRow } from "../rows.js";
import { runBenefit, type BenefitDeps, type BenefitOptions } from "../run.js";
import {
  BUG_FILE,
  BUGGY,
  FakeGitRepo,
  FIXED,
  IDS,
  makeCases,
  makeRepo,
  makeWiki,
  stubDeps,
  type FixtureRepo,
} from "../../../__tests__/helpers/benefit-fixture.js";
import type { BenefitCase } from "../cases.js";

// The git repo, the cases and the wiki are made once for the file and only read. A test that proves the run, and not git,
// runs the question cases on a `FakeGitRepo`; the tests that prove the checkout and the task steps use the real repo.
let root: string;
let fx: FixtureRepo;
let cases: BenefitCase[];
let questions: BenefitCase[];
let task: BenefitCase[];
let casesPath: string;
let dbPath: string;
let dir: string;
let fake: FakeGitRepo;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "benefit-run-"));
  fx = await makeRepo(join(root, "repo"));
  ({ cases, casesPath } = await makeCases(root, fx.dir));
  questions = cases.filter((c) => c.kind === BenefitKind.Question);
  task = cases.filter((c) => c.kind === BenefitKind.Task);
  dbPath = await makeWiki(join(root, "wiki"));
}, PROCESS_START_TIMEOUT_MS);

// Each test has a run folder and a result folder of its own.
beforeEach(() => {
  dir = mkdtempSync(join(root, "t-"));
  fake = new FakeGitRepo();
});

// The worktree of a preload run is `wt/preload-<round>-<case>`.
const PRELOAD_CWD = /[\\/]wt[\\/]preload-(\d+)-/;

const sha = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

function options(over: Partial<BenefitOptions> = {}): BenefitOptions {
  return {
    cases: questions,
    casesPath,
    repo: fake,
    commit: fx.commit,
    dbPath,
    arms: [Arm.With, Arm.Without],
    runs: 2,
    concurrency: 2,
    model: "stub-model",
    runDir: join(dir, "run"),
    resultPath: join(dir, "out", "result.json"),
    meta: {
      startedAt: "2026-10-19T00:00:00.000Z",
      commit: fx.commit,
      model: "stub-model",
      judgeModel: "stub",
      agent: "stub",
      runs: 2,
      concurrency: 2,
      arm: ArmChoice.Both,
      kind: KindChoice.All,
      group: GroupChoice.All,
      casesFile: "cases.json",
      preloadRounds: 1,
      passCondition: "none",
    },
    preloadRounds: 1,
    isolateConfig: false,
    deps: stub(),
    ...over,
  };
}

// The stub deps for the cases of the current test.
function stub(over: Partial<BenefitDeps> = {}): BenefitDeps {
  return stubDeps({ cases, casesPath }, over);
}

// The case of a job, found by its prompt (a job carries nothing else about its case).
function caseOf(job: AgentJob): BenefitCase {
  const found = cases.find((c) => job.prompt.startsWith(c.kind === BenefitKind.Question ? c.question : c.issue));
  if (!found) throw new Error("no case for the prompt");
  return found;
}

// Wraps the stub agent to record each job and to run a check while the files of the job still exist.
function spying(onJob: (job: AgentJob) => void | Promise<void>): AgentRunner {
  const inner = stubAgent({ cases, casesPath });
  return async (job) => {
    await onJob(job);
    return inner(job);
  };
}

describe("a run of the benefit test", { timeout: PROCESS_START_TIMEOUT_MS }, () => {
  it("runs each case in each arm for each run, and writes one row of the schema for each", async () => {
    const out = await runBenefit(options());
    expect(out.stoppedBy).toBeUndefined();
    expect(out.failures).toEqual([]);
    expect(out.rows).toHaveLength(questions.length * 2 * 2);
    expect(new Set(out.rows.map(runKey)).size).toBe(out.rows.length);
    for (const row of out.rows) expect(() => resultRow.parse(row)).not.toThrow();
    const onDisk = readResultFile(join(dir, "out", "result.json"));
    expect(onDisk.rows).toHaveLength(out.rows.length);
    expect(existsSync(join(dir, "out", "result.json.tmp"))).toBe(false);
  });

  it("gives the arm with the wiki server and the arm without none, and nothing else differs", async () => {
    const seen: { arm: Arm; mcp: unknown; tools: string[]; prompt: string; builtin: string[]; preload: boolean }[] = [];
    const agent = spying((job) => {
      seen.push({
        preload: PRELOAD_CWD.test(job.cwd),
        arm: job.arm,
        mcp: JSON.parse(readFileSync(job.mcpConfigPath, "utf8")),
        tools: job.allowedTools,
        prompt: job.prompt,
        builtin: job.builtinTools,
      });
    });
    await runBenefit(options({ runs: 1, deps: stub({ agent }) }));
    const questionJobs = seen.filter((s) => s.prompt.includes("Question of") && !s.preload);
    const w = questionJobs.filter((s) => s.arm === Arm.With);
    const wo = questionJobs.filter((s) => s.arm === Arm.Without);
    expect(w.length).toBeGreaterThan(0);
    for (const s of w) expect(Object.keys((s.mcp as { mcpServers: object }).mcpServers)).toHaveLength(1);
    for (const s of wo) expect((s.mcp as { mcpServers: object }).mcpServers).toEqual({});
    expect(w.every((s) => s.tools.includes(WIKI_TOOLS))).toBe(true);
    expect(wo.some((s) => s.tools.includes(WIKI_TOOLS))).toBe(false);
    expect(w.map((s) => s.prompt).sort()).toEqual(wo.map((s) => s.prompt).sort());
    expect(
      w
        .map((s) => s.builtin)
        .flat()
        .sort(),
    ).toEqual(
      wo
        .map((s) => s.builtin)
        .flat()
        .sort(),
    );
  });

  it("counts the wiki calls of the arm with and none for the arm without", async () => {
    const out = await runBenefit(options({ runs: 1 }));
    for (const row of out.rows) {
      if (row.arm === Arm.With) expect(wikiCallsOf(row)).toBeGreaterThan(0);
      else expect(wikiCallsOf(row)).toBe(0);
    }
  });

  it("reads a copy of the wiki per run, with the wrong fact only in the copy of the stale case, and never writes the given file", async () => {
    const before = sha(dbPath);
    const headers: Record<string, string[]> = {};
    const agent = spying((job) => {
      const c = caseOf(job);
      if (job.arm !== Arm.With || c.kind !== BenefitKind.Question) return;
      const config = JSON.parse(readFileSync(job.mcpConfigPath, "utf8")) as {
        mcpServers: Record<string, { args: string[] }>;
      };
      const db = Object.values(config.mcpServers)[0]?.args.at(-1) ?? "";
      const store = openStoreFor(loadConfig(db), db);
      try {
        headers[c.id] = exportFacts(store, Date.now(), false).map((f) => f.header);
      } finally {
        closeStore(store);
      }
    });
    await runBenefit(options({ runs: 1, deps: stub({ agent }) }));
    expect(headers[IDS.stale]).toContain("Wrong stub fact");
    expect(headers[IDS.held]).not.toContain("Wrong stub fact");
    expect(headers[IDS.gap]).not.toContain("Wrong stub fact");
    expect(sha(dbPath)).toBe(before);
  });

  it("removes the worktree when the agent fails, and leaves no row for the job", async () => {
    const agent: AgentRunner = async (job) => {
      if (caseOf(job).id === IDS.gap && job.arm === Arm.With) throw new Error("agent crashed");
      return stubAgent({ cases, casesPath })(job);
    };
    const out = await runBenefit(options({ runs: 1, deps: stub({ agent }) }));
    expect(out.failures).toHaveLength(1);
    expect(out.failures[0]).toContain("agent crashed");
    expect(out.rows.find((r) => r.caseId === IDS.gap && r.arm === Arm.With)).toBeUndefined();
    expect(out.rows).toHaveLength(questions.length * 2 - 1);
    expect([...fake.live]).toEqual([]);
  });
});

// The one real git case of this file: a task run needs a real worktree (`git apply`, a baseline commit, a diff). Every
// other test runs the question cases on a fake repo.
describe("a task run", { timeout: PROCESS_START_TIMEOUT_MS }, () => {
  it("applies the setup patch, gives the agent the issue, then judges the diff against the reference after the hidden tests ran", async () => {
    const checks: { tests: string[]; hiddenExists: boolean; content: string }[] = [];
    const judged: { issue: string; reference: string; diff: string }[] = [];
    let atStart = "";
    let settingsAtStart = false;
    const withoutWiki = new Set<string>();
    const agent = spying((job) => {
      const c = caseOf(job);
      if (c.kind !== BenefitKind.Task) return;
      if (job.arm === Arm.Without) withoutWiki.add(job.cwd);
      atStart = readFileSync(join(job.cwd, BUG_FILE), "utf8");
      settingsAtStart = existsSync(join(job.cwd, ".claude", "settings.json"));
      expect(job.prompt).toBe(c.issue);
    });
    // The type check fails in the arm without the wiki only, so that one run proves both arms and the rule that a
    // failed type check is not done even when the hidden tests pass.
    const deps = stub({
      agent,
      checker: (wt, tests) => {
        checks.push({
          tests,
          hiddenExists: existsSync(join(wt, "src", "value.test.ts")),
          content: readFileSync(join(wt, BUG_FILE), "utf8"),
        });
        return Promise.resolve({ testsPass: true, typecheckPass: !withoutWiki.has(wt), output: "" });
      },
      judge: {
        judgeAnswer: () => Promise.resolve({ verdict: Verdict.Correct, reason: "r" }),
        judgeDiff: (i) => {
          judged.push({ issue: i.issue, reference: i.referencePatch, diff: i.diff });
          return Promise.resolve({ verdict: Verdict.Partial, reason: "half" });
        },
      },
    });
    const out = await runBenefit(options({ runs: 1, deps, repo: fx.repo, cases: task }));
    expect(out.failures).toEqual([]);
    expect(atStart).toBe(BUGGY);
    expect(settingsAtStart).toBe(true);
    const checked = { tests: ["src/value.test.ts"], hiddenExists: true, content: FIXED };
    expect(checks).toEqual([checked, checked]);
    expect(judged).toHaveLength(2);
    for (const j of judged) {
      expect(j.diff).toContain("+fixed");
      expect(j.diff).not.toContain("value.test.ts");
      expect(j.diff).not.toContain("settings.json");
      expect(j.reference).toContain("+fixed");
    }
    const withRow: ResultRow | undefined = out.rows.find((r) => r.arm === Arm.With);
    expect(withRow?.filesChanged).toEqual([BUG_FILE]);
    expect(withRow?.correct).toMatchObject({ tests: true, judge: Verdict.Partial });
    const withoutRow: ResultRow | undefined = out.rows.find((r) => r.arm === Arm.Without);
    expect(withoutRow?.correct.tests).toBe(false);
    expect(withoutRow?.correct.typecheck).toBe(false);
    // The git boundary: the worktrees and the copies of the run are gone, and the repo lists only itself.
    expect(await fx.repo.listWorktrees()).toHaveLength(1);
    expect(readdirSync(join(dir, "run", "wt"))).toEqual([]);
    expect(readdirSync(join(dir, "run", "db"))).toEqual([]);
  });
});

describe("a stop and a resume", { timeout: PROCESS_START_TIMEOUT_MS }, () => {
  const limited = (after: number): AgentRunner => {
    let calls = 0;
    return async (job) => {
      // The preload rounds run before the measured runs and are not counted.
      if (!PRELOAD_CWD.test(job.cwd)) calls++;
      if (calls > after)
        return {
          answer: "",
          costUsd: 0,
          turns: 0,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          toolCalls: [],
          error: "You've hit your limit · resets 5pm",
        };
      return stubAgent({ cases, casesPath })(job);
    };
  };

  it("stops at a rate limit, keeps the rows and says why in the file", async () => {
    const out = await runBenefit(options({ concurrency: 1, deps: stub({ agent: limited(3) }) }));
    expect(out.rows).toHaveLength(3);
    expect(out.stoppedBy).toMatch(/limit/);
    expect(out.skipped).toBe(questions.length * 2 * 2 - 3);
    const file = readResultFile(join(dir, "out", "result.json"));
    expect(file.rows).toHaveLength(3);
    expect(file.meta.stoppedBy).toMatch(/limit/);
  });

  it("covers every case once before it repeats any", async () => {
    const out = await runBenefit(options({ concurrency: 1, deps: stub({ agent: limited(questions.length * 2) }) }));
    expect(new Set(out.rows.map((r) => r.run))).toEqual(new Set([1]));
    expect(new Set(out.rows.map((r) => r.caseId)).size).toBe(questions.length);
  });

  it("resumes: the jobs that have a row are not run again, and the file ends complete", async () => {
    const first = await runBenefit(options({ concurrency: 1, deps: stub({ agent: limited(5) }) }));
    expect(first.rows).toHaveLength(5);
    let calls = 0;
    const counting: AgentRunner = async (job) => {
      if (!PRELOAD_CWD.test(job.cwd)) calls++;
      return stubAgent({ cases, casesPath })(job);
    };
    const second = await runBenefit(
      options({ concurrency: 1, resume: { rows: first.rows }, deps: stub({ agent: counting }) }),
    );
    expect(second.stoppedBy).toBeUndefined();
    expect(second.rows).toHaveLength(questions.length * 2 * 2);
    expect(calls).toBe(questions.length * 2 * 2 - 5);
    expect(new Set(second.rows.map(runKey)).size).toBe(second.rows.length);
  });

  it("deletes the wt folder of a killed run and prunes the repo at the start, on a fresh run and on a resume", async () => {
    for (const resume of [undefined, { rows: [] as ResultRow[] }]) {
      const leftover = join(dir, "run", "wt", "preload-1-leftover");
      mkdirSync(leftover, { recursive: true });
      const before = fake.pruned;
      await runBenefit(options({ runs: 1, ...(resume ? { resume } : {}) }));
      expect(existsSync(leftover)).toBe(false);
      expect(fake.pruned).toBe(before + 1);
    }
  });

  it("starts after a kill that left a real worktree and its git entry in the run folder", async () => {
    const leftover = join(dir, "run", "wt", "preload-1-" + IDS.held);
    await fx.repo.addWorktree(fx.commit, leftover);
    const asGit = leftover.replaceAll("\\", "/");
    expect(await fx.repo.listWorktrees()).toContain(asGit);
    const out = await runBenefit(options({ repo: fx.repo, runs: 1, arms: [Arm.With] }));
    expect(out.failures).toEqual([]);
    expect(existsSync(leftover)).toBe(false);
    expect(await fx.repo.listWorktrees()).not.toContain(asGit);
  });
});
