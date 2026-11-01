// technical/updates.md, "Pipeline", call settings. One place for the settings that every question shares:
// structured output, adaptive thinking with the configured effort, the server-side fallback,
// one cache breakpoint, the token limit, the wall-clock timeout (F21), the one retry on
// invalid output (F18), the failure on a refusal (F19), and the token usage.
import { z } from "zod";
import type { QuestionSettings } from "../../config/index.js";
import {
  MessageRole,
  QuestionErrorCode,
  QuestionKind,
  StopReason,
  type GroupQuestionId,
  type QuestionId,
} from "../../domain/enums.js";
import { errorMessage } from "../../must.js";
import { recordModelCall, type Store } from "../../store/index.js";
import { withFailedUsage, type QuestionContext, type TokenUsage } from "../types.js";
import { QuestionError } from "./errors.js";
import { modelFeatures } from "./models.js";
import type { CallRequest, CallResponse, Transport, Usage } from "./transport/types.js";

/** What a question file declares. */
export interface QuestionSpec<I, O, Id extends QuestionId | GroupQuestionId = QuestionId> {
  id: Id;
  kind: QuestionKind;
  /** The fixed prompt. It holds no per-request text, so one cache breakpoint covers it. */
  system: string;
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  /**
   * Renders the `<wiki>` block (the subject). The transport puts it in the cached prefix,
   * after the fixed prompt, so it holds nothing of the input. Absent for a question with no wiki block.
   */
  wiki?(ctx: QuestionContext): string;
  /** Builds the user message from the input alone: the block of `wiki` is not in it. */
  render(input: I, ctx: QuestionContext): string;
  /** Rules the schema cannot say. A string is a validation error and triggers the one retry. */
  check?(output: O, input: I, ctx: QuestionContext): string | undefined;
}

/** The token limit of a classification answer. */
export const CLASSIFICATION_MAX_TOKENS = 4096;
/** The token limit of a judgment or drafting answer. */
export const LONG_MAX_TOKENS = 16000;
/** Attempts per question: the first, and one retry with the validation error (F18). */
const MAX_ATTEMPTS = 2;
const MS_PER_SECOND = 1000;

/**
 * Builds the JSON Schema of an output schema, for the structured-output setting.
 *
 * @param output - the zod schema of the answer
 * @returns the JSON Schema without its `$schema` key
 * @sideEffects none
 */
export function jsonSchemaOf(output: z.ZodType): Record<string, unknown> {
  const schema: Record<string, unknown> = { ...z.toJSONSchema(output, { io: "output", unrepresentable: "any" }) };
  delete schema.$schema;
  return schema;
}

const zeroUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

/** The options of a Caller. */
export interface CallerOptions {
  transport: Transport;
  /** Seconds. Config `questionTimeout`. */
  timeoutSeconds: number;
  /**
   * The store with the write connection. With it, each call that returns a usage for a question with a request id
   * writes its `model_calls` row (technical/updates.md, "Model call rows"). Absent means no row (an eval).
   */
  store?: Store;
  /** Called when a call asks the question a second time, after an invalid answer (the one retry). Absent means nobody counts. */
  onRetry?: () => void;
}

/** What `send` needs to know about the question, for the model call row. */
interface CallMeta {
  question: string;
  model: string;
  effort: string;
  requestId: string | undefined;
  /** Receives the tokens of the call. */
  sink: Usage;
}

/** The question of one run, bundled so that the runner takes few parameters. */
interface Ask<I, O> {
  spec: QuestionSpec<I, O, QuestionId | GroupQuestionId>;
  settings: QuestionSettings;
  input: I;
  ctx: QuestionContext;
}

/** Asks the questions through one transport, with the shared settings, the timeout and the one retry. */
export class Caller {
  private usage: Usage = zeroUsage();

  /**
   * Creates the caller.
   *
   * @param opts - the transport and the timeout
   */
  constructor(private readonly opts: CallerOptions) {}

  /**
   * Returns the token usage since the last call to this method and resets it.
   *
   * @returns the usage
   * @sideEffects resets the usage counter
   */
  takeUsage(): TokenUsage {
    const u = this.usage;
    this.usage = zeroUsage();
    return { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite };
  }

  /**
   * Adds tokens to the usage counter that `takeUsage` drains.
   *
   * @param u - the tokens; the cache fields default to 0
   * @sideEffects changes the usage counter
   */
  addUsage(u: TokenUsage): void {
    this.usage.input += u.input;
    this.usage.output += u.output;
    this.usage.cacheRead += u.cacheRead ?? 0;
    this.usage.cacheWrite += u.cacheWrite ?? 0;
  }

