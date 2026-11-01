// A transport that runs one question through the Claude Code CLI in headless mode.
// It serves the user who has a Claude Code login and no API key. The choice between it and the SDK is in select.ts.
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import which from "which";
import { z } from "zod";
import { EnvVar, LogEvent, LogLevel, MessageRole, StopReason } from "../../../domain/enums.js";
import { withTempFolder, type Env } from "../../../env.js";
import { stderrLogger, type Logger } from "../../../log/index.js";
import { errorMessage } from "../../../must.js";
import { RateLimitError, TransientError, looksRateLimited, looksTransient } from "../errors.js";
import { cliModel } from "../models.js";
import type { CallRequest, CallResponse, Transport } from "./types.js";

/** Characters of a failure text kept in an error message. */
const MESSAGE_CHARS = 300;
/** Characters of a failure text kept for the log. */
const LOG_TEXT_CHARS = 500;
/** Characters of one detail (the errors list, the result text) kept in a failure reason. */
const DETAIL_CHARS = 200;
/**
 * Retries of the delete of a temp folder, 5 s in all with the delay below
 * (docs/technical/deployment.md#cli-transport-temp-folders). The Claude CLI and its children can still write to the
 * config folder after the main process ends.
 */
const RM_MAX_RETRIES = 20;
/** Milliseconds between two tries to delete a temp folder. */
const RM_RETRY_DELAY_MS = 250;

/**
 * Finds the Claude Code binary: `WIKIFACT_CLAUDE_BIN`, then `~/.local/bin/claude(.exe)`, then PATH.
 *
 * @param env - the parsed environment; `raw` supplies the home directory and PATH
 * @returns the path of the binary, or null when none is found
 * @sideEffects checks files for existence; scans the PATH directories
 */
export function findClaudeBinary(env: Env): string | null {
  if (env.claudeBin) return env.claudeBin;
  const home = env.raw.USERPROFILE ?? env.raw.HOME ?? "";
  for (const p of [join(home, ".local", "bin", "claude.exe"), join(home, ".local", "bin", "claude")])
    if (existsSync(p)) return p;
  return which.sync("claude", { path: env.raw.PATH ?? "", nothrow: true });
}

const DENIED_TOOLS = [
  "Bash",
  "PowerShell",
  "Edit",
  "Write",
  "Read",
  "Glob",
  "Grep",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "Task",
  "Agent",
  "TodoWrite",
  "ToolSearch",
  "Skill",
];

/**
 * Builds the text of the system prompt of a call: the fixed prompt, then the `<wiki>` block when the question has one.
 * The text goes in a file because the block of the facts is about 120,000 characters and a Windows command line holds
 * 32,767.
 *
 * @param req - the request
 * @returns the fixed prompt, or the fixed prompt, a blank line and the wiki block
 * @sideEffects none
 */
export function cliSystemPrompt(req: CallRequest): string {
  return req.wiki === undefined ? req.system : `${req.system}\n\n${req.wiki}`;
}

/**
 * Builds the argument list of one call. The material goes on stdin and the system prompt in a file, because both can
 * be long.
 *
 * @param req - the model, JSON schema and thinking flag; `effort` is passed only when `thinking` is true (Haiku 4.5
 *   takes none)
 * @param systemPromptFile - the path of the file that holds `cliSystemPrompt(req)`
 * @param bare - whether to pass `--bare`, which skips hooks, plugin sync and CLAUDE.md discovery
 * @returns the arguments after the binary: print mode, JSON output, no tools, no MCP, no session persistence
 * @sideEffects none
 */
export function cliArgs(req: CallRequest, systemPromptFile: string, bare = false): string[] {
  return [
    "-p",
    ...(bare ? ["--bare"] : []),
    "--system-prompt-file",
    systemPromptFile,
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(req.schema),
    "--model",
    cliModel(req.model),
    ...(req.thinking ? ["--effort", req.effort] : []), // Haiku takes no effort
    // No tool of any kind. `--tools ""` removes the built-in tools; the rest closes what it leaves open:
    // no MCP server, nothing is allowed without a prompt (dontAsk denies instead of waiting), and the
    // tool names that a model may still try are denied. The answer goes through the structured-output channel only.
    "--tools",
    "",
    "--strict-mcp-config",
    "--permission-mode",
    "dontAsk",
    "--disallowedTools",
    DENIED_TOOLS.join(","),
    "--no-session-persistence",
    "--disable-slash-commands",
    "--setting-sources",
    "project",
  ];
}

