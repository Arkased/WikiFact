import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { parseConfig } from "../../src/config/index.js";
import {
  CallerKind,
  Effort,
  LogEvent,
  MessageRole,
  QuestionErrorCode,
  QuestionKind,
  RejectReason,
  TransportName,
} from "../../src/domain/enums.js";
import { readEnv } from "../../src/env.js";
import type { LogLine } from "../../src/log/index.js";
import { createQuestions } from "../../src/updates/factory.js";
import {
  CliTransport,
  cliArgs,
  cliModel,
  findClaudeBinary,
  parseCliResult,
  selectTransport,
  TransportError,
  type CallRequest,
} from "../../src/updates/questions/index.js";
import { PROCESS_START_TIMEOUT_MS } from "../helpers/timeouts.js";

/** The characters of a Windows command line (CreateProcess). */
const MAX_COMMAND_LINE = 32_767;
const fake = join(import.meta.dirname, "..", "helpers", "fake-claude.mjs");
const ctx = { subject: "Minecraft" };
const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

function setup(script: unknown[]) {
  const dir = mkdtempSync(join(tmpdir(), "fakeclaude-"));
  const log = join(dir, "calls.jsonl");
  process.env.FAKE_LOG = log;
  process.env.FAKE_SCRIPT = JSON.stringify(script);
  const calls = (): FakeCall[] =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => fakeCall.parse(JSON.parse(l)))
      : [];
  return { calls };
}
const fakeCall = z.object({
  argv: z.array(z.string()),
  systemPrompt: z.string().nullable(),
  stdin: z.string(),
  pid: z.number(),
  cwd: z.string(),
  forceCache5m: z.string().nullable(),
});
type FakeCall = z.infer<typeof fakeCall>;
const out = (structured: unknown, extra: object = {}) => ({
  out: {
    type: "result",
    subtype: "success",
    is_error: false,
    structured_output: structured,
    usage: { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 3 },
    ...extra,
  },
});
const make = (over: object = {}, timeout = 20) =>
  createQuestions(
    parseConfig({ questionTimeout: timeout, ...over }),
    new CliTransport({ claudeBin: process.execPath, prefixArgs: [fake], childEnv: process.env }),
  );

