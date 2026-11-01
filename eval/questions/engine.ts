// The engine: one pool for the whole run, results grouped per configuration.
import { AsyncLocalStorage } from "node:async_hooks";
import { DEFAULT_QUESTION_TIMEOUT_S, costUsd, type QuestionSettings } from "../../src/config/index.js";
import { CallerKind, QuestionId, enumValues, questionMethod } from "../../src/domain/index.js";
import { readEnv } from "../../src/env.js";
import {
  RateLimitError,
  TransientError,
  buildQuestions,
  selectTransport,
  type CallRequest,
  type CallResponse,
  type QuestionContext,
  type Transport,
} from "../../src/updates/index.js";
import { CaseGroup, HardNegativeKind } from "../lib/enums.js";
import { errorMessage, must } from "../lib/questions-guard.js";
import { AdaptivePool, DEFAULT_CONCURRENCY } from "../lib/pool.js";
import { mean, percentile } from "../lib/stats.js";
import { PRICES } from "./models.js";
import { presetQuestions } from "./configs.js";
import { parseOutput, scoreAnswer, signature } from "./score.js";
import { caseRunAccuracy, casePassRate, halvesAccuracy, scoreOf, type Halves, type Score } from "./accuracy.js";
import { caseCtx, ctxOf, expandInput, groupOf, loadSet, type Case } from "./sets.js";

const MEDIAN = 0.5;
const P95 = 0.95;

interface TimingSink {
  wallMs: number;
  apiMs: number;
  apiKnown: boolean;
}

const sinks = new AsyncLocalStorage<TimingSink>();

/** Adds the time of each send to the call that is running (async local storage), so that parallel calls do not mix. */
class TimingTransport implements Transport {
  /**
   * Wraps a transport.
   *
   * @param inner - the transport that sends the request
   * @sideEffects none
   */
  constructor(private readonly inner: Transport) {}

  /**
   * Sends the request through the inner transport and records its time on the running call.
   *
   * @param req - the request
   * @param signal - aborts the call when the timeout fires
   * @returns the response of the inner transport
   * @sideEffects the inner send; reads the clock; adds to the timing sink of the running call
   */
  async send(req: CallRequest, signal: AbortSignal): Promise<CallResponse> {
    const t0 = Date.now();
    const r = await this.inner.send(req, signal);
    const sink = sinks.getStore();
    if (sink) {
      const reported = r.timing?.wallMs;
      // A transport that reports no time, or 0, gets the time measured here.
      sink.wallMs += reported !== undefined && reported > 0 ? reported : Date.now() - t0;
      if (r.timing?.apiMs !== undefined) {
        sink.apiMs += r.timing.apiMs;
        sink.apiKnown = true;
      }
    }
    return r;
  }
}

/** The median and the 95th percentile of a time in ms; null when there is no sample. */
interface Stat {
  p50: number | null;
  p95: number | null;
}

/** The time statistics of a set of calls. */
interface LatencyStats {
  calls: number;
  queueMs: Stat;
  wallMs: Stat;
  apiMs: Stat;
  overheadMs: Stat;
}

/** The time statistics of one run. */
interface RunLatency extends LatencyStats {
  run: number;
}

/** The time statistics over all runs of a configuration, and per run. */
export interface Latency extends LatencyStats {
  perRun: RunLatency[];
}

interface CallTimes {
  queueMs: number;
  wallMs: number;
  apiMs?: number;
}

const orNull = (x: number): number | null => (Number.isNaN(x) ? null : x);
const stat = (xs: number[]): Stat => ({ p50: orNull(percentile(xs, MEDIAN)), p95: orNull(percentile(xs, P95)) });

function statsOf(ts: CallTimes[]): LatencyStats {
  const known = ts.flatMap((t) => (t.apiMs === undefined ? [] : [{ wallMs: t.wallMs, apiMs: t.apiMs }]));
  return {
    calls: ts.length,
    queueMs: stat(ts.map((t) => t.queueMs)),
    wallMs: stat(ts.map((t) => t.wallMs)),
    apiMs: stat(known.map((t) => t.apiMs)),
    // The process cost: the wall time of the child minus the time of the API call that it reports.
    overheadMs: stat(known.map((t) => Math.max(0, t.wallMs - t.apiMs))),
  };
}

