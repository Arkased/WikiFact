// One run of the benefit test: the copies of the wiki, the jobs (case, arm, run), the pool, the rows and the result
// file (technical/evaluation.md, "The benefit test").
import { readFileSync, rmSync } from "node:fs";
import { RM_RETRIES, RM_RETRY_DELAY_MS } from "../../src/constants.js";
import { join } from "node:path";
import { WIKI_DB_FILE } from "../../src/paths.js";
import { errorMessage } from "../../src/must.js";
import type { Config } from "../../src/config/index.js";
import type { Store } from "../../src/store/index.js";
import type { Questions } from "../../src/updates/index.js";
import { Arm, BenefitCopy, BenefitGroup, BenefitKind, Verdict } from "../lib/enums.js";
import { pool } from "../lib/pool.js";
import { allowedTools, builtinTools, promptOf, TASK_MAX_TURNS, TASK_TIMEOUT_MS, writeArmFiles } from "./arms.js";
import type { AgentRunner } from "./agent.js";
import { askQuestion } from "./ask.js";
import { taskFolder, type BenefitCase, type QuestionCase, type TaskCase } from "./cases.js";
import type { Judge } from "./judge.js";
import { runPreload } from "./preload.js";
import { doneKeys, writeResultFile, type PreloadMeta, type ResultMeta } from "./result-file.js";
import { ERROR_TEXT_CHARS, LOG_ERROR_CHARS, stopReasonOf } from "./stop.js";
import { runKey, type ResultRow } from "./rows.js";
import { summarize, type Summary } from "./summary.js";
import { copyHiddenTests, type TaskChecker } from "./task-check.js";
import { copyDatabase, copyWiki, removeDatabaseFolder, writeStaleFact } from "./wiki-copy.js";
import { applyPatch, commitBaseline, diffOf, type GitRepo } from "./worktree.js";
import type { StreamResult } from "./stream.js";
import { money } from "./report.js";

/** The parts of a run that a test or the stub replaces. */
export interface BenefitDeps {
  agent: AgentRunner;
  judge: Judge;
  checker: TaskChecker;
  /** Makes the questions of the worker step on the preload copy; the store is the copy, so the calls write their `model_calls` rows into it. */
  makeQuestions: (store: Store, config: Config) => Questions;
  /** Installs the dependencies in a task worktree (`npm ci --ignore-scripts`). */
  install: (dir: string) => Promise<void>;
  log: (line: string) => void;
}

/** Everything one run needs. */
export interface BenefitOptions {
  /** The selected cases. */
  cases: BenefitCase[];
  /** The cases file: the task files are next to it. */
  casesPath: string;
  repo: GitRepo;
  /** The full sha of the fill commit. */
  commit: string;
  /** The wiki database to copy. */
  dbPath: string;
  arms: Arm[];
  /** Runs per case and arm. */
  runs: number;
  concurrency: number;
  model: string;
  /** A folder for this run: the copies and the worktrees. */
  runDir: string;
  resultPath: string;
  /** The head of the result file, but for the fields the run fills in. */
  meta: Omit<ResultMeta, "updatedAt" | "cases" | "stoppedBy" | "preload">;
  /** The most rounds of the preload (`--preload-rounds`), 1 or more. */
  preloadRounds: number;
  /** The rows and the preload of an earlier file of the same run; their jobs are not run again. */
  resume?: { rows: ResultRow[]; preload?: PreloadMeta };
  /** Give each agent its own empty Claude config folder, so that the user's memory and skills are not loaded. */
  isolateConfig: boolean;
  deps: BenefitDeps;
}

/** What a run returns. */
export interface BenefitOutcome {
  rows: ResultRow[];
  summary: Summary;
  /** Why the run stopped before its last job; absent when it did them all. */
  stoppedBy?: string;
  /** The jobs without a row at the end: stopped, or failed. */
  skipped: number;
  /** The jobs that failed for a fault of the harness or the machine, with the message; they left no row. */
  failures: string[];
}

interface Job {
  c: BenefitCase;
  arm: Arm;
  run: number;
  /** The copy of the wiki the case reads, for the row. */
  copy: BenefitCopy;
}

const safe = (job: Job): string => `${job.c.id}-${job.arm}-${job.run}`.replace(/[^a-zA-Z0-9_-]/g, "_");

