// The stubs of the benefit test (`eval/benefit.ts --stub`) and its tests: an agent that returns the labeled answer or
// applies the reference patch, a judge that agrees with it, and a checker that passes when the agent changed a file.
// They prove the arms, the rows, the summary and the cleanup with no model call. They measure nothing about a model.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config/index.js";
import { ChangeOutcome } from "../src/domain/index.js";
import { WIKI_DB_FILE } from "../src/paths.js";
import { closeStore, enqueueRequest, openStoreFor, seedChange } from "../src/store/index.js";
import type { AgentJob, AgentRunner } from "../eval/benefit/agent.js";
import { BenefitKind, Arm, Verdict } from "../eval/lib/enums.js";
import type { Judge } from "../eval/benefit/judge.js";
import { WIKI_TOOL_PREFIX, promptOf } from "../eval/benefit/arms.js";
import { taskFolder, type BenefitCase } from "../eval/benefit/cases.js";
import type { StreamResult } from "../eval/benefit/stream.js";
import type { TaskChecker } from "../eval/benefit/task-check.js";
import { applyPatch, diffOf } from "../eval/benefit/worktree.js";

/** The dollars of a stub run in the arm "with". */
const STUB_COST_WITH = 0.02;
/** The dollars of a stub run in the arm "without". */
const STUB_COST_WITHOUT = 0.03;
/** The turns of a stub run in the arm "with". */
const STUB_TURNS_WITH = 3;
/** The turns of a stub run in the arm "without". */
const STUB_TURNS_WITHOUT = 5;
/** The input tokens of a stub run. */
const STUB_INPUT_TOKENS = 1000;
/** The characters of the prompt that a stub run sends as its search query. */
const STUB_QUERY_CHARS = 40;
/** The output tokens of a stub run. */
const STUB_OUTPUT_TOKENS = 100;

function stubResult(job: AgentJob, answer: string): StreamResult {
  const withWiki = job.arm === Arm.With;
  return {
    answer,
    costUsd: withWiki ? STUB_COST_WITH : STUB_COST_WITHOUT,
    turns: withWiki ? STUB_TURNS_WITH : STUB_TURNS_WITHOUT,
    usage: { input: STUB_INPUT_TOKENS, output: STUB_OUTPUT_TOKENS, cacheRead: 0, cacheWrite: 0 },
    toolCalls: withWiki
      ? [{ tool: `${WIKI_TOOL_PREFIX}search`, query: job.prompt.slice(0, STUB_QUERY_CHARS) }, { tool: "Read" }]
      : [{ tool: "Read" }, { tool: "Read" }, { tool: "Grep" }],
  };
}

/** What the stub agent knows that a real agent does not: the cases, to find the label or the reference patch of its prompt. */
export interface StubKnowledge {
  cases: BenefitCase[];
  /** The cases file, to find the folder of a task. */
  casesPath: string;
}

/**
 * The wiki database that the server of an agent job serves, read from the `--mcp-config` file of the job.
 *
 * @param job - an agent job of the arm "with"
 * @returns the path of the database
 * @throws {Error} when the config names no server
 * @sideEffects reads the config file
 */
export function jobDatabase(job: AgentJob): string {
  const config = JSON.parse(readFileSync(job.mcpConfigPath, "utf8")) as {
    mcpServers: Record<string, { args: string[] }>;
  };
  const db = Object.values(config.mcpServers)[0]?.args.at(-1);
  if (db === undefined) throw new Error("the job has no wiki server");
  return db;
}

/**
 * Queues a submission in a wiki database, as an agent that calls `requestChange` does.
 *
 * @param dbPath - the wiki database
 * @param change - the change text; the stub questions make a fact of it
 * @sideEffects opens the database and inserts a queued request
 */
export function submitStubChange(dbPath: string, change: string): void {
  const store = openStoreFor(loadConfig(dbPath), dbPath);
  try {
    enqueueRequest(store, { change, justification: "Stated by the stub agent." });
  } finally {
    closeStore(store);
  }
}

/** The options of the stub agent. */
export interface StubAgentOptions {
  /** True to make a run of the arm "with" on a question queue a submission, so that the preload has changes to process. */
  submits?: boolean;
}

/**
 * The stub agent: for a question it answers with the labeled answer; for a task it applies the reference patch to its
 * worktree. It finds its case by the prompt, so `AgentJob` carries nothing for a stub.
 *
 * @param known - the cases and the cases file
 * @param opts - whether a question run queues a submission in its wiki
 * @returns an agent runner with a fixed usage that differs by arm
 * @throws {Error} (from the runner) when the prompt is the prompt of no case
 * @sideEffects for a task, `git apply` in the worktree of the job; with `submits`, a write to the wiki database of the job
 */
export function stubAgent(known: StubKnowledge, opts: StubAgentOptions = {}): AgentRunner {
  return async (job) => {
    const c = known.cases.find((x) =>
      x.kind === BenefitKind.Question
        ? promptOf(x.question, x.kind) === job.prompt
        : promptOf(x.issue, x.kind) === job.prompt,
    );
    if (!c) throw new Error("the stub agent knows no case with this prompt");
    if (c.kind === BenefitKind.Question) {
      if (opts.submits && job.arm === Arm.With) submitStubChange(jobDatabase(job), `Stub note on ${c.id}: ${c.answer}`);
      return stubResult(job, c.answer);
    }
    await applyPatch(job.cwd, join(taskFolder(known.casesPath, c.id), c.referencePatch));
    return stubResult(job, "done");
  };
}

/**
 * The stub judge: an answer is correct when it holds the labeled answer; a diff is correct when it is not empty.
 *
 * @returns a judge
 * @sideEffects none
 */
export function stubJudge(): Judge {
  return {
    judgeAnswer: (i) =>
      Promise.resolve(
        i.answer.includes(i.labeledAnswer)
          ? { verdict: Verdict.Correct, reason: "stub: the answer holds the label" }
          : { verdict: Verdict.Wrong, reason: "stub: the answer lacks the label" },
      ),
    judgeDiff: (i) =>
      Promise.resolve(
        i.diff.trim() === ""
          ? { verdict: Verdict.Wrong, reason: "stub: empty diff" }
          : { verdict: Verdict.Correct, reason: "stub: the diff is not empty" },
      ),
  };
}

/**
 * Makes a small wiki database for a `--stub` run that was given no `--db`: 1 fact.
 *
 * @param folder - the folder to make the wiki in; created
 * @returns the path of the database
 * @sideEffects writes the database in the folder; the embedder runs for the fact (the caller sets the fake one)
 */
export async function makeStubWiki(folder: string): Promise<string> {
  mkdirSync(folder, { recursive: true });
  const path = join(folder, WIKI_DB_FILE);
  const store = openStoreFor(loadConfig(path), path);
  try {
    await seedChange(store, {
      outcome: ChangeOutcome.Accepted,
      summary: "Stub wiki",
      changeReasoning: "Stub wiki for the harness proof.",
      facts: [
        {
          header: "Stub fact",
          content: "The stub wiki holds one fact.",
          justification: "Made by the stub.",
          references: [],
        },
      ],
    });
  } finally {
    closeStore(store);
  }
  return path;
}

/**
 * The stub checker: the hidden tests and the type check pass when the worktree differs from its baseline.
 *
 * @returns a checker
 * @sideEffects `git add -A` in the worktree
 */
export function stubChecker(): TaskChecker {
  return async (dir) => {
    const changed = (await diffOf(dir)).files.length > 0;
    return { testsPass: changed, typecheckPass: changed, output: "" };
  };
}
