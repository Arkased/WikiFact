import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseConfig } from "../../../config/index.js";
import {
  MessageRole,
  Q4Relation,
  QuestionErrorCode,
  QuestionKind,
  RejectReason,
  StopReason,
} from "../../../domain/enums.js";
import { fileLogger, type LogLine } from "../../../log/index.js";
import { createQuestions } from "../../factory.js";
import {
  CLASSIFICATION_MAX_TOKENS,
  LONG_MAX_TOKENS,
  QuestionError,
  buildQuestions,
  jsonSchemaOf,
  modelFeatures,
  q4,
  type CallRequest,
  type CallResponse,
  type Transport,
  SPECS,
} from "../index.js";

import { Fake, ctx, reply, usage } from "./helpers/fake-transport.js";

const config = parseConfig({});
const make = (t: Transport, over: Parameters<typeof parseConfig>[0] = {}) => createQuestions(parseConfig(over), t);

const fact = {
  factId: "F1",
  isDeleted: false,
  versions: [
    {
      seq: 1,
      header: "Creeper damage",
      content: "Creepers do 10 damage.",
      tagNames: ["creepers"],
      justification: "I lost 10 health.",
      references: [],
      isDeleted: false,
      created: 1,
    },
  ],
};
const q4Input = { change: "Creepers do 12 damage.", justification: "I lost 12 health.", existing: fact, related: [] };
const q4Good = { supported: true, relation: Q4Relation.Different, wrongRelated: [], reason: "Observed 12." };

describe('call settings (technical/updates.md, "Pipeline")', () => {
  it("a classification call: haiku has no thinking, effort or fallback, max_tokens 4096, no stream, cached system prompt", async () => {
    const t = new Fake([reply({ matches: ["F1"] })]);
    const out = await make(t, { questions: { Q1: { model: "claude-haiku-4-5", effort: "low" } } }).q1(
      { change: "c", candidates: [{ factId: "F1", header: "h" }] },
      ctx,
    );
    expect(out).toEqual({ matches: ["F1"] });
    const r = t.requests[0];
    expect(r.model).toBe("claude-haiku-4-5");
    expect(r).toMatchObject({
      kind: QuestionKind.Classification,
      maxTokens: CLASSIFICATION_MAX_TOKENS,
      stream: false,
      thinking: false,
      fallback: false,
    });
    expect(r.system).toBe(SPECS.Q1.system);
    expect(r.schema).toMatchObject({ type: "object", additionalProperties: false });
    expect(r.messages).toHaveLength(1);
  });

  it("Haiku 5.5 takes effort and adaptive thinking, like Sonnet; Haiku 4.5 does not", async () => {
    const t = new Fake([reply({ matches: [] })]);
    await make(t, { questions: { Q1: { model: "claude-haiku-5-5", effort: "medium" } } }).q1(
      { change: "c", candidates: [] },
      ctx,
    );
    expect(t.requests[0]).toMatchObject({
      model: "claude-haiku-5-5",
      effort: "medium",
      thinking: true,
      fallback: false,
    });
    expect(modelFeatures("claude-haiku-4-5")).toEqual({ thinking: false, fallback: false });
    expect(modelFeatures("claude-haiku-5-5").thinking).toBe(true);
    expect(modelFeatures("claude-future-9")).toEqual({ thinking: true, fallback: false });
    expect(modelFeatures("claude-fable-9").fallback).toBe(true);
  });

  it("a judgment call: sonnet with adaptive thinking, the configured effort, fallback, 16000 tokens, streaming", async () => {
    const t = new Fake([reply(q4Good)]);
    await make(t, { questions: { Q4: { model: "claude-sonnet-5-5", effort: "high" } } }).q4(q4Input, ctx);
    expect(t.requests[0]).toMatchObject({
      model: "claude-sonnet-5-5",
      effort: "high",
      kind: QuestionKind.Judgment,
      maxTokens: LONG_MAX_TOKENS,
      stream: true,
      thinking: true,
      fallback: true,
    });
  });

  it("the system prompt is the same on every call, the wiki block follows it, and the input sits in the user message", async () => {
    const t = new Fake([reply(q4Good)]);
    const qs = make(t);
    await qs.q4(q4Input, ctx);
    await qs.q4({ ...q4Input, change: "Something else." }, { subject: "Other" });
    expect(t.requests[0].system).toBe(t.requests[1].system);
    expect(t.requests[0].wiki).toContain("Minecraft");
    expect(t.requests[1].wiki).toContain("Other");
    expect(t.requests[1].messages[0].content).toContain("Something else.");
    for (const r of t.requests) {
      expect(r.system).not.toContain("Minecraft");
      expect(r.messages[0].content).not.toContain("<wiki>");
    }
  });

  it("the output schema sent matches the question", () => {
    for (const spec of Object.values(SPECS)) {
      const s = jsonSchemaOf(spec.output);
      expect(s.$schema).toBeUndefined();
      expect(s.type).toBe("object");
      expect(s.additionalProperties).toBe(false);
    }
  });
});