describe("cli transport arguments", () => {
  const base: CallRequest = {
    model: "claude-sonnet-5-5",
    kind: QuestionKind.Judgment,
    effort: Effort.High,
    system: "SYSTEM",
    messages: [{ role: MessageRole.User, content: "MATERIAL" }],
    schema: { type: "object" },
    maxTokens: 16000,
    stream: true,
    thinking: true,
    fallback: true,
  };

  it("passes the prompt, schema, model alias, effort, no tools and one-shot flags", () => {
    // The flags are the contract with the claude binary: each is checked with the value it must carry.
    const a = cliArgs(base, "prompt.txt");
    const value = (flag: string): string | undefined => a[a.indexOf(flag) + 1];
    expect(a[0]).toBe("-p");
    expect(value("--system-prompt-file")).toBe("prompt.txt");
    expect(value("--output-format")).toBe("json");
    expect(JSON.parse(value("--json-schema") ?? "")).toEqual({ type: "object" });
    expect(value("--model")).toBe("sonnet");
    expect(value("--effort")).toBe(Effort.High);
    expect(value("--tools")).toBe("");
    expect(value("--permission-mode")).toBe("dontAsk");
    expect(value("--disallowedTools")).toContain("Bash");
    for (const flag of ["--strict-mcp-config", "--no-session-persistence", "--disable-slash-commands"])
      expect(a).toContain(flag);
  });

  it("--bare is opt-in (WIKIFACT_CLI_BARE=1): it breaks the OAuth login of the CLI, so it is off by default", () => {
    expect(cliArgs(base, "p.txt")).not.toContain("--bare");
    expect(cliArgs(base, "p.txt", true).slice(0, 2)).toEqual(["-p", "--bare"]);
  });

  it("omits effort for Haiku and maps the model ids", () => {
    const a = cliArgs({ ...base, model: "claude-haiku-4-5", thinking: false }, "p.txt");
    expect(a).not.toContain("--effort");
    expect(a[a.indexOf("--model") + 1]).toBe("claude-haiku-4-5");
    expect(cliModel("claude-opus-5-5")).toBe("opus");
    expect(cliModel("claude-haiku-5-5")).toBe("claude-haiku-5-5");
    expect(cliModel("claude-haiku-4-5")).toBe("claude-haiku-4-5");
    expect(cliModel("claude-something-else")).toBe("claude-something-else");
  });

  it("the real run sends these flags and the material on stdin", { timeout: PROCESS_START_TIMEOUT_MS }, async () => {
    const s = setup([out({ matches: ["F1"] })]);
    const r = await make({ questions: { Q1: { model: "claude-haiku-4-5", effort: "low" } } }).q1(
      { change: "Creepers do 10.", candidates: [{ factId: "F1", header: "Creeper damage" }] },
      ctx,
    );
    expect(r).toEqual({ matches: ["F1"] });
    const [c] = s.calls();
    expect(c.argv).toEqual(
      expect.arrayContaining([
        "-p",
        "--output-format",
        "json",
        "--json-schema",
        "--model",
        "claude-haiku-4-5",
        "--tools",
        "",
      ]),
    );
    expect(c.argv).not.toContain("--effort");
    expect(c.stdin).toContain("Creepers do 10.");
  });

  it(
    "the real run sends the wiki block in the system prompt file, and a block over the command line limit works",
    { timeout: PROCESS_START_TIMEOUT_MS },
    async () => {
      // The wiki block holds the subject alone. A Windows command line holds 32,767 characters: a subject sentence
      // longer than that must still work, because the block goes in a file and not on the command line.
      const s = setup([out({ drafts: [{ header: "h", content: "Creepers do 10.", references: [] }] })]);
      const subject = `Minecraft ${"word ".repeat(8000)}end-of-subject`;
      await make({ questions: { Q5: { model: "claude-sonnet-5-5", effort: "medium" } } }).q5(
        { change: "Creepers do 10.", justification: "j", related: [] },
        { subject },
      );
      const [c] = s.calls();
      expect(c.systemPrompt).toContain("end-of-subject");
      expect(c.systemPrompt).toContain("Minecraft");
      expect(c.stdin).toContain("Creepers do 10.");
      expect(c.stdin).not.toContain("<wiki>");
      expect(c.argv.join(" ").length).toBeLessThan(MAX_COMMAND_LINE);
    },
  );
});

