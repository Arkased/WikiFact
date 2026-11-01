// One run of the correction test for one cap: seed, run the tasks, run the worker, count.
import { join } from "node:path";
import { closeStore } from "../../src/store/index.js";
import type { Questions } from "../../src/updates/index.js";
import { acceptAllQuestions } from "../../fakes/stub-consumer.js";
import { WorkerMode } from "../lib/enums.js";
import { pool } from "../lib/pool.js";
import { percentile } from "../lib/stats.js";
import { assignRows, type TimedOut } from "./assign-rows.js";
import type { Consumer, ConsumerOut } from "./consumers/types.js";
import { attribute, countRun, submissionsSince, type Counts, type TaskResult } from "./count.js";
import { loadData, type Data, type Task } from "./data.js";
import { errorMessage, must } from "../../src/must.js";
import { seedWiki, type Seeded } from "./seed.js";
import { drainQueue } from "./worker.js";

/** The tasks of one cap in flight at once when `RunOptions.concurrency` is absent. */
const DEFAULT_RUN_CONCURRENCY = 1;
/** The length of the error text kept in a task's log line, in characters. */
const LOG_ERROR_CHARS = 120;
/** Milliseconds in a second. */
const MS_PER_SECOND = 1000;
/** The percentiles of the task wall time, as fractions. */
const P50 = 0.5;
const P95 = 0.95;

/** The options of `runCorrections`. */
export interface RunOptions {
  /** The search cap of the wiki. */
  cap: number;
  /** True when the Stop hook is on. */
  hook: boolean;
  consumer: Consumer;
  /** The name for the report. */
  consumerName: string;
  workerMode: WorkerMode;
  /** The questions of the worker. Default: the stub that accepts every submission. */
  questions?: Questions;
  /** The folder for the databases and the consumers' files. */
  dir: string;
  /** Run only the first `limit` tasks. Default: all. */
  limit?: number;
  /** Tasks of one cap in flight at once. Default 1 here; the command defaults to 6. */
  concurrency?: number;
  /** The model id passed to the consumer. */
  model?: string;
  /** The relevance floor of the wiki, as a cosine distance. Default: the store default. */
  relevanceFloor?: number;
  log?: (s: string) => void;
}

/** The result of one cap. */
export interface RunReport {
  cap: number;
  hook: boolean;
  consumer: string;
  workerMode: WorkerMode;
  concurrency: number;
  counts: Counts;
  results: TaskResult[];
  /** The wall time of the whole run, in seconds. */
  seconds: number;
  /** Wall time per task: the sum over tasks, p50 and p95, in ms. `seconds` is the wall time of the whole run. */
  taskWall: { sumMs: number; p50Ms: number; p95Ms: number };
}

/** The input of `runTasks`. */
interface RunTasksInput {
  opts: RunOptions;
  seeded: Seeded;
  data: Data;
  tasks: Task[];
  runDir: string;
}

async function runTasks(input: RunTasksInput): Promise<TimedOut[]> {
  const { opts, seeded, data, tasks, runDir } = input;
  const log = opts.log ?? (() => undefined);
  return await pool<TimedOut>(
    opts.concurrency ?? DEFAULT_RUN_CONCURRENCY,
    tasks.map((task) => async () => {
      const startedAt = Date.now();
      let out: ConsumerOut;
      try {
        out = await opts.consumer(task, { seeded, data, hook: opts.hook, runDir, model: opts.model, log });
      } catch (e) {
        out = { answer: "", error: errorMessage(e) };
      }
      const failure = out.error ? ` error=${out.error.slice(0, LOG_ERROR_CHARS)}` : "";
      log(`${task.id} done in ${((Date.now() - startedAt) / MS_PER_SECOND).toFixed(1)}s${failure}`);
      return { out, startedAt, endedAt: Date.now() };
    }),
  );
}

type Attribution = Pick<TaskResult, "namesOwn" | "namesAny" | "namedBy">;

function taskResult(task: Task, t: TimedOut, subs: TaskResult["submissions"], attribution: Attribution): TaskResult {
  return {
    taskId: task.id,
    wrongKey: task.wrong,
    answer: t.out.answer,
    answerOk: t.out.answer.toLowerCase().includes(task.answerContains.toLowerCase()),
    toolCalls: t.out.toolCalls,
    costUsd: t.out.costUsd,
    turns: t.out.turns,
    error: t.out.error,
    startedAt: t.startedAt,
    wallMs: t.endedAt - t.startedAt,
    submissions: subs,
    ...attribution,
  };
}

/**
 * Runs the correction test for one cap: seeds a wiki, runs every task with the consumer, assigns the new
 * submissions to the tasks, runs the worker over the queue, and counts.
 *
 * @param opts - the cap, the hook, the consumer, the worker mode, the folder and the limits
 * @returns the report: counts, one result per task and the timing
 * @sideEffects creates the wiki database under `opts.dir`; runs the consumer (child processes, API calls, MCP tools that write retrievals and requests); the worker writes changes to the store; closes the store at the end
 */
export async function runCorrections(opts: RunOptions): Promise<RunReport> {
  const t0 = Date.now();
  const log = opts.log ?? (() => undefined);
  const data = loadData();
  const runDir = join(opts.dir, `cap${opts.cap}${opts.hook ? "-hook" : ""}`);
  const seeded = await seedWiki(join(runDir, "game.sqlite"), {
    cap: opts.cap,
    data,
    relevanceFloor: opts.relevanceFloor,
  });
  const runStart = Date.now();
  const workerRan = opts.workerMode !== WorkerMode.None;
  try {
    const seen = new Set(submissionsSince(seeded.store, new Set()).map((s) => s.id)); // the seed requests
    const tasks = data.tasks.slice(0, opts.limit ?? data.tasks.length);
    const timed = await runTasks({ opts, seeded, data, tasks, runDir });
    const assigned = assignRows({ rows: submissionsSince(seeded.store, seen), tasks, timed, data });
    const results = tasks.map((task, i) => {
      const subs = must(assigned[i], `no rows for task ${i}`);
      return taskResult(task, must(timed[i], `no timing for task ${i}`), subs, attribute(subs, task, seeded, data));
    });
    if (workerRan) {
      const r = await drainQueue(seeded, opts.questions ?? acceptAllQuestions(), { subject: data.subject });
      log(`worker (${opts.workerMode}): ${r.done} done, ${r.failed} failed`);
    }
    const counts = await countRun({ seeded, data, results, runStart, workerRan });
    const walls = results.map((r) => r.wallMs);
    return {
      cap: opts.cap,
      hook: opts.hook,
      consumer: opts.consumerName,
      workerMode: opts.workerMode,
      concurrency: opts.concurrency ?? DEFAULT_RUN_CONCURRENCY,
      counts,
      results,
      seconds: (Date.now() - t0) / MS_PER_SECOND,
      taskWall: {
        sumMs: walls.reduce((a, b) => a + b, 0),
        p50Ms: walls.length ? percentile(walls, P50) : 0,
        p95Ms: walls.length ? percentile(walls, P95) : 0,
      },
    };
  } finally {
    closeStore(seeded.store);
  }
}