/**
 * Joins the messages into the one text that goes on stdin. A retry carries the first answer and the validation error.
 *
 * @param messages - the conversation, starting with the user message
 * @returns the text for stdin: the first message alone, or all messages with the assistant turns tagged as the
 *   previous answer
 * @throws {Error} when `messages` is empty
 * @sideEffects none
 */
function cliPrompt(messages: CallRequest["messages"]): string {
  const [first, ...rest] = messages;
  if (first === undefined) throw new Error("the request has no message");
  if (rest.length === 0) return first.content;
  return [
    first.content,
    ...rest.map((m) =>
      m.role === MessageRole.Assistant ? `<your_previous_answer>\n${m.content}\n</your_previous_answer>` : m.content,
    ),
  ].join("\n\n");
}

// ---- The JSON result of `--output-format json` ----

/** Each field is read loosely: one of a wrong type reads as absent, as the field checks of the CLI output did. */
const cliResultSchema = z.looseObject({
  stop_reason: z.string().optional().catch(undefined),
  subtype: z.string().optional().catch(undefined),
  is_error: z.unknown().optional(),
  num_turns: z.number().optional().catch(undefined),
  errors: z.array(z.unknown()).optional().catch(undefined),
  result: z.unknown().optional(),
  structured_output: z.unknown().optional(),
  duration_api_ms: z.number().optional().catch(undefined),
  usage: z
    .looseObject({
      input_tokens: z.number().optional().catch(undefined),
      output_tokens: z.number().optional().catch(undefined),
      cache_read_input_tokens: z.number().optional().catch(undefined),
      cache_creation_input_tokens: z.number().optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
});

type CliResult = z.infer<typeof cliResultSchema>;

const isResultEvent = (x: unknown): boolean => z.looseObject({ type: z.literal("result") }).safeParse(x).success;

// The result object of the CLI output: the output itself, or the `result` event of an array of events.
function pickResult(json: unknown): CliResult | undefined {
  const events: unknown[] | undefined = Array.isArray(json) ? json : undefined;
  const picked = events ? (events.find(isResultEvent) ?? events.at(-1)) : json;
  const parsed = cliResultSchema.safeParse(picked);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Builds a short reason from a failed JSON result: the stop reason, the turns, the subtype and the text.
 *
 * @param out - stdout of the CLI
 * @returns the reason, or undefined when stdout holds no JSON result with detail
 * @sideEffects none
 */
function explainFailure(out: string): string | undefined {
  let json: unknown;
  try {
    json = JSON.parse(out);
  } catch {
    return undefined;
  }
  const j = pickResult(json);
  if (!j) return undefined;
  const parts = [
    j.stop_reason ? `stop_reason ${j.stop_reason}` : "",
    j.num_turns !== undefined ? `${j.num_turns} turns` : "",
    j.subtype ? `subtype ${j.subtype}` : "",
    j.errors?.length ? `errors ${JSON.stringify(j.errors).slice(0, DETAIL_CHARS)}` : "",
    typeof j.result === "string" && j.result ? `result ${j.result.slice(0, DETAIL_CHARS)}` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : undefined;
}

// The answer text of a successful result: `structured_output`, else `result` as text or as an object.
function answerText(j: CliResult): string | undefined {
  // The field name of the structured answer is `structured_output` per the CLI docs of --json-schema;
  // not verified against a live run. Fall back to `result`, as text or as an object.
  if (j.structured_output !== undefined && j.structured_output !== null) {
    return typeof j.structured_output === "string" ? j.structured_output : JSON.stringify(j.structured_output);
  }
  if (typeof j.result === "string" && j.result.trim() !== "") return j.result;
  if (j.result && typeof j.result === "object") return JSON.stringify(j.result);
  return undefined;
}

/**
 * Reads the JSON result of `--output-format json`.
 *
 * @param out - stdout of the CLI, a JSON object or an array of events
 * @returns the answer text, the stop reason (`tool_use` or none reads as `end_turn`) and the usage; a refusal
 *   returns an empty text with stop reason `refusal`
 * @throws {Error} when stdout holds no JSON or no result object, the result is an error (`is_error`, or a subtype
 *   other than `success`), or it has neither `structured_output` nor `result`
 * @sideEffects none
 */
export function parseCliResult(out: string): CallResponse {
  let json: unknown;
  try {
    json = JSON.parse(out);
  } catch {
    throw new Error(`claude printed no JSON result: ${out.slice(0, MESSAGE_CHARS)}`);
  }
  const j = pickResult(json);
  if (!j) throw new Error("claude printed no result");
  const u = j.usage;
  const usage = {
    input: u?.input_tokens ?? 0,
    output: u?.output_tokens ?? 0,
    cacheRead: u?.cache_read_input_tokens ?? 0,
    cacheWrite: u?.cache_creation_input_tokens ?? 0,
  };
  if (j.stop_reason === StopReason.Refusal) return { stopReason: StopReason.Refusal, text: "", usage };
  // With --json-schema the CLI answers through a hidden structured-output tool call, so a good result has
  // `stop_reason: "tool_use"`, `subtype: "success"` and the parsed answer. `stop_reason` does not decide.
  // The call fails when `is_error` is true or `subtype` is something other than "success" (the first Q4 failures:
  // is_error true, 6 turns), with a reason that names stop_reason, turns and subtype.
  if (j.is_error || (j.subtype !== undefined && j.subtype !== "success")) {
    const fallback = (typeof j.result === "string" ? j.result : (j.subtype ?? "unknown")).slice(0, MESSAGE_CHARS);
    throw new Error(`claude reported an error: ${explainFailure(out) ?? fallback}`);
  }
  const text = answerText(j);
  if (text === undefined)
    throw new Error(`claude returned no structured_output and no result: ${explainFailure(out) ?? "no detail"}`);
  // The tool_use of the structured-output call is a normal end of the answer.
  return {
    stopReason: j.stop_reason === StopReason.ToolUse || !j.stop_reason ? StopReason.EndTurn : j.stop_reason,
    text,
    usage,
    timing: { wallMs: 0, apiMs: j.duration_api_ms },
  };
}

// Tells a rate limit or a transient failure from any other failure of a call.
// The text that is kept leads with the readable reason (stop_reason, subtype, result), then stderr.
function classifyFailure(text: string, out: string, err: string): RateLimitError | TransientError | null {
  if (looksRateLimited(text)) {
    const readable = `${explainFailure(out) ?? ""} ${err.trim()} ${text}`.trim();
    return new RateLimitError(`rate limited: ${readable.slice(0, MESSAGE_CHARS)}`, readable.slice(0, LOG_TEXT_CHARS));
  }
  // A stray corrupted-config error is retryable, like a rate limit but without slowing the pool down.
  if (looksTransient(text))
    return new TransientError(`transient: ${text.slice(0, MESSAGE_CHARS)}`, text.slice(0, LOG_TEXT_CHARS));
  return null;
}

// Deletes the temp folders of one call. A folder that still fails after the retries is logged and the call goes on.
async function removeDirs(dirs: string[], log: Logger): Promise<void> {
  const options = { recursive: true, force: true, maxRetries: RM_MAX_RETRIES, retryDelay: RM_RETRY_DELAY_MS };
  const results = await Promise.allSettled(dirs.map((d) => rm(d, options)));
  results.forEach((r, i) => {
    if (r.status === "rejected")
      log({ event: LogEvent.TempFolderNotDeleted, level: LogLevel.Warn, dir: dirs[i], error: errorMessage(r.reason) });
  });
}

/** The options of `CliTransport`. */
export interface CliTransportOptions {
  /** The path of the Claude Code binary. */
  claudeBin: string;
  /** Arguments before the flags; a test runs `node fake.mjs` this way. */
  prefixArgs?: string[];
  /**
   * `--bare` skips hooks, plugin sync, keychain reads and CLAUDE.md discovery (`Env.cliBare`, from
   * WIKIFACT_CLI_BARE=1). Default false.
   */
  bare?: boolean;
  /**
   * The environment of the child process. The login of the CLI (`CLAUDE_CODE_OAUTH_TOKEN`), `PATH` and the proxy
   * variables reach `claude` only through it, so the caller passes the whole environment (`Env.raw`); this is the one place
   * that needs it. The transport adds `CLAUDE_CONFIG_DIR`, `TEMP`, `TMP`, `TMPDIR` and `FORCE_PROMPT_CACHING_5M` on top.
   */
  childEnv: NodeJS.ProcessEnv;
  /** Receives the line of a temp folder that cannot be deleted. Default: the stderr logger. */
  log?: Logger;
}

/**
 * The value of `FORCE_PROMPT_CACHING_5M` in the child env: `claude -p` then writes the cache for 5 minutes (1.25 times
 * the input price), not for 1 hour (2 times) as it does with the Claude Code login
 * (docs/technical/updates.md#call-settings, #79).
 */
const FORCE_CACHE_5M = "1";

/** Runs each question as `claude -p` in a child process. */
export class CliTransport implements Transport {
  /**
   * Creates the transport.
   *
   * @param opts - the binary, the leading arguments, the bare flag and the environment of the child
   */
  constructor(private readonly opts: CliTransportOptions) {}

  /**
   * Runs one request in a child process and parses its JSON result.
   *
   * @param req - the model, prompt, wiki block, messages, schema and thinking settings of the call; the messages go to
   *   the child's stdin, the system prompt and the wiki block go in `system-prompt.txt` in the folder of the call
   *   (`--system-prompt-file`), the rest become flags
   * @param signal - kills the child when it aborts; the promise then rejects with `Error("aborted")`
   * @returns the answer, the stop reason, the usage and the timing (`wallMs` in ms, `apiMs` as the CLI reports it)
   * @throws {RateLimitError} when the output or stderr looks rate limited
   * @throws {TransientError} when the CLI printed a corrupted-config error (a retry fixes it)
   * @throws {Error} when the binary cannot run, exits non-zero, or prints a result that `parseCliResult` rejects
   * @sideEffects spawns the `claude` child process with the environment `childEnv` plus its own
   *   `CLAUDE_CONFIG_DIR` and `FORCE_PROMPT_CACHING_5M=1` (it overrides the caller's value) and with `TEMP`, `TMP` and
   *   `TMPDIR` set to a folder in the config folder; creates two temp directories under the OS temp dir and removes them when the child ends, logging a folder
   *   that it cannot remove;
   *   writes the system prompt to a file in the first one and the material to the child's stdin; reads the clock
   */
  async send(req: CallRequest, signal: AbortSignal): Promise<CallResponse> {
    // A directory of its own per call, so no project CLAUDE.md or settings are found and concurrent children share
    // nothing. It holds only the system prompt file.
    const cwd = mkdtempSync(join(tmpdir(), "wikifact-cli-"));
    // A config directory of its own per call (CLAUDE_CONFIG_DIR): parallel children otherwise write the same
    // ~/.claude.json and corrupt it. The login comes from CLAUDE_CODE_OAUTH_TOKEN in the environment.
    const configDir = mkdtempSync(join(tmpdir(), "wikifact-cli-cfg-"));
    // The temp folder of the child is in the config folder: Claude Code makes `<temp>/claude/<cwd>` there, and the
    // delete of the config folder deletes it (#75).
    const tempDir = join(configDir, "tmp");
    mkdirSync(tempDir);
    try {
      const t0 = Date.now();
      const { claudeBin, prefixArgs = [], bare = false, childEnv } = this.opts;
      const systemPromptFile = join(cwd, "system-prompt.txt");
      writeFileSync(systemPromptFile, cliSystemPrompt(req));
      const r = await execa(claudeBin, [...prefixArgs, ...cliArgs(req, systemPromptFile, bare)], {
        cwd,
        env: withTempFolder(
          { ...childEnv, [EnvVar.ClaudeConfigDir]: configDir, [EnvVar.ClaudeForcePromptCaching5m]: FORCE_CACHE_5M },
          tempDir,
        ),
        extendEnv: false, // the child gets `childEnv` and nothing else
        input: cliPrompt(req.messages),
        cancelSignal: signal,
        reject: false,
        windowsHide: true,
        stripFinalNewline: false,
      });
      const wallMs = Date.now() - t0;
      const { stdout: out, stderr: err } = r;
      if (r.isCanceled) throw new Error("aborted");
      if (r.exitCode === undefined) {
        // The process did not start, or a signal ended it.
        throw new Error(`could not run ${claudeBin}: ${r.originalMessage ?? r.shortMessage ?? "unknown error"}`);
      }
      // A rate limit is told apart so that the eval pool can slow down and retry (the exact text is kept).
      if (r.exitCode !== 0) {
        throw (
          classifyFailure(`${err}\n${out}`, out, err) ??
          new Error(`claude exited ${r.exitCode}: ${explainFailure(out) ?? (err || out).slice(0, LOG_TEXT_CHARS)}`)
        );
      }
      try {
        const parsed = parseCliResult(out);
        return { ...parsed, timing: { wallMs, apiMs: parsed.timing?.apiMs } };
      } catch (e) {
        const message = errorMessage(e);
        throw classifyFailure(`${message}\n${out}`, out, err) ?? (e instanceof Error ? e : new Error(message));
      }
    } finally {
      await removeDirs([cwd, configDir], this.opts.log ?? stderrLogger());
    }
  }
}
