import { describe, expect, it } from "vitest";
import { parseConfig } from "../../../config/index.js";
import { Q4Relation, QuestionErrorCode, QuestionId, RejectReason, StopReason } from "../../../domain/enums.js";
import { failedUsageOf, type GroupInput, type GroupOutput } from "../../types.js";
import { QuestionError, buildGroupCall, SPECS, groupSpec, q4, type QuestionsOptions } from "../index.js";
import { must } from "../../../../__tests__/helpers/must.js";
import { Fake, ctx, reply, usage } from "./helpers/fake-transport.js";

const config = parseConfig({});

const options = (t: Fake): QuestionsOptions => ({
  settings: config.questions,
  timeoutSeconds: config.questionTimeout,
  transport: t,
});

const fact = (factId: string, header: string) => ({
  factId,
  isDeleted: false,
  versions: [
    {
      seq: 1,
      header,
      content: `${header} content.`,
      tagNames: [],
      justification: "I saw it.",
      references: [],
      isDeleted: false,
      created: 1,
    },
  ],
});

const input: GroupInput = {
  claims: [
    { position: 1, change: "Creepers do 10 damage.", justification: "I lost 10 health.", related: [] },
    {
      position: 2,
      change: "Creepers do 12 damage on hard.",
      justification: "I lost 12 health.",
      existing: fact("F1", "Creeper damage"),
      related: [fact("F2", "Skeleton damage")],
    },
  ],
};

const draft = { header: "Creeper damage", content: "Creepers do 10 damage.", references: [] };
const good: GroupOutput = {
  answers: [
    { position: 1, verdict: { supported: true, wrongRelated: [], reason: "New." }, draft },
    {
      position: 2,
      verdict: { supported: true, relation: Q4Relation.Different, wrongRelated: [], reason: "Hard." },
      target: { position: 1 },
      draft: { ...draft, content: "Creepers do 12 damage on hard." },
    },
  ],
};

const answer1 = must(good.answers[0]);
const answer2 = must(good.answers[1]);

describe("the group call", () => {
  it("holds the Q4 prompt and the Q5 prompt word for word, and keeps the model and effort of Q4", async () => {
    expect(groupSpec.system).toContain(q4.system);
    expect(groupSpec.system).toContain(SPECS[QuestionId.Q5].system);
    const t = new Fake([reply(good)]);
    const call = buildGroupCall(options(t));
    const { output, usage } = await call.ask(input, ctx);
    expect(output).toEqual(good);
    expect(usage.input).toBeGreaterThan(0);
    expect(t.requests[0]?.model).toBe(config.questions[QuestionId.Q4].model);
    expect(call.retries).toBe(0);
  });

  it("renders the claims in queue order with their facts", () => {
    const text = groupSpec.render(input, ctx);
    expect(text.indexOf('position="1"')).toBeLessThan(text.indexOf('position="2"'));
    expect(text).toContain("Creeper damage");
    expect(text).toContain("Skeleton damage");
  });

  it("asks 1 more time with the error after an answer that fails the schema, and counts the retry", async () => {
    const t = new Fake([reply({ answers: "none" }), reply(good)]);
    const call = buildGroupCall(options(t));
    expect((await call.ask(input, ctx)).output).toEqual(good);
    expect(t.requests).toHaveLength(2);
    expect(call.retries).toBe(1);
  });

  it("asks again when a target names a fact that is not in the group", async () => {
    const bad: GroupOutput = { answers: [answer1, { ...answer2, target: { factId: "NOPE" } }] };
    const t = new Fake([reply(bad), reply(good)]);
    const call = buildGroupCall(options(t));
    expect((await call.ask(input, ctx)).output).toEqual(good);
    expect(JSON.stringify(t.requests[1])).toContain("NOPE");
    expect(call.retries).toBe(1);
  });

  it("fails when a target position is not an earlier claim, and then a draft is missing", async () => {
    const forward: GroupOutput = { answers: [{ ...answer1, target: { position: 2 } }, answer2] };
    const noDraft: GroupOutput = { answers: [{ position: 1, verdict: answer1.verdict }, answer2] };
    const t = new Fake([reply(forward), reply(noDraft), reply(good)]);
    const call = buildGroupCall(options(t));
    await expect(call.ask(input, ctx)).rejects.toMatchObject({ code: QuestionErrorCode.Invalid });
    expect(call.retries).toBe(1);
  });

  it("accepts a target by position when the earlier claim revives a deleted fact", async () => {
    const deleted = { ...fact("F9", "Creeper damage"), isDeleted: true };
    const revival: GroupInput = {
      claims: [{ ...must(input.claims[0]), existing: deleted }, must(input.claims[1])],
    };
    const revived: GroupOutput = {
      answers: [
        {
          position: 1,
          verdict: { supported: true, relation: Q4Relation.Same, wrongRelated: [], reason: "Back." },
          target: { factId: "F9" },
          draft,
        },
        answer2,
      ],
    };
    const t = new Fake([reply(revived)]);
    const call = buildGroupCall(options(t));
    const { output: out } = await call.ask(revival, ctx);
    expect(out.answers).toHaveLength(2);
    expect(call.retries).toBe(0);
  });

  it("fails with an invalid error after a second invalid answer", async () => {
    const t = new Fake([reply({ answers: [] }), reply({ answers: [] })]);
    const call = buildGroupCall(options(t));
    const e = await call.ask(input, ctx).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(QuestionError);
    expect((e as QuestionError).code).toBe(QuestionErrorCode.Invalid);
    expect(call.retries).toBe(1);
  });

  it("carries the tokens of both attempts on the error when the retry throws", async () => {
    // The first answer is invalid; the retry is cut at the token limit, so it throws after it used tokens.
    const t = new Fake([
      reply({ answers: [] }, { usage: usage(10, 5) }),
      reply("cut", { stopReason: StopReason.MaxTokens, usage: usage(7, 3) }),
    ]);
    const e = await buildGroupCall(options(t))
      .ask(input, ctx)
      .catch((x: unknown) => x);
    expect((e as QuestionError).code).toBe(QuestionErrorCode.Truncated);
    expect(failedUsageOf(e)).toMatchObject({ input: 17, output: 8 });
  });

  it("needs a reject reason when the verdict is unsupported", async () => {
    const t = new Fake([
      reply({
        answers: [{ position: 1, verdict: { supported: false, wrongRelated: [], reason: "No." } }, good.answers[1]],
      }),
      reply({
        answers: [
          {
            position: 1,
            verdict: { supported: false, rejectReason: RejectReason.Unsupported, wrongRelated: [], reason: "No." },
          },
          {
            position: 2,
            verdict: { supported: false, rejectReason: RejectReason.Unsupported, wrongRelated: [], reason: "No." },
          },
        ],
      }),
    ]);
    const call = buildGroupCall(options(t));
    const { output: out } = await call.ask(input, ctx);
    expect(out.answers).toHaveLength(2);
    expect(call.retries).toBe(1);
  });
});