const termsOf = (answer: string, terms: string[]): boolean => {
  const low = answer.toLowerCase();
  return terms.every((t) => low.includes(t.toLowerCase()));
};

const baseRow = (
  job: Job,
): Pick<ResultRow, "caseId" | "kind" | "group" | "copy" | "arm" | "run"> &
  Partial<Pick<ResultRow, "type" | "complexity" | "taskType">> => ({
  caseId: job.c.id,
  kind: job.c.kind,
  group: job.c.group,
  copy: job.copy,
  ...(job.c.kind === BenefitKind.Question
    ? { type: job.c.type, complexity: job.c.complexity }
    : { taskType: job.c.taskType }),
  arm: job.arm,
  run: job.run,
});

function rowFrom(job: Job, out: StreamResult, wallMs: number): Omit<ResultRow, "correct"> {
  return {
    ...baseRow(job),
    answer: out.answer,
    usage: out.usage,
    costUsd: out.costUsd,
    turns: out.turns,
    toolCalls: out.toolCalls,
    wallMs,
    ...(out.error !== undefined ? { error: out.error } : {}),
  };
}

/** The state a job needs from its run. */
interface Ctx {
  o: BenefitOptions;
  /** The database each case starts from: the pristine copy, or its own copy with the wrong fact. */
  sourceOf: Map<string, string>;
  stop: { reason?: string };
}

async function runQuestion(ctx: Ctx, job: Job, c: QuestionCase): Promise<ResultRow | undefined> {
  const { o } = ctx;
  const key = safe(job);
  const dir = join(o.runDir, "wt", key);
  const dbPath = join(o.runDir, "db", key, WIKI_DB_FILE);
  const t0 = Date.now();
  await o.repo.addWorktree(o.commit, dir);
  try {
    if (job.arm === Arm.With) copyDatabase(requiredSource(ctx, c.id), dbPath);
    const out = await askQuestion({
      agent: o.deps.agent,
      arm: job.arm,
      c,
      key,
      runDir: o.runDir,
      model: o.model,
      isolateConfig: o.isolateConfig,
      worktree: dir,
      dbPath,
    });
    const stop = stopReasonOf(out.error);
    if (stop) {
      ctx.stop.reason ??= stop;
      return undefined;
    }
    const base = rowFrom(job, out, Date.now() - t0);
    const terms = termsOf(out.answer, c.answerContains);
    if (out.answer.trim() === "") {
      return { ...base, correct: { terms, judge: Verdict.Wrong, judgeReason: "no answer" } };
    }
    try {
      const v = await o.deps.judge.judgeAnswer({
        question: c.question,
        labeledAnswer: c.answer,
        proof: c.proof.map((p) => `${p.file}:${p.line}`),
        answer: out.answer,
      });
      return { ...base, correct: { terms, judge: v.verdict, judgeReason: v.reason } };
    } catch (e) {
      const stopJudge = stopReasonOf(errorMessage(e));
      if (stopJudge) {
        ctx.stop.reason ??= stopJudge;
        return undefined;
      }
      throw e;
    }
  } finally {
    await o.repo.removeWorktree(dir);
    if (job.arm === Arm.With) removeDatabaseFolder(dbPath);
  }
}

function requiredSource(ctx: Ctx, id: string): string {
  const s = ctx.sourceOf.get(id);
  if (s === undefined) throw new Error(`no database copy for the case ${id}`);
  return s;
}

