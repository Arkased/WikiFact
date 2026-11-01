// The transport selection policy.
// ANTHROPIC_API_KEY set means the SDK; otherwise the CLI. WIKIFACT_TRANSPORT=sdk|cli overrides.
import { CallerKind, EnvVar, Mode, TransportName } from "../../../domain/enums.js";
import type { Env } from "../../../env.js";
import type { Logger } from "../../../log/index.js";
import { AnthropicTransport } from "./anthropic.js";
import { CliTransport, findClaudeBinary } from "./cli.js";
import type { Transport } from "./types.js";

/** The selection cannot give the caller a transport: a missing key or binary, or a bad override. */
export class TransportError extends Error {}

/** The chosen transport, its name, who asked and the rule that chose it. */
export interface Selected {
  transport: Transport;
  name: TransportName;
  kind: CallerKind;
  rule: string;
}

/** Options of `selectTransport`. */
export interface SelectOptions {
  /** The run mode; a worker in local mode follows the eval rule. */
  mode?: Mode;
  /** The process logger; the CLI transport logs a temp folder that it cannot delete through it. Default: stderr. */
  log?: Logger;
}

const RULES: Record<CallerKind, string> = {
  [CallerKind.Eval]: "eval: ANTHROPIC_API_KEY means the sdk, otherwise the cli; WIKIFACT_TRANSPORT=sdk|cli overrides",
  [CallerKind.Worker]:
    "worker: the sdk with ANTHROPIC_API_KEY; the cli only with an explicit WIKIFACT_TRANSPORT=cli (local development)",
};

/**
 * Chooses the transport. The CLI transport runs on a Claude Code login, which is for local development and the
 * evals only.
 * eval: ANTHROPIC_API_KEY means the SDK, otherwise the CLI. WIKIFACT_TRANSPORT=sdk|cli overrides.
 * worker: no key and no explicit WIKIFACT_TRANSPORT is a TransportError.
 *
 * @param kind - who asks: the eval or the worker
 * @param env - the parsed environment (`readEnv()`); the CLI transport's child process gets `env.raw` as its
 *   environment
 * @param opts - the run mode and the logger of the CLI transport
 * @returns the transport with its name and the rule that chose it
 * @throws {TransportError} when `WIKIFACT_TRANSPORT` is not sdk or cli, a deployed worker has neither a key nor an
 *   explicit transport, or the CLI is chosen and the `claude` binary is not found
 * @sideEffects checks the file system for the `claude` binary when the CLI is chosen; no network call and no process
 *   is started here
 */
export function selectTransport(kind: CallerKind, env: Env, opts: SelectOptions = {}): Selected {
  const forced = env.transport;
  // `readEnv` leaves a value that names no transport out of `env.transport`, so the text is read from `raw` to report it.
  const forcedText = env.raw[EnvVar.WikifactTransport];
  if (!forced && forcedText) throw new TransportError(`WIKIFACT_TRANSPORT must be sdk or cli, not ${forcedText}`);
  // Local mode (technical/deployment.md, "Local mode"): one user, one account, one machine. A worker follows the eval rule there.
  const local = kind === CallerKind.Worker && opts.mode === Mode.Local;
  if (kind === CallerKind.Worker && !local && !forced && !env.apiKey) {
    throw new TransportError(
      "The worker needs ANTHROPIC_API_KEY. The Claude Code login is for local development and the evals only; set WIKIFACT_TRANSPORT=cli for a local run.",
    );
  }
  const name = forced ?? (env.apiKey ? TransportName.Sdk : TransportName.Cli);
  const rule = local
    ? "worker, local mode: ANTHROPIC_API_KEY means the sdk, otherwise the cli (one user, one account, one machine)"
    : RULES[kind];
  if (name === TransportName.Sdk) return { transport: new AnthropicTransport(), name, kind, rule };
  const bin = findClaudeBinary(env);
  if (!bin)
    throw new TransportError(
      "the cli transport needs the Claude Code binary. Install it, or set WIKIFACT_CLAUDE_BIN, or set ANTHROPIC_API_KEY.",
    );
  const transport = new CliTransport({ claudeBin: bin, bare: env.cliBare, childEnv: env.raw, log: opts.log });
  return { transport, name, kind, rule };
}
