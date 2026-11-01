import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AdaptivePool } from "../pool.js";
import { must } from "../questions-guard.js";
import { barOf, parseStage, passes, readResultFile } from "../../questions/results.js";
import { runSets, stageThreshold, type RunSetsArgs, type RunTarget } from "../../questions/run-sets.js";
import { ctxOf, expandInput, loadSet } from "../../questions/sets.js";
import { ResultStage } from "../enums.js";
import { PROCESS_START_TIMEOUT_MS } from "../../../__tests__/helpers/timeouts.js";
import { Effort, MessageRole, QuestionId, QuestionKind } from "../../../src/domain/enums.js";
import {
  CliTransport,
  RateLimitError,
  SPECS,
  TransientError,
  looksTransient,
  type CallRequest,
  type CallResponse,
  type QuestionSpec,
  type Transport,
} from "../../../src/updates/questions/index.js";

// Lets the other jobs start while this one is open: a turn of the event loop, not a time.
const tick = () => new Promise((r) => setImmediate(r));
const tmp = () => join(mkdtempSync(join(tmpdir(), "pool-")), "out.json");
const A = (over: Partial<RunSetsArgs> = {}): RunSetsArgs => ({
  qs: [QuestionId.Q1],
  models: [],
  efforts: [],
  runs: 3,
  limit: 5,
  concurrency: 8,
  pool: { pauseMs: 5, maxPauseMs: 20, climbEvery: 3 },
  ...over,
});

// Where a run sends its calls and its output; the lines go nowhere unless `print` is given.
const T = (transport: Transport, outPath: string, print: (s: string) => void = () => undefined): RunTarget => ({
  transport,
  transportName: "fake",
  outPath,
  print,
});

describe("the adaptive pool", () => {
  it("runs at most `limit` calls at once", async () => {
    const p = new AdaptivePool({ start: 3 });
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 12 }, () =>
        p.submit(async () => {
          active++;
          peak = Math.max(peak, active);
          await tick();
          active--;
        }),
      ),
    );
    expect(peak).toBe(3);
  });

  it("halves the limit on a rate limit (floor 2), retries the call, and logs the first text once", async () => {
    const seen: string[] = [];
    const p = new AdaptivePool({
      start: 24,
      pauseMs: 5,
      maxPauseMs: 20,
      climbEvery: 1000,
      onFirstRateLimit: (t) => seen.push(t),
    });
    let failures = 0;
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        p.submit(() => {
          if (failures < 3) {
            failures++;
            return Promise.reject(
              new RateLimitError("rate limited", `429 {"error":"rate_limit_error"} call ${failures}`),
            );
          }
          return Promise.resolve(i);
        }),
      ),
    );
    expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]); // every call finished after its retry
    expect(p.rateLimitRetries).toBe(3);
    expect(seen).toEqual(['429 {"error":"rate_limit_error"} call 1']); // the exact text, once
    expect(p.limit).toBe(12); // a burst halves once
    expect(p.history[0]).toEqual({ t: 0, limit: 24 });
    expect(p.history.at(-1)?.limit).toBe(12);
  });

  it("keeps halving across separate rate limits down to the floor of 2", async () => {
    const pauseMs = 5;
    const p = new AdaptivePool({ start: 24, pauseMs, maxPauseMs: 10, climbEvery: 1000 });
    let n = 0;
    // Only the Date is fake: the clock moves when the test moves it.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      for (let round = 0; round < 6; round++) {
        let failed = false;
        await p.submit(() => {
          if (!failed) {
            failed = true;
            n++;
            return Promise.reject(new RateLimitError("x", "429"));
          }
          return Promise.resolve();
        });
        vi.setSystemTime(Date.now() + pauseMs); // past the window, so the next burst counts
      }
    } finally {
      vi.useRealTimers();
    }
    expect(n).toBe(6);
    expect(p.limit).toBe(2);
    expect(p.history.map((h) => h.limit)).toEqual([24, 12, 6, 3, 2]);
  });

  it("climbs back by 1 every `climbEvery` successful calls, up to the start value", async () => {
    const p = new AdaptivePool({ start: 6, pauseMs: 5, maxPauseMs: 10, climbEvery: 4 });
    let failed = false;
    await p.submit(() => {
      if (!failed) {
        failed = true;
        return Promise.reject(new RateLimitError("x", "429"));
      }
      return Promise.resolve();
    });
    expect(p.limit).toBe(3);
    for (let i = 0; i < 40; i++) await p.submit(() => Promise.resolve(i));
    expect(p.limit).toBe(6); // never above the start
    const limits = p.history.map((h) => h.limit);
    expect(limits).toEqual([6, 3, 4, 5, 6]);
    expect(p.history.every((h, i) => i === 0 || h.t >= (p.history[i - 1]?.t ?? Infinity))).toBe(true);
  });

  it("returns the rate-limit error after the attempts are used, and passes other errors at once", async () => {
    const p = new AdaptivePool({ start: 4, pauseMs: 1, maxPauseMs: 2, maxAttempts: 3 });
    await expect(p.submit(() => Promise.reject(new RateLimitError("always", "429")))).rejects.toBeInstanceOf(
      RateLimitError,
    );
    expect(p.rateLimitRetries).toBe(2);
    await expect(p.submit(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
  });
});

