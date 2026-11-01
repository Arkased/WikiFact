import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { Effort, MessageRole, QuestionKind } from "../../../../domain/enums.js";
import { AnthropicTransport } from "../anthropic.js";
import { cliSystemPrompt } from "../cli.js";
import type { CallRequest } from "../types.js";

const request: CallRequest = {
  model: "claude-sonnet-5-5",
  kind: QuestionKind.Judgment,
  effort: Effort.High,
  system: "FIXED PROMPT",
  wiki: "<wiki>\nSubject: S\nTags:\n- t\n</wiki>",
  messages: [{ role: MessageRole.User, content: "INPUT" }],
  schema: { type: "object" },
  maxTokens: 1000,
  stream: false,
  thinking: false,
  fallback: false,
};

/**
 * Builds an SDK client that records the parameters of the one request.
 *
 * @returns the client, and a getter for the recorded parameters
 * @sideEffects none
 */
function fakeClient(): { client: Anthropic; params: () => Anthropic.Beta.MessageCreateParamsNonStreaming } {
  let seen: Anthropic.Beta.MessageCreateParamsNonStreaming | undefined;
  const client = {
    beta: {
      messages: {
        create: (p: Anthropic.Beta.MessageCreateParamsNonStreaming) => {
          seen = p;
          return Promise.resolve({
            content: [{ type: "text", text: "{}" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 5, cache_creation_input_tokens: 7 },
          });
        },
      },
    },
  } as unknown as Anthropic;
  return {
    client,
    params: () => {
      if (!seen) throw new Error("no request was sent");
      return seen;
    },
  };
}

describe("the cached prefix of a request", () => {
  it("the Anthropic transport sends the fixed prompt and the wiki block as 2 cached system blocks, and only the input in the message", async () => {
    const { client, params } = fakeClient();
    const res = await new AnthropicTransport(client).send(request, new AbortController().signal);
    const p = params();
    expect(p.system).toEqual([
      { type: "text", text: request.system, cache_control: { type: "ephemeral" } },
      { type: "text", text: request.wiki, cache_control: { type: "ephemeral" } },
    ]);
    expect(p.messages).toEqual([{ role: MessageRole.User, content: "INPUT" }]);
    expect(res.usage).toMatchObject({ cacheRead: 5, cacheWrite: 7 });
  });

  it("the Anthropic transport sends one cached system block for a question with no wiki block", async () => {
    const { client, params } = fakeClient();
    await new AnthropicTransport(client).send({ ...request, wiki: undefined }, new AbortController().signal);
    expect(params().system).toEqual([{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }]);
  });

  it("the CLI transport appends the wiki block to the system prompt", () => {
    const prompt = cliSystemPrompt(request);
    expect(prompt.startsWith(request.system)).toBe(true);
    expect(prompt.endsWith(request.wiki ?? "")).toBe(true);
    expect(cliSystemPrompt({ ...request, wiki: undefined })).toBe(request.system);
  });
});