describe("cli transport behavior", { timeout: PROCESS_START_TIMEOUT_MS }, () => {
  it("sets FORCE_PROMPT_CACHING_5M=1 in the env of the child, also when the caller env sets another value", async () => {
    // The cache writes use the 5-minute cache (docs/technical/updates.md#call-settings).
    const s = setup([out({ matches: [] })]);
    process.env.FORCE_PROMPT_CACHING_5M = "0";
    await make().q1({ change: "Creepers do 10.", candidates: [] }, ctx);
    expect(s.calls()[0].forceCache5m).toBe("1");
  });

  it("validates against the output schema and retries once with the error (F18)", async () => {
    const s = setup([
      out({ supported: false, wrongRelated: [], reason: "r" }),
      out({ supported: false, rejectReason: "unsupported", wrongRelated: [], reason: "r" }),
    ]);
    const r = await make({ questions: { Q4: { model: "claude-sonnet-5-5", effort: "medium" } } }).q4(
      { change: "c", justification: "j", related: [] },
      ctx,
    );
    expect(r.rejectReason).toBe(RejectReason.Unsupported);
    const calls = s.calls();
    expect(calls).toHaveLength(2);
    expect(calls[1].stdin).toContain("rejectReason");
    expect(calls[0].argv).toEqual(expect.arrayContaining(["--effort", "medium", "--model", "sonnet"]));
  });

  it("a second invalid answer throws", async () => {
    setup([out({ matches: 5 })]);
    await expect(make().q1({ change: "c", candidates: [] }, ctx)).rejects.toMatchObject({
      code: QuestionErrorCode.Invalid,
    });
  });

  it("falls back to the result field, as text", async () => {
    setup([
      {
        out: {
          type: "result",
          is_error: false,
          result: '{"oneClaim":true,"claims":[],"support":"observation","reason":"fine"}',
          usage: {},
        },
      },
    ]);
    expect(await make().q7({ change: "c", justification: "j" }, ctx)).toEqual({
      oneClaim: true,
      claims: [],
      support: "observation",
      reason: "fine",
    });
  });

  it("kills the child on timeout (F21)", async () => {
    const s = setup([{ hang: true }]);
    const timeoutSeconds = 600;
    // The timer of the question timeout is fake, the child is real. waitFor advances the fake clock by its poll
    // interval, which stays far under the timeout, until the child has logged its start.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let result: Promise<unknown>;
    try {
      result = make({}, timeoutSeconds)
        .q7({ change: "c", justification: "j" }, ctx)
        .catch((e: unknown) => e);
      await vi.waitFor(() => expect(s.calls()).toHaveLength(1), { timeout: 20000 });
      await vi.advanceTimersByTimeAsync(timeoutSeconds * 1000);
    } finally {
      vi.useRealTimers();
    }
    expect(await result).toMatchObject({ code: QuestionErrorCode.Timeout });
    const pid = s.calls()[0].pid;
    const dead = (): boolean => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    };
    // The kill is asynchronous: wait for the condition, not for a time.
    await vi.waitFor(() => expect(dead()).toBe(true), { timeout: 10000 });
  });

  it("a non-zero exit fails the call", async () => {
    setup([{ exit: 1 }]);
    await expect(make().q7({ change: "c", justification: "j" }, ctx)).rejects.toThrow(/login required/); // the stderr of the child
  });

  it("a missing result, an error result and bad JSON fail the call", async () => {
    setup([{ out: { type: "result", is_error: false } }]);
    await expect(make().q7({ change: "c", justification: "j" }, ctx)).rejects.toThrow();
    setup([{ out: { type: "result", is_error: true, result: "Not logged in" } }]);
    await expect(make().q7({ change: "c", justification: "j" }, ctx)).rejects.toThrow(/Not logged in/);
    expect(() => parseCliResult("not json")).toThrow();
  });

  it("the normal success shape: stop_reason tool_use, subtype success, the answer in result (Haiku 5.5 run)", async () => {
    setup([
      {
        out: {
          type: "result",
          subtype: "success",
          is_error: false,
          num_turns: 2,
          stop_reason: "tool_use",
          result: '{"matches":["f1"]}',
          usage: { input_tokens: 5, output_tokens: 3 },
        },
      },
    ]);
    const qs = make();
    expect(await qs.q1({ change: "c", candidates: [{ factId: "f1", header: "h" }] }, ctx)).toEqual({ matches: ["f1"] });
    expect(qs.takeUsage?.()).toMatchObject({ input: 5, output: 3 });
    // the same with the answer as an object in structured_output
    setup([
      {
        out: {
          type: "result",
          subtype: "success",
          is_error: false,
          num_turns: 2,
          stop_reason: "tool_use",
          structured_output: { matches: [] },
          usage: {},
        },
      },
    ]);
    expect(await make().q1({ change: "c", candidates: [] }, ctx)).toEqual({ matches: [] });
  });

  it("an error result fails with stop_reason, turns and subtype, whether the exit code is 0 or 1 (the Q4 failures of the first run)", async () => {
    const stuck = {
      type: "result",
      subtype: "error_max_turns",
      is_error: true,
      num_turns: 6,
      stop_reason: "tool_use",
      result: "StructuredOutput failed validation",
      usage: {},
    };
    setup([{ exit: 1, out: stuck }]);
    await expect(make().q7({ change: "c", justification: "j" }, ctx)).rejects.toThrow(/error_max_turns/);
    setup([{ out: stuck }]);
    await expect(make().q7({ change: "c", justification: "j" }, ctx)).rejects.toThrow(/error_max_turns/);
    // a subtype other than success fails even when is_error is false
    setup([
      {
        out: {
          ...stuck,
          is_error: false,
          result: '{"oneClaim":true,"claims":[],"support":"observation","reason":"r"}',
        },
      },
    ]);
    await expect(make().q7({ change: "c", justification: "j" }, ctx)).rejects.toThrow(/subtype error_max_turns/);
  });

  it("a success with no parsable answer fails with the detail", async () => {
    setup([
      {
        out: {
          type: "result",
          subtype: "success",
          is_error: false,
          num_turns: 2,
          stop_reason: "tool_use",
          result: "",
          usage: {},
        },
      },
    ]);
    await expect(make().q7({ change: "c", justification: "j" }, ctx)).rejects.toThrow();
    setup([
      {
        out: {
          type: "result",
          subtype: "success",
          is_error: false,
          stop_reason: "tool_use",
          result: "not json at all",
          usage: {},
        },
      },
    ]);
    await expect(make().q7({ change: "c", justification: "j" }, ctx)).rejects.toMatchObject({
      code: QuestionErrorCode.Invalid,
    });
  });

  it("denies every tool: no built-in tool, no MCP server, no permission prompt", async () => {
    const s = setup([out({ oneClaim: true, claims: [], support: "observation", reason: "r" })]);
    await make().q7({ change: "c", justification: "j" }, ctx);
    const argv: string[] = s.calls()[0].argv;
    expect(argv[argv.indexOf("--tools") + 1]).toBe("");
    expect(argv).toContain("--strict-mcp-config");
    expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(argv[argv.indexOf("--disallowedTools") + 1].split(",")).toEqual(
      expect.arrayContaining(["Bash", "Edit", "Read", "WebFetch", "Task", "ToolSearch"]),
    );
  });

  it("a refusal stop reason throws as a refusal (F19)", async () => {
    setup([{ out: { type: "result", is_error: false, stop_reason: "refusal", usage: {} } }]);
    await expect(make().q7({ change: "c", justification: "j" }, ctx)).rejects.toMatchObject({
      code: QuestionErrorCode.Refusal,
    });
  });

  it("takeUsage sums the usage of the result", async () => {
    setup([out({ oneClaim: true, claims: [], support: "observation", reason: "r" })]);
    const qs = make();
    await qs.q7({ change: "c", justification: "j" }, ctx);
    expect(qs.takeUsage?.()).toEqual({ input: 11, output: 7, cacheRead: 3, cacheWrite: 0 });
  });
});