async function runTask(ctx: Ctx, job: Job, c: TaskCase): Promise<ResultRow | undefined> {
  const { o } = ctx;
  const key = safe(job);
  const dir = join(o.runDir, "wt", key);
  const dbPath = join(o.runDir, "db", key, WIKI_DB_FILE);
  const folder = taskFolder(o.casesPath, c.id);
  const t0 = Date.now();
  await o.repo.addWorktree(o.commit, dir);
  try {
    if (c.setupPatch !== undefined) await applyPatch(dir, join(folder, c.setupPatch));
    await commitBaseline(dir);
    await o.deps.install(dir);
    if (job.arm === Arm.With) copyDatabase(requiredSource(ctx, c.id), dbPath);
    const { mcpConfigPath } = writeArmFiles({
      worktree: dir,
      runFolder: join(o.runDir, "run", key),
      arm: job.arm,
      kind: c.kind,
      dbPath,
    });
    const out = await o.deps.agent({
      arm: job.arm,
      prompt: promptOf(c.issue, c.kind),
      cwd: dir,
      mcpConfigPath,
      allowedTools: allowedTools(job.arm, c.kind),
      builtinTools: builtinTools(c.kind),
      model: o.model,
      maxTurns: TASK_MAX_TURNS,
      timeoutMs: TASK_TIMEOUT_MS,
      tempDir: join(o.runDir, "tmp", key),
      ...(o.isolateConfig ? { configDir: join(o.runDir, "cfg", key) } : {}),
    });
    const stop = stopReasonOf(out.error);
    if (stop) {
      ctx.stop.reason ??= stop;
      return undefined;
    }
    const change = await diffOf(dir);
    copyHiddenTests(folder, dir, c.hiddenTests);
    const check = await o.deps.checker(dir, c.hiddenTests);
    const base = rowFrom(job, out, Date.now() - t0);
    const referencePatch = readFileSync(join(folder, c.referencePatch), "utf8");
    try {
      const v = await o.deps.judge.judgeDiff({ issue: c.issue, referencePatch, diff: change.diff });
      return {
        ...base,
        filesChanged: change.files,
        correct: {
          tests: check.testsPass && check.typecheckPass,
          typecheck: check.typecheckPass,
          judge: v.verdict,
          judgeReason: v.reason,
        },
      };
    } catch (e) {
      const stopJudge = stopReasonOf(errorMessage(e));
      if (stopJudge) {
        ctx.stop.reason ??= stopJudge;
        return undefined;
      }
      throw e;
    }
  } finally {
    await o.repo.removeWorktree(dir);
    if (job.arm === Arm.With) removeDatabaseFolder(dbPath);
  }
}

/**
 * Runs the benefit test: copies the wiki, preloads a copy of it that every measured run reads (technical/evaluation.md,
 * "The preload"), makes a copy with the wrong fact for each "stale" case from the copy it reads, and runs every
 * (case, arm, run) through the pool, in the order run 1 of every case first, so that a stopped run still covers all
 * cases. After each run the result file is rewritten. A rate limit or a failed login stops the run: its row is not
 * written, the jobs that follow are not started, and the file keeps the rows so far, ready to resume.
 *
 * @param o - the cases, the repo, the wiki, the arms, the runs, the limits and the parts to replace
 * @returns the rows, the summary and why the run stopped, if it did
 * @throws {Error} when `preloadRounds` is under 1, when the wiki cannot be copied (the file is missing or is not a wiki database) or the copy with the
 *   wrong fact of a "stale" case cannot be made, or the preload meets a fault of the harness or the machine; a fault in
 *   one job does not throw, it is listed in `failures`
 * @sideEffects removes the `wt/` folder of the run folder and prunes the worktree entries of the repo; copies the database; writes `preloaded.sqlite` in the run folder; runs the preload (agent runs, worker steps, model calls); writes the result file after each run; per run: a worktree of the repo, files in
 *   the run folder, an agent process, model calls of the judge; removes the worktrees and the run copies
 */