describe("WIKIFACT_LOG_CALLS", () => {
  it("puts the request id of the context on the line and keeps it out of ctx", async () => {
    process.env.WIKIFACT_LOG_CALLS = "1";
    const lines: LogLine[] = [];
    try {
      await createQuestions(parseConfig({}), new Fake([reply({ matches: [] })]), { log: (l) => lines.push(l) }).q1(
        { change: "c", candidates: [] },
        { ...ctx, requestId: "R1" },
      );
    } finally {
      delete process.env.WIKIFACT_LOG_CALLS;
    }
    expect(lines[0]).toMatchObject({ event: "question_call", requestId: "R1", ctx });
    expect(lines[0]).not.toHaveProperty("ctx.requestId");
  });

  it("logs without the flag when the log writes the call file, and only to that file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wikifact-calls-"));
    const log = await fileLogger({ dir, name: "worker-a", callsName: "worker-a-calls" });
    try {
      await createQuestions(parseConfig({}), new Fake([reply({ matches: [] })]), { log }).q1(
        { change: "c", candidates: [] },
        { ...ctx, requestId: "R1" },
      );
      const read = (prefix: string): string =>
        readFileSync(join(dir, readdirSync(dir).find((f) => f.startsWith(`${prefix}.`)) ?? ""), "utf8");
      expect(JSON.parse(read("worker-a-calls"))).toMatchObject({ event: "question_call", requestId: "R1" });
      expect(read("worker-a")).toBe("");
    } finally {
      log.close();
    }
  });

  it("logs nothing by default", async () => {
    const lines: LogLine[] = [];
    await createQuestions(parseConfig({}), new Fake([reply({ matches: [] })]), { log: (l) => lines.push(l) }).q1(
      { change: "c", candidates: [] },
      ctx,
    );
    expect(lines).toEqual([]);
  });
});

