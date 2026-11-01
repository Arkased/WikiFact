import { describe, expect, it } from "vitest";
import { Q4Relation } from "../../../domain/enums.js";
import { parseConfig } from "../../../config/index.js";
import { enqueueRequest, openStore } from "../../../store/index.js";
import { createQuestions } from "../../factory.js";
import { buildQuestions, type CallResponse } from "../index.js";
import { Fake, ctx, reply } from "./helpers/fake-transport.js";

const config = parseConfig({});
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
const input = { change: "Creepers do 12 damage.", justification: "I lost 12 health.", existing: fact, related: [] };
const good = { supported: true, relation: Q4Relation.Different, wrongRelated: [], reason: "Observed 12." };
const T0 = 1_700_000_000_000;

function setup(script: ConstructorParameters<typeof Fake>[0]) {
  const store = openStore(":memory:", { embeddingModel: "m" });
  const requestId = enqueueRequest(store, { change: "c", justification: "j" }, T0);
  const questions = buildQuestions({
    settings: config.questions,
    timeoutSeconds: config.questionTimeout,
    transport: new Fake(script),
    store,
  });
  return { store, requestId, questions };
}

interface Row {
  request_id: string;
  question: string;
  model: string;
  effort: string;
  tokens_in: number;
  tokens_out: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
  duration_ms: number;
}
const rows = (store: ReturnType<typeof setup>["store"]): Row[] =>
  store.db.prepare("SELECT * FROM model_calls ORDER BY id").all() as Row[];

describe('model call rows (technical/updates.md, "Model call rows")', () => {
  it("writes one row per call with the request, question, model, effort, usage and duration", async () => {
    const wall = 321;
    const { store, requestId, questions } = setup([
      reply(good, {
        usage: { input: 11, output: 12, cacheRead: 13, cacheWrite: 14 },
        timing: { wallMs: wall },
      }),
    ]);
    await questions.q4(input, { ...ctx, requestId });
    expect(rows(store)).toEqual([
      {
        id: expect.any(String) as string,
        request_id: requestId,
        question: "Q4",
        model: config.questions.Q4.model,
        effort: config.questions.Q4.effort,
        tokens_in: 11,
        tokens_out: 12,
        tokens_cache_read: 13,
        tokens_cache_write: 14,
        duration_ms: wall,
        at: expect.any(Number) as number,
      },
    ]);
  });

  it("writes a row for each attempt, and for an answer that fails validation", async () => {
    const { store, requestId, questions } = setup([reply("not json"), reply(good)]);
    await questions.q4(input, { ...ctx, requestId });
    expect(rows(store)).toHaveLength(2);
  });

  it("writes no row for a call that fails before the transport returns a usage", async () => {
    const failing = (): Promise<CallResponse> => Promise.reject(new Error("network down"));
    const { store, requestId, questions } = setup([failing]);
    await expect(questions.q4(input, { ...ctx, requestId })).rejects.toThrow("network down");
    expect(rows(store)).toEqual([]);
  });

  it("writes no row for a question with no request id, or when no store is given", async () => {
    const withStore = setup([reply(good)]);
    await withStore.questions.q4(input, ctx);
    expect(rows(withStore.store)).toEqual([]);
    const without = buildQuestions({
      settings: config.questions,
      timeoutSeconds: config.questionTimeout,
      transport: new Fake([reply(good)]),
    });
    await expect(without.q4(input, { ...ctx, requestId: withStore.requestId })).resolves.toBeDefined();
  });

  it("writes the row of a group call under the question QG, and hands its tokens back to be shared through the usage account", async () => {
    const draft = { header: "Creeper damage", content: "Creepers do 12 damage.", references: [] };
    const answer = {
      answers: [{ position: 1, verdict: { supported: true, wrongRelated: [], reason: "New." }, draft }],
    };
    const { store, requestId, questions } = setup([
      reply(answer, { usage: { input: 11, output: 12, cacheRead: 3, cacheWrite: 4 } }),
    ]);
    const claims = [{ position: 1, change: "Creepers do 12 damage.", justification: "I lost 12 health.", related: [] }];
    const res = await questions.group.ask({ claims }, { ...ctx, requestId });
    expect(res.usage).toEqual({ input: 11, output: 12, cacheRead: 3, cacheWrite: 4 });
    expect(rows(store)).toMatchObject([{ request_id: requestId, question: "QG", tokens_in: 11, tokens_out: 12 }]);
    // The call itself adds nothing to the account: the batch adds the shares of the requests.
    expect(questions.takeUsage()).toMatchObject({ input: 0, output: 0 });
    questions.addUsage(res.usage);
    expect(questions.takeUsage()).toEqual({ input: 11, output: 12, cacheRead: 3, cacheWrite: 4 });
  });

  it("lands a row through createQuestions, the factory that the worker command calls", async () => {
    const store = openStore(":memory:", { embeddingModel: "m" });
    const requestId = enqueueRequest(store, { change: "c", justification: "j" }, T0);
    const questions = createQuestions(config, new Fake([reply(good)]), { store });
    await questions.q4(input, { ...ctx, requestId });
    expect(rows(store)).toMatchObject([{ request_id: requestId, question: "Q4" }]);
  });
});