describe("concurrent calls", { timeout: PROCESS_START_TIMEOUT_MS }, () => {
  it("6 calls run in parallel through the fake binary, each in its own directory, and the usage adds up", async () => {
    // No fake child answers before all 6 have started: the calls finish only if they overlap.
    const s = setup([{ waitForPeers: 6, ...out({ oneClaim: true, claims: [], support: "observation", reason: "r" }) }]);
    const qs = make();
    await Promise.all(Array.from({ length: 6 }, () => qs.q7({ change: "c", justification: "j" }, ctx)));
    const calls = s.calls();
    expect(calls).toHaveLength(6);
    expect(new Set(calls.map((c) => c.cwd)).size).toBe(6);
    expect(qs.takeUsage?.()).toEqual({ input: 66, output: 42, cacheRead: 18, cacheWrite: 0 });
    for (const c of calls) expect(existsSync(c.cwd)).toBe(false); // the temp directories are removed
  });
});

describe("selection", () => {
  it("a key means the sdk, no key means the cli, and WIKIFACT_TRANSPORT overrides", () => {
    const bin = process.execPath;
    expect(selectTransport(CallerKind.Eval, readEnv({ ANTHROPIC_API_KEY: "k", WIKIFACT_CLAUDE_BIN: bin })).name).toBe(
      TransportName.Sdk,
    );
    expect(selectTransport(CallerKind.Eval, readEnv({ WIKIFACT_CLAUDE_BIN: bin })).name).toBe(TransportName.Cli);
    expect(
      selectTransport(
        CallerKind.Eval,
        readEnv({ ANTHROPIC_API_KEY: "k", WIKIFACT_TRANSPORT: "cli", WIKIFACT_CLAUDE_BIN: bin }),
      ).name,
    ).toBe(TransportName.Cli);
    expect(selectTransport(CallerKind.Eval, readEnv({ WIKIFACT_TRANSPORT: "sdk" })).name).toBe(TransportName.Sdk);
    expect(() => selectTransport(CallerKind.Eval, readEnv({ WIKIFACT_TRANSPORT: "x" }))).toThrow(TransportError);
  });

  it("a worker needs a key, or an explicit WIKIFACT_TRANSPORT=cli", () => {
    const bin = process.execPath;
    // no key, no explicit transport: refused, even though the binary exists
    expect(() => selectTransport(CallerKind.Worker, readEnv({ WIKIFACT_CLAUDE_BIN: bin }))).toThrow(TransportError);
    expect(() => selectTransport(CallerKind.Worker, readEnv({}))).toThrow(TransportError);
    // a key: the sdk
    expect(selectTransport(CallerKind.Worker, readEnv({ ANTHROPIC_API_KEY: "k" })).name).toBe(TransportName.Sdk);
    // explicit cli: allowed for a local run, with or without a key
    expect(
      selectTransport(CallerKind.Worker, readEnv({ WIKIFACT_TRANSPORT: "cli", WIKIFACT_CLAUDE_BIN: bin })).name,
    ).toBe(TransportName.Cli);
    expect(
      selectTransport(
        CallerKind.Worker,
        readEnv({
          WIKIFACT_TRANSPORT: "cli",
          ANTHROPIC_API_KEY: "k",
          WIKIFACT_CLAUDE_BIN: bin,
        }),
      ).name,
    ).toBe(TransportName.Cli);
    expect(selectTransport(CallerKind.Worker, readEnv({ WIKIFACT_TRANSPORT: "sdk" })).name).toBe(TransportName.Sdk);
  });

  it("createQuestions defaults to the worker rule and an eval caller may use the cli", () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.WIKIFACT_TRANSPORT;
    process.env.WIKIFACT_CLAUDE_BIN = process.execPath;
    const lines: LogLine[] = [];
    expect(() => createQuestions(parseConfig({}))).toThrow(TransportError);
    createQuestions(parseConfig({}), undefined, { kind: CallerKind.Eval, log: (l) => lines.push(l) });
    expect(lines[0]).toMatchObject({ event: LogEvent.QuestionTransport, transport: "cli" });
  });

  it("WIKIFACT_CLAUDE_BIN wins the binary search", () => {
    expect(findClaudeBinary(readEnv({ WIKIFACT_CLAUDE_BIN: "/x/claude" }))).toBe("/x/claude");
  });

  it("createQuestions logs which transport runs", () => {
    process.env.WIKIFACT_CLAUDE_BIN = process.execPath;
    process.env.WIKIFACT_TRANSPORT = "cli";
    const lines: LogLine[] = [];
    createQuestions(parseConfig({}), undefined, { log: (l) => lines.push(l) });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ event: LogEvent.QuestionTransport, transport: "cli" });
  });
});