describe("F18: invalid output", () => {
  it("retries once with the validation error, then returns the valid answer", async () => {
    const bad = { supported: false, wrongRelated: [], reason: "no" }; // the F18 example: no rejectReason
    const t = new Fake([reply(bad), reply({ ...bad, rejectReason: RejectReason.Unsupported })]);
    const out = await make(t).q4({ ...q4Input, existing: undefined }, ctx);
    expect(out.rejectReason).toBe(RejectReason.Unsupported);
    expect(t.requests).toHaveLength(2);
    const second = t.requests[1].messages;
    expect(second).toHaveLength(3);
    expect(second[1]).toMatchObject({ role: MessageRole.Assistant });
    expect(second[2].content).toContain("rejectReason");
  });

  it("a schema failure (missing field) retries too", async () => {
    const t = new Fake([reply({ matches: "F1" }), reply({ matches: ["F1"] })]);
    const out = await make(t).q1({ change: "c", candidates: [] }, ctx);
    expect(out.matches).toEqual(["F1"]);
    expect(t.requests[1].messages[2].content).toContain("matches");
  });

  it("text that is not JSON retries", async () => {
    const t = new Fake([
      reply("I think the answer is yes."),
      reply({ oneClaim: true, claims: [], support: "observation", reason: "ok" }),
    ]);
    const out = await make(t).q7({ change: "c", justification: "j" }, ctx);
    expect(out.oneClaim).toBe(true);
    expect(out.support).toBe("observation");
  });

  it("a second invalid answer throws and makes no third call", async () => {
    const bad = { supported: false, wrongRelated: [], reason: "no" };
    const t = new Fake([reply(bad)]);
    await expect(make(t).q4({ ...q4Input, existing: undefined }, ctx)).rejects.toMatchObject({
      code: QuestionErrorCode.Invalid,
    });
    expect(t.requests).toHaveLength(2);
  });

  it("an existing fact without a relation is invalid", async () => {
    const t = new Fake([reply({ supported: true, wrongRelated: [], reason: "r" }), reply(q4Good)]);
    await make(t).q4(q4Input, ctx);
    expect(t.requests).toHaveLength(2);
  });

  it("a drafting question must return exactly one draft, Q5 included", async () => {
    const d = (h: string) => ({ header: h, content: `${h} is a thing in the game.`, references: [] });
    const two = { drafts: [d("A"), d("B")] };
    const one = { drafts: [d("A")] };
    const t6 = new Fake([reply(two), reply(one)]);
    await make(t6).q6({ wrong: fact, claim: { header: "h", content: "c", justification: "j", references: [] } }, ctx);
    expect(t6.requests).toHaveLength(2);
    const t5 = new Fake([reply(two), reply(one)]);
    const out = await make(t5).q5({ change: "c", justification: "j", related: [] }, ctx);
    expect(out.drafts).toHaveLength(1);
    expect(t5.requests).toHaveLength(2);
    const t5b = new Fake([reply({ drafts: [] }), reply(one)]);
    await make(t5b).q5({ change: "c", justification: "j", related: [] }, ctx);
    expect(t5b.requests).toHaveLength(2);
  });

  it("Q9 may delete, the others may not", async () => {
    const del = { drafts: [{ header: "H", content: "C", references: [], isDeleted: true }] };
    const t9 = new Fake([reply(del)]);
    const out = await make(t9).q9({ dependent: fact, reason: "r", changed: [] }, ctx);
    expect(out.drafts[0].isDeleted).toBe(true);
    const t3 = new Fake([reply(del), reply({ drafts: [{ ...del.drafts[0], isDeleted: false }] })]);
    await make(t3).q3({ kept: fact, others: [], content: "c" }, ctx);
    expect(t3.requests).toHaveLength(2);
  });
});

describe("F19: refusal", () => {
  it("throws when the final answer is a refusal, without a retry", async () => {
    const t = new Fake([reply("", { stopReason: StopReason.Refusal })]);
    const err = await make(t)
      .q4(q4Input, ctx)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QuestionError);
    expect(err).toMatchObject({ code: QuestionErrorCode.Refusal });
    expect(t.requests).toHaveLength(1);
  });

  it("a refusal on the retry throws too", async () => {
    const t = new Fake([reply({ matches: 1 }), reply("", { stopReason: StopReason.Refusal })]);
    await expect(make(t).q1({ change: "c", candidates: [] }, ctx)).rejects.toMatchObject({
      code: QuestionErrorCode.Refusal,
    });
  });

  it("an answer cut at max_tokens throws", async () => {
    const t = new Fake([reply('{"matches": [', { stopReason: StopReason.MaxTokens })]);
    await expect(make(t).q1({ change: "c", candidates: [] }, ctx)).rejects.toMatchObject({
      code: QuestionErrorCode.Truncated,
    });
  });
});