// Answers each Q1 case from its label. `wrongFirst[model]` makes the first k distinct inputs wrong for that model.
function q1Transport(
  opts: {
    wrongFirst?: Record<string, number>;
    timing?: CallResponse["timing"];
    limitFirst?: number;
    calls?: string[];
  } = {},
): Transport {
  const set = loadSet(QuestionId.Q1);
  const ctx = ctxOf(set);
  const spec = SPECS[QuestionId.Q1] as unknown as QuestionSpec<unknown, unknown>;
  const byMessage = new Map<string, string[]>();
  for (const c of set.cases)
    byMessage.set(spec.render(expandInput(QuestionId.Q1, c.input), ctx), c.expect.matches ?? []);
  const order = new Map<string, number>();
  let limited = 0;
  return {
    send(req: CallRequest): Promise<CallResponse> {
      opts.calls?.push(`${req.model}/${req.effort}`);
      if (limited < (opts.limitFirst ?? 0)) {
        limited++;
        return Promise.reject(new RateLimitError("rate limited", "API Error: 429 rate_limit_error"));
      }
      const msg = req.messages[0]?.content ?? "";
      const key = `${req.model}|${msg}`;
      if (!order.has(key)) order.set(key, [...order.keys()].filter((k) => k.startsWith(`${req.model}|`)).length);
      const wrong = (opts.wrongFirst?.[req.model] ?? 0) > (order.get(key) ?? 0);
      const matches = wrong ? ["zzz"] : (byMessage.get(msg) ?? []);
      return Promise.resolve({
        stopReason: "end_turn",
        text: JSON.stringify({ matches }),
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
        timing: opts.timing,
      });
    },
  };
}

describe("result stage", () => {
  it("parses the number, the string and the word of the result files into the enum", () => {
    expect(parseStage(1)).toBe(ResultStage.One);
    expect(parseStage(2)).toBe(ResultStage.Two);
    expect(parseStage("1")).toBe(ResultStage.One);
    expect(parseStage("full")).toBe(ResultStage.Full);
    expect(parseStage(undefined)).toBeUndefined();
    expect(parseStage(3)).toBeUndefined();
  });
});