  /**
   * Asks one question and returns the validated answer. An invalid answer is retried once with the error.
   *
   * @param spec - the question: its prompt, its schemas, its renderer and its extra rules
   * @param settings - the model and effort for this question
   * @param input - the question's input, rendered into the user message; it also goes to the spec's `check`
   * @param ctx - the wiki subject, rendered into the wiki block of the cached prefix
   * @returns the answer, parsed against the spec's output schema and passed by its `check`
   * @throws {QuestionError} with code `Refusal` (refusal that the fallback did not fix), `Truncated` (the answer hit
   *   the token limit), `Invalid` (still invalid after the one retry) or `Timeout` (no answer in `timeoutSeconds`)
   * @throws {RateLimitError} when the transport reports a rate limit (not retried here)
   * @sideEffects one or two transport calls, each with an abort signal that fires after `timeoutSeconds`;
   *   adds the tokens of each call to the usage counter that `takeUsage` drains; with a store and `ctx.requestId`,
   *   one `model_calls` transaction after each call that returns a usage; reads the clock
   */
  async ask<I, O>(
    spec: QuestionSpec<I, O, QuestionId | GroupQuestionId>,
    settings: QuestionSettings,
    input: I,
    ctx: QuestionContext,
  ): Promise<O> {
    const sink = zeroUsage();
    try {
      return await this.run({ spec, settings, input, ctx }, sink);
    } finally {
      this.addUsage(sink);
    }
  }

  /**
   * Asks one question like `ask`, but keeps its tokens out of the usage counter and returns them with the answer, so that
   * the caller can share them (the group call splits them over the requests of the group).
   *
   * @param spec - the question
   * @param settings - the model and effort for this question
   * @param input - the question input
   * @param ctx - the wiki subject and the request id of the model call row
   * @returns the validated answer and the tokens of its calls, the retry included
   * @throws {QuestionError} as `ask`; the error carries the tokens of the calls that were made (`failedUsageOf`)
   * @throws {RateLimitError} as `ask`; it carries the tokens too, and the round reads them only for a fall back, so a rate
   *   limit adds them to no request
   * @sideEffects as `ask`, except that the usage counter does not change
   */
  async askMeasured<I, O>(
    spec: QuestionSpec<I, O, QuestionId | GroupQuestionId>,
    settings: QuestionSettings,
    input: I,
    ctx: QuestionContext,
  ): Promise<{ value: O; usage: TokenUsage }> {
    const sink = zeroUsage();
    try {
      const value = await this.run({ spec, settings, input, ctx }, sink);
      return { value, usage: { ...sink } };
    } catch (e) {
      throw withFailedUsage(e, { ...sink });
    }
  }