describe("F21: timeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fails the call when the transport does not answer within questionTimeout, and aborts it", async () => {
    vi.useFakeTimers();
    let aborted = false;
    const hang = (_: CallRequest, signal: AbortSignal) =>
      new Promise<CallResponse>((_res, rej) =>
        signal.addEventListener("abort", () => ((aborted = true), rej(new Error("aborted")))),
      );
    const t = new Fake([hang]);
    const result = make(t, { questionTimeout: 5 })
      .q7({ change: "c", justification: "j" }, ctx)
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(5000);
    const err = await result;
    expect(err).toBeInstanceOf(QuestionError);
    expect(err).toMatchObject({ code: QuestionErrorCode.Timeout });
    expect(aborted).toBe(true);
    expect(t.requests).toHaveLength(1);
  });

  it("times out even when the transport ignores the signal", async () => {
    vi.useFakeTimers();
    const t = new Fake([() => new Promise<CallResponse>(() => undefined)]);
    const result = expect(
      make(t, { questionTimeout: 5 }).q7({ change: "c", justification: "j" }, ctx),
    ).rejects.toMatchObject({ code: QuestionErrorCode.Timeout });
    await vi.advanceTimersByTimeAsync(5000);
    await result;
  });
});

describe("token usage", () => {
  it("sums the calls, retries included, and resets on takeUsage", async () => {
    const t = new Fake([
      reply({ matches: 1 }, { usage: { input: 100, output: 20, cacheRead: 50, cacheWrite: 7 } }),
      reply({ matches: [] }, { usage: { input: 30, output: 10, cacheRead: 60, cacheWrite: 0 } }),
      reply({ oneClaim: true, claims: [], support: "observation", reason: "" }, { usage: usage(1, 2) }),
    ]);
    const qs = buildQuestions({ settings: config.questions, timeoutSeconds: 5, transport: t });
    await qs.q1({ change: "c", candidates: [] }, ctx);
    expect(qs.takeUsage()).toEqual({ input: 130, output: 30, cacheRead: 110, cacheWrite: 7 });
    expect(qs.takeUsage()).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    await qs.q7({ change: "c", justification: "j" }, ctx);
    expect(qs.takeUsage()).toMatchObject({ input: 1, output: 2 });
  });

  it("counts the usage of a failed call that returned", async () => {
    const t = new Fake([reply({ matches: 1 })]);
    const qs = buildQuestions({ settings: config.questions, timeoutSeconds: 5, transport: t });
    await qs.q1({ change: "c", candidates: [] }, ctx).catch(() => undefined);
    expect(qs.takeUsage().input).toBe(20);
  });
});

describe("Q4 spec", () => {
  it("rejects the F18 example and accepts the design shapes", () => {
    const q4Check = q4.check?.bind(q4);
    if (!q4Check) throw new Error("the Q4 spec has no check");
    const check = (o: Parameters<typeof q4Check>[0], i: Parameters<typeof q4Check>[1]) => q4Check(o, i, ctx);
    expect(q4.output.safeParse({ supported: false, wrongRelated: [], reason: "r" }).success).toBe(true); // the schema allows it
    expect(check({ supported: false, wrongRelated: [], reason: "r" }, q4Input)).toMatch(/rejectReason/);
    expect(
      check({ supported: false, rejectReason: RejectReason.Contradicted, wrongRelated: [], reason: "r" }, q4Input),
    ).toMatch(/relation/);
    expect(
      check({ supported: true, relation: Q4Relation.Same, wrongRelated: [], reason: "r" }, q4Input),
    ).toBeUndefined();
    expect(
      check({ supported: true, wrongRelated: [], reason: "r" }, { ...q4Input, existing: undefined }),
    ).toBeUndefined();
    expect(
      q4.output.safeParse({ supported: true, relation: Q4Relation.Unrelated, wrongRelated: [], reason: "r" }).success,
    ).toBe(true);
    expect(
      check({ supported: true, relation: Q4Relation.Unrelated, wrongRelated: [], reason: "r" }, q4Input),
    ).toBeUndefined();
    expect(
      q4.output.safeParse({ supported: true, wrongRelated: [{ factId: "F2", action: "remove" }], reason: "r" }).success,
    ).toBe(false);
  });
});
