// The real transport: the Anthropic SDK.
import Anthropic from "@anthropic-ai/sdk";
import { RateLimitError } from "../errors.js";
import type { CallRequest, CallResponse, Transport } from "./types.js";

/** The SDK retries a failed request this many times before it throws. */
const SDK_MAX_RETRIES = 2;
/** The HTTP status of a rate limit. */
const HTTP_TOO_MANY_REQUESTS = 429;

/** The Anthropic SDK. The key comes from ANTHROPIC_API_KEY, or the active `ant auth` profile. */
export class AnthropicTransport implements Transport {
  private client?: Anthropic;

  /**
   * Creates the transport.
   *
   * @param client - an SDK client; absent means one is made on the first call
   */
  constructor(client?: Anthropic) {
    this.client = client;
  }

  /**
   * Sends one request through the SDK, streaming for the long kinds.
   *
   * @param req - the model, prompt, messages, JSON schema and token limit; `stream` selects streaming, `thinking`
   *   adds adaptive thinking with `effort`, `fallback` asks for the server-side fallback
   * @param signal - aborts the HTTP call; the call then rejects with the SDK's abort error
   * @returns the text of the answer, the stop reason (null when the API gives none), the usage and the wall time in ms
   * @throws {RateLimitError} on HTTP 429
   * @throws {Error} the SDK's own error for any other failure (after its 2 retries) or an abort
   * @sideEffects one network call to the Anthropic API; on first use creates the SDK client, which reads
   *   `ANTHROPIC_API_KEY` from the environment; reads the clock
   */
  async send(req: CallRequest, signal: AbortSignal): Promise<CallResponse> {
    const client = (this.client ??= new Anthropic({ maxRetries: SDK_MAX_RETRIES }));
    const params: Anthropic.Beta.MessageCreateParamsNonStreaming = {
      model: req.model,
      max_tokens: req.maxTokens,
      // One breakpoint after the fixed prompt and one after the wiki block: a call reads the longest prefix that is cached
      // (docs/technical/updates.md#call-settings, "The cached prefix").
      system: [req.system, ...(req.wiki === undefined ? [] : [req.wiki])].map((text) => ({
        type: "text" as const,
        text,
        cache_control: { type: "ephemeral" as const },
      })),
      messages: req.messages,
      output_config: {
        format: { type: "json_schema", schema: req.schema },
        ...(req.thinking ? { effort: req.effort } : {}),
      },
      ...(req.thinking ? { thinking: { type: "adaptive" as const } } : {}),
      ...(req.fallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    };
    const t0 = Date.now();
    let msg;
    try {
      msg = req.stream
        ? await client.beta.messages.stream(params, { signal }).finalMessage()
        : await client.beta.messages.create(params, { signal });
    } catch (e) {
      if (e instanceof Anthropic.APIError && e.status === HTTP_TOO_MANY_REQUESTS)
        throw new RateLimitError(`rate limited: ${e.message}`, e.message);
      throw e;
    }
    const wallMs = Date.now() - t0;
    const text = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    return {
      stopReason: msg.stop_reason,
      text,
      usage: {
        input: msg.usage.input_tokens,
        output: msg.usage.output_tokens,
        cacheRead: msg.usage.cache_read_input_tokens ?? 0,
        cacheWrite: msg.usage.cache_creation_input_tokens ?? 0,
      },
      timing: { wallMs },
    };
  }
}
