import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PROCESS_START_TIMEOUT_MS } from "../../../__tests__/helpers/timeouts.js";
import {
  FakeGitRepo,
  IDS,
  makeCases,
  makeRepo,
  makeWiki,
  stubDeps,
  type FixtureRepo,
} from "../../../__tests__/helpers/benefit-fixture.js";
import { jobDatabase, stubAgent, submitStubChange } from "../../../fakes/stub-benefit.js";
import { loadConfig } from "../../../src/config/index.js";
import { closeStore, exportFacts, openStoreFor } from "../../../src/store/index.js";
import {
  Arm,
  ArmChoice,
  BenefitCopy,
  BenefitGroup,
  BenefitKind,
  GroupChoice,
  KindChoice,
  PreloadStop,
} from "../../lib/enums.js";
import type { AgentJob, AgentRunner } from "../agent.js";
import { taskFolder, type BenefitCase } from "../cases.js";
import { PRELOAD_FILE, preloadGoneMessage } from "../preload.js";
import { readResultFile } from "../result-file.js";
import { resultRow } from "../rows.js";
import { runBenefit, type BenefitOptions } from "../run.js";

let root: string;
let fx: FixtureRepo;
let cases: BenefitCase[];
let questions: BenefitCase[];
let casesPath: string;
let dbPath: string;
let dir: string;
let fake: FakeGitRepo;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "benefit-preload-"));
  fx = await makeRepo(join(root, "repo"));
  ({ cases, casesPath } = await makeCases(root, fx.dir));
  questions = cases.filter((c) => c.kind === BenefitKind.Question);
  dbPath = await makeWiki(join(root, "wiki"));
}, PROCESS_START_TIMEOUT_MS);

beforeEach(() => {
  dir = mkdtempSync(join(root, "t-"));
  fake = new FakeGitRepo();
});

// The worktree of a preload run is `wt/preload-<round>-<case>`.
const PRELOAD_CWD = /[\\/]wt[\\/]preload-(\d+)-/;
const isPreloadJob = (job: AgentJob): boolean => PRELOAD_CWD.test(job.cwd);
const sha = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

function options(over: Partial<BenefitOptions> = {}): BenefitOptions {
  return {
    cases: questions,
    casesPath,
    repo: fake,
    commit: fx.commit,
    dbPath,
    arms: [Arm.With],
    runs: 1,
    concurrency: 2,
    model: "stub-model",
    runDir: join(dir, "run"),
    resultPath: join(dir, "out", "result.json"),
    meta: {
      startedAt: "2026-10-26T00:00:00.000Z",
      commit: fx.commit,
      model: "stub-model",
      judgeModel: "stub",
      agent: "stub",
      runs: 1,
      concurrency: 2,
      arm: ArmChoice.With,
      kind: KindChoice.All,
      group: GroupChoice.All,
      casesFile: "cases.json",
      preloadRounds: 3,
      passCondition: "none",
    },
    preloadRounds: 3,
    isolateConfig: false,
    deps: stubDeps({ cases, casesPath }),
    ...over,
  };
}

// An agent that queues a submission in the wiki of each preload run, as `requestChange` would. `submitsIn` says which
// rounds (1-based) make one; the text is new each time, so the worker accepts it as a new fact.
function submittingIn(submitsIn: (round: number) => boolean): AgentRunner {
  const inner = stubAgent({ cases, casesPath });
  let n = 0;
  return async (job) => {
    if (isPreloadJob(job)) {
      const round = Number(PRELOAD_CWD.exec(job.cwd)?.[1]);
      if (submitsIn(round))
        submitStubChange(jobDatabase(job), `Preload note ${String(++n)} about the wiki of the stub.`);
    }
    return inner(job);
  };
}

const headersOf = (db: string): string[] => {
  const store = openStoreFor(loadConfig(db), db);
  try {
    return exportFacts(store, Date.now(), false).map((f) => f.header);
  } finally {
    closeStore(store);
  }
};