  /**
   * Runs the attempts of one question.
   *
   * @param q - the question
   * @param sink - receives the tokens of each attempt
   * @returns the validated answer
   * @throws {QuestionError} as `ask`
   * @sideEffects as `ask`, with the tokens added to `sink`
   */
  private async run<I, O>(q: Ask<I, O>, sink: Usage): Promise<O> {
    const { spec, settings, input, ctx } = q;
    const features = modelFeatures(settings.model);
    const schema = jsonSchemaOf(spec.output);
    const long = spec.kind !== QuestionKind.Classification;
    const maxTokens = long ? LONG_MAX_TOKENS : CLASSIFICATION_MAX_TOKENS;
    const messages: CallRequest["messages"] = [{ role: MessageRole.User, content: spec.render(input, ctx) }];
    const { timeoutSeconds } = this.opts;
    let lastError = "";
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) this.opts.onRetry?.();
      const res = await this.send(
        {
          model: settings.model,
          kind: spec.kind,
          effort: settings.effort,
          system: spec.system,
          wiki: spec.wiki?.(ctx),
          messages: [...messages],
          schema,
          maxTokens,
          stream: long,
          thinking: features.thinking,
          fallback: features.fallback,
        },
        {
          question: spec.id,
          model: settings.model,
          effort: settings.effort,
          requestId: ctx.requestId,
          sink,
        },
        timeoutSeconds,
      );
      if (res.stopReason === StopReason.Refusal) {
        throw new QuestionError(
          QuestionErrorCode.Refusal,
          `${spec.id}: the model refused, and the fallback did not fix it`,
        );
      }
      if (res.stopReason === StopReason.MaxTokens) {
        throw new QuestionError(QuestionErrorCode.Truncated, `${spec.id}: the answer hit max_tokens (${maxTokens})`);
      }
      const verdict = validate(spec, input, res.text, ctx);
      if (verdict.ok) return verdict.value;
      lastError = verdict.error;
      messages.push(
        { role: MessageRole.Assistant, content: res.text },
        {
          role: MessageRole.User,
          content: `Your answer is not valid: ${verdict.error}\nAnswer the question again with a valid answer.`,
        },
      );
    }
    throw new QuestionError(QuestionErrorCode.Invalid, `${spec.id}: invalid output after one retry: ${lastError}`);
  }

  /**
   * Sends one request through the transport, with an abort signal that fires after the timeout, and records its usage.
   *
   * @param req - the request
   * @param meta - the question, model and ids, for the model call row
   * @param timeoutSeconds - the wall-clock limit of this call: the configured timeout
   * @returns the transport's response
   * @throws {QuestionError} with code `Timeout` when no answer comes within `timeoutSeconds`
   * @sideEffects one transport call; adds its tokens to `meta.sink`; with a store and a request id, one
   *   `model_calls` transaction; a timer that is cleared on return; reads the clock
   */
  private async send(req: CallRequest, meta: CallMeta, timeoutSeconds: number): Promise<CallResponse> {
    const id = meta.question;
    const startedAt = Date.now();
    const controller = new AbortController();
    const signal = controller.signal;
    const timer = setTimeout(() => controller.abort(), timeoutSeconds * MS_PER_SECOND);
    const timeoutError = () =>
      new QuestionError(QuestionErrorCode.Timeout, `${id}: no answer within ${timeoutSeconds} seconds`);
    // The race covers a transport that ignores the signal.
    const timeout = new Promise<never>((_, reject) => {
      signal.addEventListener("abort", () => reject(timeoutError()), { once: true });
    });
    try {
      const sent = this.opts.transport.send(req, signal);
      sent.catch(() => {
        /* the race below reports the outcome */
      });
      const res = await Promise.race([sent, timeout]);
      meta.sink.input += res.usage.input;
      meta.sink.output += res.usage.output;
      meta.sink.cacheRead += res.usage.cacheRead;
      meta.sink.cacheWrite += res.usage.cacheWrite;
      // Right after the transport returns, so that an answer that fails validation or hits the token limit still has its row.
      const { store } = this.opts;
      if (store !== undefined && meta.requestId !== undefined) {
        const at = Date.now();
        recordModelCall(store, {
          requestId: meta.requestId,
          question: meta.question,
          model: meta.model,
          effort: meta.effort,
          tokensIn: res.usage.input,
          tokensOut: res.usage.output,
          tokensCacheRead: res.usage.cacheRead,
          tokensCacheWrite: res.usage.cacheWrite,
          durationMs: res.timing?.wallMs ?? at - startedAt,
          at,
        });
      }
      return res;
    } catch (e) {
      if (e instanceof QuestionError) throw e;
      if (signal.aborted) throw timeoutError();
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** The result of `validate`: the parsed answer, or the error text that goes back to the model. */
type Verdict<O> = { ok: true; value: O } | { ok: false; error: string };

/**
 * Parses and checks the text of an answer against the schema and the rules of the spec.
 *
 * @param spec - the question
 * @param input - the material, for the rules that compare the answer with it
 * @param text - the answer text, JSON with or without a code fence
 * @param ctx - the subject, for the rules that compare the answer with the wiki
 * @returns the parsed answer, or the first error found
 * @sideEffects none
 */
function validate<I, O>(
  spec: QuestionSpec<I, O, QuestionId | GroupQuestionId>,
  input: I,
  text: string,
  ctx: QuestionContext,
): Verdict<O> {
  let json: unknown;
  try {
    json = JSON.parse(stripFence(text));
  } catch (e) {
    return { ok: false, error: `the answer is not JSON (${errorMessage(e)})` };
  }
  const parsed = spec.output.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
    };
  }
  const rule = spec.check?.(parsed.data, input, ctx);
  if (rule) return { ok: false, error: rule };
  return { ok: true, value: parsed.data };
}

/**
 * Removes the code fence that a model may put around a JSON answer.
 *
 * @param t - the answer text
 * @returns the text without the fence
 * @sideEffects none
 */
export const stripFence = (t: string): string =>
  t
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
