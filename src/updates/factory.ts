// The one place where the worker command gets its `Questions`.
import type { Config } from "../config/index.js";
import { CallerKind, LogEvent, LogLevel } from "../domain/enums.js";
import { readEnv } from "../env.js";
import { writesCallLog, type Logger } from "../log/index.js";
import type { Store } from "../store/index.js";
import type { Questions } from "./types.js";
import { buildQuestions, selectTransport, type Transport } from "./questions/index.js";

/** The options of `createQuestions`. */
export interface CreateQuestionsOptions {
  /** Who calls, for the choice of transport. Default: the worker. */
  kind?: CallerKind;
  /**
   * Receives the transport line and one line per question when `WIKIFACT_LOG_CALLS=1` or when it writes the call log
   * file (`writesCallLog`). Absent: no log.
   */
  log?: Logger;
  /** The write connection of the wiki: each call writes its `model_calls` row through it. Absent: no row (an eval). */
  store?: Store;
}

/**
 * The real questions, with the model and effort per question from the config.
 * Transport: ANTHROPIC_API_KEY set means the Anthropic SDK. The Claude Code CLI (a claude.ai login) is for the evals,
 * local development and local mode (technical/deployment.md, "Local mode"): `kind` "eval" falls back to it when there is no key, and `kind`
 * "worker" (the default) refuses it unless `config.mode` is "local" or WIKIFACT_TRANSPORT=cli is set.
 * One log line says which transport runs and under which rule. A test passes a fake transport.
 *
 * @param config - the wiki config: the model per question and the timeout
 * @param transport - the transport to use; absent means the choice by `kind`
 * @param opts - the kind of caller, the logger and the store for the `model_calls` rows
 * @returns the questions, with `takeUsage` for the token usage since the last call
 * @throws {TransportError} when no transport can be chosen (see `selectTransport`); never when `transport` is given
 * @sideEffects reads `process.env`; logs one `LogEvent.QuestionTransport` line through `log` when it chooses the
 *   transport; later question calls log through `log` when `WIKIFACT_LOG_CALLS=1` or `log` writes the call log, and
 *   write a `model_calls` row through `store`
 */
export function createQuestions(config: Config, transport?: Transport, opts: CreateQuestionsOptions = {}): Questions {
  const { kind = CallerKind.Worker, log, store } = opts;
  const env = readEnv();
  let t = transport;
  if (!t) {
    const sel = selectTransport(kind, env, { mode: config.mode, log });
    t = sel.transport;
    log?.({ event: LogEvent.QuestionTransport, level: LogLevel.Info, transport: sel.name, rule: sel.rule });
  }
  return buildQuestions({
    settings: config.questions,
    timeoutSeconds: config.questionTimeout,
    transport: t,
    store,
    log,
    logCalls: env.logCalls || (log !== undefined && writesCallLog(log)),
  });
}