describe("the preload of the benefit test", { timeout: PROCESS_START_TIMEOUT_MS }, () => {
  it("stops after a round in which the worker accepts no change", async () => {
    const agent = submittingIn((round) => round === 1);
    const out = await runBenefit(options({ deps: stubDeps({ cases, casesPath }, { agent }) }));
    expect(out.failures).toEqual([]);
    const preload = readResultFile(join(dir, "out", "result.json")).meta.preload;
    expect(preload?.stoppedBy).toBe(PreloadStop.NoChange);
    expect(preload?.rounds).toHaveLength(2);
    expect(preload?.rounds[0]?.accepted).toBeGreaterThan(0);
    expect(preload?.rounds[1]?.accepted).toBe(0);
  });

  it("stops after the most rounds when every round accepts a change", async () => {
    const agent = submittingIn(() => true);
    const out = await runBenefit(options({ preloadRounds: 2, deps: stubDeps({ cases, casesPath }, { agent }) }));
    expect(out.failures).toEqual([]);
    const preload = readResultFile(join(dir, "out", "result.json")).meta.preload;
    expect(preload?.mostRounds).toBe(2);
    expect(preload?.stoppedBy).toBe(PreloadStop.MostRounds);
    expect(preload?.rounds.map((r) => r.accepted).every((n) => n > 0)).toBe(true);
    expect(preload?.rounds).toHaveLength(2);
  });

  it("asks the held and stale questions in each round, writes no row and writes no stale fact into the preload copy", async () => {
    const asked: string[] = [];
    const inner = submittingIn((round) => round === 1);
    const agent: AgentRunner = (job) => {
      if (isPreloadJob(job)) asked.push(job.prompt);
      return inner(job);
    };
    const out = await runBenefit(options({ deps: stubDeps({ cases, casesPath }, { agent }) }));
    expect(asked).toHaveLength(2 * 2);
    expect(asked.join("\n")).not.toContain(IDS.gap);
    expect(out.rows).toHaveLength(questions.length);
    expect(headersOf(join(dir, "run", PRELOAD_FILE))).not.toContain("Wrong stub fact");
  });

  it("makes the copy of a stale case from the preload copy, with its wrong fact written after the preload", async () => {
    const seen: Record<string, string[]> = {};
    const inner = submittingIn((round) => round === 1);
    const agent: AgentRunner = (job) => {
      if (!isPreloadJob(job)) {
        const id = questions.find((c) => c.kind === BenefitKind.Question && job.prompt.includes(c.question))?.id ?? "";
        seen[id] = headersOf(jobDatabase(job));
      }
      return inner(job);
    };
    await runBenefit(options({ deps: stubDeps({ cases, casesPath }, { agent }) }));
    const filled = headersOf(dbPath);
    const learned = headersOf(join(dir, "run", PRELOAD_FILE)).filter((h) => !filled.includes(h));
    expect(learned.length).toBeGreaterThan(0);
    expect(seen[IDS.stale]).toEqual(expect.arrayContaining([...learned, "Wrong stub fact"]));
    expect(seen[IDS.held]).toEqual(expect.arrayContaining(learned));
    expect(seen[IDS.held]).not.toContain("Wrong stub fact");
    // The gap questions read the preload copy too, with no wrong fact.
    expect(seen[IDS.gap]).toEqual(expect.arrayContaining(learned));
    expect(seen[IDS.gap]).not.toContain("Wrong stub fact");
    expect(filled.length).toBeGreaterThan(0);
  });

  it("makes the copy of a held task and of a stale task from the preload copy, with the wrong fact only in the stale one", async () => {
    const held = cases.find((c) => c.kind === BenefitKind.Task);
    if (held?.kind !== BenefitKind.Task) throw new Error("the fixture has no task");
    const staleId = "t-stale";
    cpSync(taskFolder(casesPath, held.id), taskFolder(casesPath, staleId), { recursive: true });
    const stale: BenefitCase = {
      ...held,
      id: staleId,
      group: BenefitGroup.Stale,
      issue: "The stale value is buggy. Make it fixed.",
      staleFact: {
        header: "Wrong stub task fact",
        content: "The stub wiki claims a wrong thing.",
        justification: "A task has no proof file.",
      },
    };
    const all = [...cases, stale];
    const seen: Record<string, string[]> = {};
    const inner = submittingIn((round) => round === 1);
    const taskAgent = stubAgent({ cases: all, casesPath });
    const agent: AgentRunner = (job) => {
      if (isPreloadJob(job)) return inner(job);
      const id = all.find((c) => c.kind === BenefitKind.Task && job.prompt.includes(c.issue))?.id;
      if (id !== undefined) seen[id] = headersOf(jobDatabase(job));
      return taskAgent(job);
    };
    // A task run needs a real worktree (`git apply`, a baseline commit), so this test uses the real fixture repo.
    const deps = stubDeps({ cases: all, casesPath }, { agent });
    const out = await runBenefit(options({ cases: all, repo: fx.repo, concurrency: 1, deps }));
    expect(out.failures).toEqual([]);
    for (const id of [held.id, staleId]) {
      const rows = out.rows.filter((r) => r.caseId === id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.copy).toBe(BenefitCopy.Preloaded);
    }
    const filled = headersOf(dbPath);
    const learned = headersOf(join(dir, "run", PRELOAD_FILE)).filter((h) => !filled.includes(h));
    expect(learned.length).toBeGreaterThan(0);
    expect(seen[held.id]).toEqual(expect.arrayContaining(learned));
    expect(seen[held.id]).not.toContain("Wrong stub task fact");
    expect(seen[staleId]).toEqual(expect.arrayContaining([...learned, "Wrong stub task fact"]));
  });

  it("puts the copy that a case read on each row, and the file head holds the preload", async () => {
    const agent = submittingIn((round) => round === 1);
    const out = await runBenefit(
      options({ arms: [Arm.With, Arm.Without], deps: stubDeps({ cases, casesPath }, { agent }) }),
    );
    for (const row of out.rows) expect(() => resultRow.parse(row)).not.toThrow();
    const copyOf = (id: string): (BenefitCopy | undefined)[] =>
      out.rows.filter((r) => r.caseId === id).map((r) => r.copy);
    expect(copyOf(IDS.held)).toEqual([BenefitCopy.Preloaded, BenefitCopy.Preloaded]);
    expect(copyOf(IDS.stale)).toEqual([BenefitCopy.Preloaded, BenefitCopy.Preloaded]);
    expect(copyOf(IDS.gap)).toEqual([BenefitCopy.Preloaded, BenefitCopy.Preloaded]);
    expect(readResultFile(join(dir, "out", "result.json")).meta.preloadRounds).toBe(3);
  });

  it("refuses a run with the rounds at 0: the preload cannot be turned off", async () => {
    await expect(runBenefit(options({ preloadRounds: 0, deps: stubDeps({ cases, casesPath }, {}) }))).rejects.toThrow(
      /at least 1 round/,
    );
  });

  it("on a resume reuses a complete preload and does not ask the preload questions again", async () => {
    const agent = submittingIn((round) => round === 1);
    await runBenefit(options({ deps: stubDeps({ cases, casesPath }, { agent }) }));
    const earlier = readResultFile(join(dir, "out", "result.json")).meta.preload;
    expect(earlier?.stoppedBy).toBeDefined();
    const before = sha(join(dir, "run", PRELOAD_FILE));
    let calls = 0;
    const counting: AgentRunner = (job) => {
      calls++;
      return stubAgent({ cases, casesPath })(job);
    };
    const out = await runBenefit(
      options({ resume: { rows: [], preload: earlier }, deps: stubDeps({ cases, casesPath }, { agent: counting }) }),
    );
    expect(calls).toBe(questions.length);
    expect(out.rows).toHaveLength(questions.length);
    expect(sha(join(dir, "run", PRELOAD_FILE))).toBe(before);
    expect(readResultFile(join(dir, "out", "result.json")).meta.preload).toEqual(earlier);
  });

  it("on a resume refuses a complete preload whose copy is gone when a row read it, and builds it again when no row did", async () => {
    const agent = submittingIn((round) => round === 1);
    const first = await runBenefit(options({ deps: stubDeps({ cases, casesPath }, { agent }) }));
    const earlier = readResultFile(join(dir, "out", "result.json")).meta.preload;
    expect(earlier?.stoppedBy).toBeDefined();
    const runDir = join(dir, "run");
    expect(first.rows.some((r) => r.copy === BenefitCopy.Preloaded)).toBe(true);
    expect(preloadGoneMessage(runDir, earlier, first.rows)).toBeUndefined();
    rmSync(join(runDir, PRELOAD_FILE), { force: true });
    expect(preloadGoneMessage(runDir, earlier, first.rows)).toMatch(/preloaded copy.*is gone.*start the run again/);
    expect(preloadGoneMessage(runDir, undefined, first.rows)).toBeUndefined();

    let preloadRuns = 0;
    const counting: AgentRunner = (job) => {
      if (isPreloadJob(job)) preloadRuns++;
      return agent(job);
    };
    expect(preloadGoneMessage(runDir, earlier, [])).toBeUndefined();
    const second = await runBenefit(
      options({ resume: { rows: [], preload: earlier }, deps: stubDeps({ cases, casesPath }, { agent: counting }) }),
    );
    expect(second.stoppedBy).toBeUndefined();
    expect(preloadRuns).toBeGreaterThan(0);
    expect(existsSync(join(runDir, PRELOAD_FILE))).toBe(true);
  });

  it("on a resume makes an incomplete preload again from the start", async () => {
    // A rate limit in round 2 stops the run with 1 round recorded and no end for the preload.
    const inner = submittingIn(() => true);
    const limited: AgentRunner = (job) => {
      if (isPreloadJob(job) && PRELOAD_CWD.exec(job.cwd)?.[1] === "2")
        return Promise.resolve({
          answer: "",
          costUsd: 0,
          turns: 0,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          toolCalls: [],
          error: "You've hit your limit · resets 5pm",
        });
      return inner(job);
    };
    const first = await runBenefit(options({ deps: stubDeps({ cases, casesPath }, { agent: limited }) }));
    expect(first.stoppedBy).toMatch(/limit/);
    expect(first.rows).toEqual([]);
    const earlier = readResultFile(join(dir, "out", "result.json")).meta.preload;
    expect(earlier?.rounds).toHaveLength(1);
    expect(earlier?.stoppedBy).toBeUndefined();

    let preloadRuns = 0;
    const again = submittingIn(() => true);
    const counting: AgentRunner = (job) => {
      if (isPreloadJob(job)) preloadRuns++;
      return again(job);
    };
    const second = await runBenefit(
      options({
        preloadRounds: 2,
        resume: { rows: [], preload: earlier },
        deps: stubDeps({ cases, casesPath }, { agent: counting }),
      }),
    );
    expect(second.stoppedBy).toBeUndefined();
    // 2 questions in each of 2 rounds: the round 1 of the stopped run is done again.
    expect(preloadRuns).toBe(2 * 2);
    expect(readResultFile(join(dir, "out", "result.json")).meta.preload?.stoppedBy).toBe(PreloadStop.MostRounds);
  });
});