/** One call of one case in one run. */
interface CaseRun {
  pass: boolean;
  sig: string;
  why: string;
  error: boolean;
  times: CallTimes;
}

/**
 * The accuracy of one group of cases (or one kind of hard negative) in one configuration: the cases of it in the set
 * that ran, the mean over the runs of the share that passed (0..1) and its 95% interval.
 */
export interface GroupResult extends Score {
  /** The ids of the cases that failed in at least one run. */
  missed: string[];
}

/** The result of a configuration over the runs that have happened. */
export interface ConfigResult {
  settings: QuestionSettings;
  /** Accuracy per run, 0..1: the share of cases right. */
  runAccuracy: number[];
  mean: number;
  /** The 95% Wilson interval of the mean over all answers of the runs. */
  ci: [number, number];
  /** The share of runs in which each case was right, by case id. */
  casePassRate: Record<string, number>;
  allRunsPass: boolean;
  unstable: string[];
  failing: string[];
  /** The result of each group that has cases; a group with no case is absent. */
  groups: Partial<Record<CaseGroup, GroupResult>>;
  /** The result of each kind of hard negative that has cases; absent when the set names no kind. */
  kinds?: Partial<Record<HardNegativeKind, GroupResult>>;
  /** The score of the held-out half and of the tuning half; absent when the set has no held-out case. */
  halves?: Halves;
  errors: number;
  tokens: { input: number; output: number };
  /** The cache tokens inside `tokens.input`: read from the cache and written to it. */
  cache: { read: number; write: number };
  cost: number;
  latency: Latency;
}

/** The token counts of a configuration, summed over its calls. */
interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

type BuiltQuestions = ReturnType<typeof buildQuestions>;

/** A configuration of one question while it runs: its cases, its questions object and the grid of results. */
export interface ConfigRun {
  q: QuestionId;
  settings: QuestionSettings;
  cases: Case[];
  qs: BuiltQuestions;
  ctx: QuestionContext;
  /** The result of each call: `grid[case][run]`. */
  grid: CaseRun[][];
  pending: number;
  runsDone: number;
  startedAt: string;
  usage: UsageTotals;
}

/**
 * Prepares a configuration: loads the set and builds the questions on a timing transport.
 *
 * @param q - the question
 * @param settings - the model and effort to try
 * @param transport - the transport that sends the calls
 * @param opts - narrows the run to a part of the set: how many cases
 * @param opts.limit - the number of cases to keep; absent keeps all
 * @returns the configuration, with no call made yet
 * @sideEffects reads the set file and the presets file
 */