describe("staged runs", () => {
  it("the staging bar lies under the pass bar of the question, so that a near miss gets the other runs", () => {
    for (const q of [QuestionId.Q1, QuestionId.Q4]) {
      expect(stageThreshold(q)).toBeLessThan(barOf(q).mean);
      expect(stageThreshold(q)).toBeGreaterThan(0);
    }
  });

  it("stage 1 runs every configuration once, stage 2 adds the other runs only near or above the bar", async () => {
    const calls: string[] = [];
    const f = await runSets(
      A({ models: ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5"], efforts: [Effort.Low], limit: 5 }),
      T(q1Transport({ calls, wrongFirst: { "claude-opus-5-5": 1, "claude-haiku-5-5": 3 } }), tmp()), // 5 cases: opus 80 percent, haiku 40 percent
    );
    const by = Object.fromEntries(f.results.map((r) => [r.model, r]));
    expect(by["claude-sonnet-5-5"]).toMatchObject({ runs: 3, stage: ResultStage.Two, mean: 1 }); // above the bar
    expect(by["claude-opus-5-5"]).toMatchObject({ runs: 3, stage: ResultStage.Two }); // 80 percent: within the slack, so 3 runs
    expect(by["claude-haiku-5-5"]).toMatchObject({ runs: 1, stage: ResultStage.One }); // 40 percent: stays at one run
    expect(by["claude-haiku-5-5"]?.runAccuracy).toEqual([0.4]);
    expect(calls.filter((c) => c.startsWith("claude-haiku-5-5")).length).toBe(5); // 5 cases x 1 run
    expect(calls.filter((c) => c.startsWith("claude-sonnet-5-5")).length).toBe(15); // 5 cases x 3 runs
    expect(f.staged).toBe(true);
    expect(f.runs).toBe(3);
  });

  it("--full runs all the runs of every configuration at once and marks the stage", async () => {
    const f = await runSets(
      A({ models: ["claude-haiku-5-5"], efforts: [Effort.Low], full: true }),
      T(q1Transport({ wrongFirst: { "claude-haiku-5-5": 5 } }), tmp()),
    );
    expect(f.staged).toBe(false);
    expect(f.results[0]).toMatchObject({ runs: 3, stage: ResultStage.Full, mean: 0 });
  });

  it("a one-run configuration below the bar fails the pass bar, a three-run one is judged as before", () => {
    const e = (runAccuracy: number[]) => ({
      question: QuestionId.Q4,
      mean: runAccuracy.reduce((a, b) => a + b, 0) / runAccuracy.length,
      runAccuracy,
    });
    expect(passes(e([0.5]))).toBe(false);
    expect(passes(e([0.97, 0.97, 0.85]))).toBe(true);
    expect(passes(e([1, 1, 0.8]))).toBe(false);
  });

  it("one pool for the run: the calls of different configurations run together", async () => {
    let active = 0;
    let peak = 0;
    const inner = q1Transport();
    const slow: Transport = {
      async send(req, signal) {
        active++;
        peak = Math.max(peak, active);
        await tick();
        active--;
        return inner.send(req, signal);
      },
    };
    await runSets(
      A({
        models: ["claude-sonnet-5-5", "claude-opus-5-5"],
        efforts: [Effort.Low],
        limit: 3,
        runs: 1,
        concurrency: 12,
      }),
      T(slow, tmp()),
    );
    expect(peak).toBeGreaterThan(3); // 3 cases per configuration alone could not reach it
    expect(peak).toBeLessThanOrEqual(6);
  });
});

describe("rate limits and latency in the result file", () => {
  it("halves the limit on a rate limit, retries, and records the limit over time and the retries", async () => {
    const lines: string[] = [];
    const out = tmp();
    const f = await runSets(
      A({ models: ["claude-sonnet-5-5"], efforts: [Effort.Low], runs: 1, concurrency: 8 }),
      T(q1Transport({ limitFirst: 2 }), out, (s) => lines.push(s)),
    );
    expect(f.results[0]).toMatchObject({ mean: 1, errors: 0 }); // every call finished after its retry
    const disk = readResultFile(out);
    expect(disk.pool.start).toBe(8);
    expect(disk.pool.rateLimitRetries).toBe(2);
    expect(disk.pool.firstRateLimitText).toBe("API Error: 429 rate_limit_error");
    expect(disk.pool.limitHistory[0]).toEqual({ t: 0, limit: 8 });
    expect(disk.pool.limitHistory.some((h) => h.limit === 4)).toBe(true);
    expect(lines.filter((l) => l.includes("rate limit: the first one said")).length).toBe(1); // logged once
    expect(lines.join("\n")).toContain('"API Error: 429 rate_limit_error"');
  });

  it("records queue wait, wall time, API time and the overhead, p50 and p95, per configuration and per run", async () => {
    const out = tmp();
    await runSets(
      A({ models: ["claude-sonnet-5-5"], efforts: [Effort.Low], runs: 2, limit: 4 }),
      T(q1Transport({ timing: { wallMs: 1000, apiMs: 600 } }), out),
    );
    const latency = must(readResultFile(out).results[0]?.latency, "the entry has no latency");
    expect(latency).toMatchObject({
      calls: 8,
      wallMs: { p50: 1000, p95: 1000 },
      apiMs: { p50: 600, p95: 600 },
      overheadMs: { p50: 400, p95: 400 },
    });
    expect(latency.queueMs.p50).toBeGreaterThanOrEqual(0);
    expect(latency.queueMs.p95).not.toBeNull();
    expect(latency.perRun).toHaveLength(2);
    expect(latency.perRun[0]).toMatchObject({ run: 1, calls: 4, overheadMs: { p50: 400 } });
    expect(latency.perRun[1]).toMatchObject({ run: 2, calls: 4 });
  });

  it("without an API time (the SDK path) the overhead is null, not zero", async () => {
    const out = tmp();
    await runSets(
      A({ models: ["claude-sonnet-5-5"], efforts: [Effort.Low], runs: 1, limit: 2 }),
      T(q1Transport({ timing: { wallMs: 50 } }), out),
    );
    const latency = must(readResultFile(out).results[0]?.latency, "the entry has no latency");
    expect(latency.wallMs.p50).toBe(50);
    expect(latency.apiMs.p50).toBeNull();
    expect(latency.overheadMs.p50).toBeNull();
  });
});

describe("the CLI transport reports rate limits and timing", { timeout: PROCESS_START_TIMEOUT_MS }, () => {
  const fake = join(import.meta.dirname, "..", "..", "..", "__tests__", "helpers", "fake-claude.mjs");
  const req: CallRequest = {
    model: "claude-sonnet-5-5",
    kind: QuestionKind.Classification,
    effort: Effort.Low,
    system: "S",
    messages: [{ role: MessageRole.User, content: "M" }],
    schema: { type: "object" },
    maxTokens: 4096,
    stream: false,
    thinking: true,
    fallback: false,
  };
  const send = (script: unknown[]) => {
    const dir = mkdtempSync(join(tmpdir(), "fc-"));
    process.env.FAKE_LOG = join(dir, "calls.jsonl");
    process.env.FAKE_SCRIPT = JSON.stringify(script);
    return new CliTransport({ claudeBin: process.execPath, prefixArgs: [fake], childEnv: process.env }).send(
      req,
      new AbortController().signal,
    );
  };

  it("a 429 on stderr or in an error result is a RateLimitError that keeps the text", async () => {
    await expect(
      send([
        {
          exit: 1,
          out: {
            type: "result",
            is_error: true,
            subtype: "error_during_execution",
            result: "API Error: 429 rate_limit_error",
          },
        },
      ]),
    ).rejects.toMatchObject({ text: expect.stringContaining("429") as unknown });
    await expect(
      send([
        { out: { type: "result", subtype: "success", is_error: true, result: "Rate limit reached for this account" } },
      ]),
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it("an ordinary failure is not a rate limit", async () => {
    await expect(send([{ exit: 1 }])).rejects.not.toBeInstanceOf(RateLimitError);
  });

  it("reports the child wall time and duration_api_ms", async () => {
    const r = await send([
      { out: { type: "result", subtype: "success", is_error: false, result: "{}", duration_api_ms: 1234, usage: {} } },
    ]);
    expect(r.timing?.apiMs).toBe(1234);
    expect(r.timing?.wallMs).toBeGreaterThan(0);
  });
});

describe(
  "a config directory of its own per child (the ~/.claude.json race)",
  { timeout: PROCESS_START_TIMEOUT_MS },
  () => {
    const fake = join(import.meta.dirname, "..", "..", "..", "__tests__", "helpers", "fake-claude.mjs");
    const req: CallRequest = {
      model: "claude-haiku-5-5",
      kind: QuestionKind.Classification,
      effort: Effort.Low,
      system: "S",
      messages: [{ role: MessageRole.User, content: "M" }],
      schema: { type: "object" },
      maxTokens: 4096,
      stream: false,
      thinking: true,
      fallback: false,
    };
    interface FakeCall {
      configDir: string;
      configDirExists: boolean;
    }
    const setup = (script: unknown[]): (() => FakeCall[]) => {
      const dir = mkdtempSync(join(tmpdir(), "fc-"));
      const log = join(dir, "calls.jsonl");
      process.env.FAKE_LOG = log;
      process.env.FAKE_SCRIPT = JSON.stringify(script);
      return () =>
        readFileSync(log, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as FakeCall);
    };
    // The children answer once all 6 have started, so that each config directory exists while its child runs.
    const ok = {
      waitForPeers: 6,
      out: { type: "result", subtype: "success", is_error: false, result: "{}", usage: {} },
    };

    it("sets CLAUDE_CONFIG_DIR to a fresh directory per call, empty of the user's config, and removes it afterwards", async () => {
      const calls = setup([ok]);
      const t = new CliTransport({ claudeBin: process.execPath, prefixArgs: [fake], childEnv: process.env });
      const home = process.env.CLAUDE_CONFIG_DIR;
      await Promise.all(Array.from({ length: 6 }, () => t.send(req, new AbortController().signal)));
      const c = calls();
      expect(c).toHaveLength(6);
      expect(new Set(c.map((x) => x.configDir)).size).toBe(6); // one per child
      for (const x of c) {
        expect(x.configDir).toBeTruthy();
        expect(x.configDir).not.toBe(home);
        expect(relative(join(homedir(), ".claude"), x.configDir).startsWith("..")).toBe(true); // not the user's folder
        expect(x.configDirExists).toBe(true); // it existed while the child ran
      }
      // removed after the call
      await vi.waitFor(() => {
        for (const x of c) expect(existsSync(x.configDir)).toBe(false);
      });
    });

    it("the corrupted-config text is a TransientError that keeps the text, not a rate limit", async () => {
      const text =
        "Claude configuration file at C:\\Config\\.claude.json is corrupted: JSON Parse error: Unexpected EOF";
      setup([{ exit: 1, stderr: text }]);
      const err = await new CliTransport({ claudeBin: process.execPath, prefixArgs: [fake], childEnv: process.env })
        .send(req, new AbortController().signal)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TransientError);
      expect(err).not.toBeInstanceOf(RateLimitError);
      if (!(err instanceof TransientError)) throw new Error("expected a TransientError");
      expect(err.text).toContain("is corrupted: JSON Parse error: Unexpected EOF");
      expect(looksTransient(text)).toBe(true);
      expect(looksTransient("Not logged in")).toBe(false);
    });
  },
);

describe("the pool retries a transient error without halving the limit", () => {
  it("retries, counts it, and leaves the limit alone", async () => {
    const p = new AdaptivePool({ start: 24, pauseMs: 5, maxPauseMs: 10 });
    let failures = 0;
    const out = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        p.submit(() => {
          if (failures < 3) {
            failures++;
            return Promise.reject(new TransientError("transient", "configuration file X is corrupted"));
          }
          return Promise.resolve(i);
        }),
      ),
    );
    expect(out).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(p.transientRetries).toBe(3);
    expect(p.rateLimitRetries).toBe(0);
    expect(p.limit).toBe(24);
    expect(p.history).toHaveLength(1);
    expect(p.firstTransientText).toBe("configuration file X is corrupted");
  });

  it("in a run, a stray corrupted-config error does not count as a miss and is recorded in the file", async () => {
    let thrown = 0;
    const inner = q1Transport();
    const flaky: Transport = {
      send(req, signal) {
        if (thrown < 2) {
          thrown++;
          return Promise.reject(
            new TransientError(
              "transient",
              "Claude configuration file at X is corrupted: JSON Parse error: Unexpected EOF",
            ),
          );
        }
        return inner.send(req, signal);
      },
    };
    const out = tmp();
    const f = await runSets(
      A({ models: ["claude-sonnet-5-5"], efforts: [Effort.Low], runs: 1, limit: 4 }),
      T(flaky, out),
    );
    expect(f.results[0]).toMatchObject({ mean: 1, errors: 0 });
    const disk = readResultFile(out);
    expect(disk.pool.transientRetries).toBe(2);
    expect(disk.pool.rateLimitRetries).toBe(0);
    expect(disk.pool.limitHistory).toEqual([{ t: 0, limit: 8 }]); // the limit never moved
  });
});