export async function runBenefit(o: BenefitOptions): Promise<BenefitOutcome> {
  const ctx: Ctx = { o, sourceOf: new Map(), stop: {} };
  const rows: ResultRow[] = [...(o.resume?.rows ?? [])];
  const done = doneKeys(rows);
  if (o.preloadRounds < 1)
    throw new Error("the preload has at least 1 round: every measured run reads the preloaded copy");
  const jobs: Job[] = [];
  for (let run = 1; run <= o.runs; run++)
    for (const c of o.cases)
      for (const arm of o.arms)
        if (!done.has(runKey({ caseId: c.id, arm, run }))) jobs.push({ c, arm, run, copy: BenefitCopy.Preloaded });
  const total = jobs.length;
  let started = 0;
  const failures: string[] = [];
  let preload: PreloadMeta | undefined = o.resume?.preload;
  const head = (): ResultMeta => ({
    ...o.meta,
    updatedAt: new Date().toISOString(),
    cases: o.cases.length,
    ...(preload ? { preload } : {}),
    ...(ctx.stop.reason ? { stoppedBy: ctx.stop.reason } : {}),
  });
  // A kill leaves the worktrees of the run in `wt/` and their entries in the repo; `git worktree add` fails on a path that exists.
  rmSync(join(o.runDir, "wt"), { recursive: true, force: true, maxRetries: RM_RETRIES, retryDelay: RM_RETRY_DELAY_MS });
  await o.repo.pruneWorktrees();
  // A resume may find the run folder of the stopped run: the copies but the preload copy are made again.
  rmSync(join(o.runDir, "pristine"), {
    recursive: true,
    force: true,
    maxRetries: RM_RETRIES,
    retryDelay: RM_RETRY_DELAY_MS,
  });
  const pristine = await copyWiki(o.dbPath, join(o.runDir, "pristine"));
  // The rounds of the preload ask the held and stale questions; the gap questions and the tasks only read the result.
  const preloadQuestions = o.cases.filter(
    (c): c is QuestionCase => c.kind === BenefitKind.Question && c.group !== BenefitGroup.Gap,
  );
  // A run with no pending job in the arm "with" does not need the preload.
  const needsPreload = jobs.some((j) => j.arm === Arm.With);
  let preloadedPath: string | undefined;
  if (needsPreload) {
    writeResultFile(o.resultPath, head(), rows);
    const made = await runPreload({
      repo: o.repo,
      commit: o.commit,
      agent: o.deps.agent,
      makeQuestions: o.deps.makeQuestions,
      log: o.deps.log,
      model: o.model,
      isolateConfig: o.isolateConfig,
      concurrency: o.concurrency,
      runDir: o.runDir,
      source: pristine,
      questions: preloadQuestions,
      mostRounds: o.preloadRounds,
      ...(preload ? { earlier: preload } : {}),
      stop: ctx.stop,
      onRound: (m) => {
        preload = m;
        writeResultFile(o.resultPath, head(), rows);
      },
    });
    preload = made.meta;
    preloadedPath = made.path;
  }
  if (o.arms.includes(Arm.With) && !ctx.stop.reason) {
    for (const c of o.cases) {
      const base = preloadedPath ?? pristine;
      if (c.group === BenefitGroup.Stale && c.staleFact) {
        const target = join(o.runDir, "stale", c.id, WIKI_DB_FILE);
        const proof =
          c.kind === BenefitKind.Question
            ? (c.proof[0] ?? { file: "", line: 1 })
            : { file: c.hiddenTests[0] ?? "", line: 1 };
        await writeStaleFact({ source: base, target, fact: c.staleFact, proof });
        ctx.sourceOf.set(c.id, target);
      } else ctx.sourceOf.set(c.id, base);
    }
  }
  writeResultFile(o.resultPath, head(), rows);
  await pool(
    o.concurrency,
    jobs.map((job) => async () => {
      if (ctx.stop.reason) return;
      const n = ++started;
      let row: ResultRow | undefined;
      try {
        row = job.c.kind === BenefitKind.Question ? await runQuestion(ctx, job, job.c) : await runTask(ctx, job, job.c);
      } catch (e) {
        // A fault of the harness or of the machine: the job leaves no row, so a resumed run does it again.
        failures.push(`${safe(job)}: ${errorMessage(e)}`);
        o.deps.log(`[${n}/${total}] ${safe(job)}: failed (${errorMessage(e).slice(0, ERROR_TEXT_CHARS)})`);
        return;
      }
      if (!row) {
        o.deps.log(`[${n}/${total}] ${safe(job)}: stopped (${ctx.stop.reason ?? ""})`);
        return;
      }
      rows.push(row);
      writeResultFile(o.resultPath, head(), rows);
      o.deps.log(
        `[${n}/${total}] ${safe(job)}: terms=${String(row.correct.terms ?? row.correct.tests)} judge=${row.correct.judge} $${money(row.costUsd)}${row.turns} turns${row.error ? ` error=${row.error.slice(0, LOG_ERROR_CHARS)}` : ""}`,
      );
    }),
  );
  const finished = doneKeys(rows);
  const skipped = jobs.filter((j) => !finished.has(runKey({ caseId: j.c.id, arm: j.arm, run: j.run }))).length;
  writeResultFile(o.resultPath, head(), rows);
  return {
    rows,
    summary: summarize(rows),
    ...(ctx.stop.reason ? { stoppedBy: ctx.stop.reason } : {}),
    skipped,
    failures,
  };
}