export function makeConfigRun(
  q: QuestionId,
  settings: QuestionSettings,
  transport: Transport,
  opts: { limit?: number } = {},
): ConfigRun {
  const { limit } = opts;
  const set = loadSet(q);
  return {
    q,
    settings,
    cases: set.cases.slice(0, limit),
    ctx: ctxOf(set),
    qs: buildQuestions({
      settings: { ...presetQuestions(), [q]: settings },
      timeoutSeconds: DEFAULT_QUESTION_TIMEOUT_S,
      transport: new TimingTransport(transport),
    }),
    grid: [],
    pending: 0,
    runsDone: 0,
    startedAt: new Date().toISOString(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

type QuestionCall = (input: unknown, ctx: unknown) => Promise<unknown>;

// The method of `Questions` that asks question `q`.
function questionMethodOf(qs: BuiltQuestions, q: QuestionId): QuestionCall {
  const method: unknown = Reflect.get(qs, questionMethod(q));
  if (typeof method !== "function") throw new Error(`Questions has no method for ${q}`);
  return (input, ctx) => Promise.resolve(Reflect.apply(method, qs, [input, ctx]));
}

// Asks one case once. A rate limit or a transient error is rethrown for the pool to retry; any other error is the result of the call.
async function runCase(c: ConfigRun, ask: QuestionCall, testCase: Case, waitMs: number): Promise<CaseRun> {
  const sink: TimingSink = { wallMs: 0, apiMs: 0, apiKnown: false };
  const times = (): CallTimes => ({
    queueMs: waitMs,
    wallMs: sink.wallMs,
    apiMs: sink.apiKnown ? sink.apiMs : undefined,
  });
  try {
    const input = expandInput(c.q, testCase.input);
    const raw = await sinks.run(sink, () => ask(input, caseCtx(c.ctx, testCase)));
    const out = parseOutput(c.q, raw);
    const s = scoreAnswer(c.q, out, testCase.expect, input);
    return {
      pass: s.pass,
      sig: signature(c.q, out),
      why: s.why,
      error: false,
      times: times(),
    };
  } catch (e) {
    if (e instanceof RateLimitError || e instanceof TransientError) throw e; // the pool retries (slowing down for a rate limit)
    return {
      pass: false,
      sig: "error",
      why: errorMessage(e),
      error: true,
      times: times(),
    };
  }
}

/**
 * Submits every case of the given runs of every configuration to the one pool.
 *
 * @param cfgs - the configurations to run
 * @param runs - the run numbers (from 0) to make for each
 * @param pool - the pool that limits the calls in flight
 * @param onDone - fires when a configuration has all its calls
 * @returns when every call has settled
 * @sideEffects model calls through the transports of the configurations; fills the grid of each configuration
 */
export async function runStage(
  cfgs: ConfigRun[],
  runs: number[],
  pool: AdaptivePool,
  onDone: (c: ConfigRun) => void,
): Promise<void> {
  const all: Promise<void>[] = [];
  const lastRun = Math.max(...runs);
  for (const c of cfgs) {
    c.grid = c.grid.length ? c.grid : c.cases.map(() => []);
    c.pending += runs.length * c.cases.length;
    const ask = questionMethodOf(c.qs, c.q);
    for (const r of runs) {
      c.cases.forEach((testCase, ci) => {
        const settle = (one: CaseRun): void => {
          must(c.grid[ci], `no result row for case ${testCase.id}`)[r] = one;
          if (--c.pending === 0) {
            c.runsDone = Math.max(c.runsDone, lastRun + 1);
            onDone(c);
          }
        };
        const failed = (e: unknown): void =>
          settle({
            pass: false,
            sig: "error",
            why: errorMessage(e),
            error: true,
            times: { queueMs: 0, wallMs: 0 },
          });
        all.push(pool.submit(({ waitMs }) => runCase(c, ask, testCase, waitMs)).then(settle, failed));
      });
    }
  }
  await Promise.all(all);
}

/**
 * Computes the result of a configuration over the runs that have happened, and adds the usage since the last call.
 *
 * @param c - the configuration
 * @returns accuracy per run, the unstable and failing cases, tokens, cost and latency
 * @sideEffects takes the token usage from the questions object of the configuration, which resets it
 */
export function resultOf(c: ConfigRun): ConfigResult {
  const runs = c.runsDone;
  const rowOf = (ci: number): CaseRun[] => c.grid[ci] ?? [];
  const grid = c.cases.map((_case, ci) => rowOf(ci));
  const runAccuracy = caseRunAccuracy(grid, runs);
  const unstable: string[] = [];
  const failing: string[] = [];
  let errors = 0;
  c.cases.forEach((cs, ci) => {
    const g = rowOf(ci).slice(0, runs);
    errors += g.filter((x) => x.error).length;
    if (new Set(g.map((x) => x.sig)).size > 1 || new Set(g.map((x) => x.pass)).size > 1) unstable.push(cs.id);
    const bad = g.find((x) => !x.pass);
    if (bad) failing.push(`${cs.id}: ${bad.why}`);
  });
  // The result of the cases that `selected` picks; undefined when it picks none.
  const resultOfCases = (selected: (cs: Case) => boolean): GroupResult | undefined => {
    const idx = c.cases.flatMap((cs, ci) => (selected(cs) ? [ci] : []));
    if (idx.length === 0) return undefined;
    const missed = idx
      .filter((ci) =>
        rowOf(ci)
          .slice(0, runs)
          .some((x) => !x.pass),
      )
      .map((ci) => must(c.cases[ci], "a case index is in range").id);
    return {
      ...scoreOf(
        idx.map((ci) => rowOf(ci)),
        runs,
      ),
      missed,
    };
  };
  const groups: ConfigResult["groups"] = {};
  for (const g of enumValues(CaseGroup)) {
    const r = resultOfCases((cs) => groupOf(cs) === g);
    if (r) groups[g] = r;
  }
  const kinds: NonNullable<ConfigResult["kinds"]> = {};
  for (const k of enumValues(HardNegativeKind)) {
    const r = resultOfCases((cs) => cs.kind === k);
    if (r) kinds[k] = r;
  }
  const halves = halvesAccuracy(
    grid,
    c.cases.map((cs) => cs.heldOut === true),
    runs,
  );
  const u = c.qs.takeUsage();
  c.usage.input += u.input;
  c.usage.output += u.output;
  c.usage.cacheRead += u.cacheRead ?? 0;
  c.usage.cacheWrite += u.cacheWrite ?? 0;
  const timesOfRun = (r: number): CallTimes[] => c.cases.flatMap((_case, ci) => rowOf(ci)[r]?.times ?? []);
  const allTimes = Array.from({ length: runs }, (_, r) => timesOfRun(r)).flat();
  return {
    settings: c.settings,
    runAccuracy,
    mean: mean(runAccuracy),
    ci: scoreOf(grid, runs).ci,
    casePassRate: casePassRate(
      grid,
      c.cases.map((cs) => cs.id),
      runs,
    ),
    allRunsPass: runAccuracy.every((a) => a === 1),
    unstable,
    failing,
    groups,
    ...(Object.keys(kinds).length > 0 ? { kinds } : {}),
    ...(halves ? { halves } : {}),
    errors,
    tokens: { input: c.usage.input + c.usage.cacheRead + c.usage.cacheWrite, output: c.usage.output },
    cache: { read: c.usage.cacheRead, write: c.usage.cacheWrite },
    cost: costUsd(PRICES, c.settings.model, c.usage),
    latency: {
      ...statsOf(allTimes),
      perRun: Array.from({ length: runs }, (_, r) => ({ run: r + 1, ...statsOf(timesOfRun(r)) })),
    },
  };
}

/**
 * Gives the mean accuracy of the first run of a configuration, in the unit of its bar: the share of cases that passed.
 *
 * @param c - the configuration, after its first run
 * @returns the accuracy of run 0, 0..1
 * @sideEffects none
 */
export function firstRunMean(c: ConfigRun): number {
  return c.cases.filter((_case, ci) => c.grid[ci]?.[0]?.pass).length / c.cases.length;
}

/** The options of `runConfig`. */
export interface RunConfigOptions {
  q: QuestionId;
  settings: QuestionSettings;
  runs: number;
  /** The number of cases to keep; absent keeps all. */
  limit?: number;
  /** Default: the transport that the eval rules choose. */
  transport?: Transport;
  /** Calls in flight; default: `DEFAULT_CONCURRENCY`. */
  concurrency?: number;
}

/**
 * Runs one configuration in a pool of its own. The tests and single runs use it.
 *
 * @param o - the question, the settings, the runs and the optional limit, transport and concurrency
 * @returns the result over all runs
 * @sideEffects model calls through the transport; reads the set file and the presets file
 */
export async function runConfig(o: RunConfigOptions): Promise<ConfigResult> {
  const transport = o.transport ?? selectTransport(CallerKind.Eval, readEnv()).transport;
  const c = makeConfigRun(o.q, o.settings, transport, { limit: o.limit });
  await runStage(
    [c],
    Array.from({ length: o.runs }, (_, i) => i),
    new AdaptivePool({ start: o.concurrency ?? DEFAULT_CONCURRENCY }),
    () => undefined,
  );
  return resultOf(c);
}
