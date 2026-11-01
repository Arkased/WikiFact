// The real `Questions`: ten specs, one caller.
import type { QuestionSettings } from "../../config/index.js";
import { LogEvent, LogLevel, QuestionId, questionMethod } from "../../domain/enums.js";
import type { Logger } from "../../log/index.js";
import type { Store } from "../../store/index.js";
import type { QuestionContext, Questions, TokenUsage } from "../types.js";
import { Caller, type QuestionSpec } from "./call.js";
import { buildGroupCall } from "./group-call.js";
import { SPECS } from "./specs/index.js";
import type { Transport } from "./transport/types.js";

/** The options of `buildQuestions`. */
export interface QuestionsOptions {
  settings: Record<QuestionId, QuestionSettings>;
  /** Seconds. */
  timeoutSeconds: number;
  transport: Transport;
  /** The store with the write connection, for the `model_calls` rows. Absent means no row. */
  store?: Store;
  /** Receives one line per question when `logCalls` is true. Absent means no log. */
  log?: Logger;
  /**
   * True to log each question's input, context and output through `log`: `Env.logCalls` (WIKIFACT_LOG_CALLS=1), or
   * always when `log` writes the call log file (`createQuestions`).
   */
  logCalls?: boolean;
}

type Method = (input: never, ctx: QuestionContext) => Promise<unknown>;

/**
 * Builds the `Questions` of the pipeline: one method per spec, all through one caller.
 *
 * @param o - the settings per question, the timeout, the transport, the optional call log and the `logCalls` flag
 * @returns the questions, with `takeUsage` for the token usage since the last call
 * @sideEffects none at build; each question call uses the transport and, when `logCalls` is true, writes a log line
 */
export function buildQuestions(
  o: QuestionsOptions,
): Questions & { takeUsage(): TokenUsage; addUsage(u: TokenUsage): void } {
  const caller = new Caller({ transport: o.transport, timeoutSeconds: o.timeoutSeconds, store: o.store });
  const methods: Record<string, Method> = {};
  const bind = (spec: QuestionSpec<unknown, unknown>): void => {
    methods[questionMethod(spec.id)] = async (input: unknown, ctx: QuestionContext) => {
      const output = await caller.ask(spec, o.settings[spec.id], input, ctx);
      // logCalls: one JSON line per question with its request, model, effort, exact input, ctx and output.
      // Only what the pipeline passed in and the model answered; no credential is ever in them.
      if (o.log && o.logCalls) {
        const { requestId, ...rest } = ctx;
        const { model, effort } = o.settings[spec.id];
        o.log({
          event: LogEvent.QuestionCall,
          level: LogLevel.Info,
          ...(requestId === undefined ? {} : { requestId }),
          question: spec.id,
          model,
          effort,
          input,
          ctx: rest,
          output,
        });
      }
      return output;
    };
  };
  for (const spec of Object.values(SPECS)) bind(spec);
  // The methods were built from the ten specs, so the object has the shape of `Questions`.
  return {
    ...methods,
    group: buildGroupCall(o),
    takeUsage: () => caller.takeUsage(),
    addUsage: (u: TokenUsage) => caller.addUsage(u),
  } as unknown as Questions & { takeUsage(): TokenUsage; addUsage(u: TokenUsage): void };
}
