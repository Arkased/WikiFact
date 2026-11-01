// `node dist/wiki-submit.js`: the hook on 2 events. On SubagentStop it blocks the stop of a subagent that searched the
// wiki and sent no `requestChange`, once. A background subagent ends with its report tool `SubagentHandback` and
// SubagentStop fires after it, so the same check also runs on PreToolUse of `SubagentHandback`: it denies the first call
// (no earlier call of the report tool in the transcript) with a reason that asks for the report again. The wiki name is
// `wiki.name` in `.claude/setup.config.json`. With no config file, or `wiki.name` null, it does nothing. A fault prints
// nothing to stdout and exits 0, so it never blocks.
//
// Format source: the hooks reference of Claude Code, https://code.claude.com/docs/en/hooks, section "SubagentStop".
// The input has `stop_hook_active` and `agent_transcript_path` (the transcript of the subagent). A hook blocks the stop
// with the stdout JSON `{"decision": "block", "reason": <text>}`. PreToolUse (same page) has `agent_id` inside a
// subagent, `transcript_path` (the main session) and `session_id`, `tool_use_id` (the id of the call being checked), and
// no documented `agent_transcript_path`; the transcript of the subagent is
// `<folder of transcript_path>/<session_id>/subagents/agent-<agent_id>.jsonl` (the layout of a real transcript). A deny
// is `hookSpecificOutput.permissionDecision: "deny"` with `permissionDecisionReason`; a denied call is still an
// assistant `tool_use` entry in the transcript. A transcript is JSONL; an assistant line holds `message.content[]`
// items of `type` "tool_use" with `name` and `input`.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { loadWikiName } from "./config.js";
import { ContentItemType, HookEvent, TranscriptEntryType } from "./enums.js";
import { errorMessage } from "./errors.js";
import { isMain } from "./main.js";

/** The report tool of a background subagent. */
const HANDBACK_TOOL = "SubagentHandback";

const INPUT = z.object({
  hook_event_name: z.string().optional(),
  stop_hook_active: z.boolean().optional().default(false),
  agent_transcript_path: z.string().optional(),
  transcript_path: z.string().optional(),
  session_id: z.string().optional(),
  agent_id: z.string().optional(),
  tool_use_id: z.string().optional(),
});

/** One line of a transcript; a line that does not parse is skipped. */
const LINE = z.object({
  type: z.enum(TranscriptEntryType).optional().catch(undefined),
  message: z.object({
    content: z.union([
      z.string(),
      z.array(
        z.object({
          type: z.enum(ContentItemType).optional().catch(undefined),
          id: z.string().optional(),
          name: z.string().optional(),
          input: z.object({ wiki: z.string().optional() }).passthrough().optional().catch(undefined),
        }),
      ),
    ]),
  }),
});

/** The hook input: the flag and the path of the transcript of the subagent that stops. */
export interface StopInput {
  stopHookActive: boolean;
  transcriptPath: string;
}

/**
 * Parses the stdin JSON.
 *
 * @param input - the JSON that Claude Code sends on stdin
 * @returns the flag and the path
 * @throws {Error} when the input is malformed or holds no `agent_transcript_path`
 * @sideEffects none
 */
export function parseStopInput(input: unknown): StopInput {
  const p = INPUT.parse(input);
  if (p.agent_transcript_path === undefined) throw new Error("no agent_transcript_path");
  return { stopHookActive: p.stop_hook_active, transcriptPath: p.agent_transcript_path };
}

/** The hook input of PreToolUse on the report tool: the path of the transcript of the subagent. */
export interface HandbackInput {
  isSubagent: boolean;
  transcriptPath: string;
  toolUseId?: string;
}

/**
 * Parses the stdin JSON of a PreToolUse call. The call is a subagent call only with an `agent_id`.
 *
 * @param input - the JSON that Claude Code sends on stdin
 * @returns the path of the transcript of the subagent and the `tool_use_id` of the call; `isSubagent` is false for a call outside a subagent
 * @throws {Error} when the input is malformed or lacks the fields for the path
 * @sideEffects none
 */
export function parseHandbackInput(input: unknown): HandbackInput {
  const p = INPUT.parse(input);
  if (p.agent_id === undefined || p.agent_id === "") return { isSubagent: false, transcriptPath: "" };
  if (p.transcript_path === undefined || p.session_id === undefined) {
    throw new Error("no transcript_path or session_id");
  }
  return {
    isSubagent: true,
    transcriptPath: join(dirname(p.transcript_path), p.session_id, "subagents", `agent-${p.agent_id}.jsonl`),
    toolUseId: p.tool_use_id,
  };
}

function reasonStart(wikiName: string): string {
  return `You searched the \`${wikiName}\` wiki. Compare the facts it listed with what you found in the files. If the wiki lacked or got wrong something that you saw, send it now with \`requestChange\`: what you saw, and how you know.`;
}

/**
 * Builds the reason of the SubagentStop block, which asks the agent for a change request.
 *
 * @param wikiName - the name of the wiki
 * @returns the reason text
 * @sideEffects none
 */
export function blockReason(wikiName: string): string {
  return `${reasonStart(wikiName)} Else stop.`;
}

/**
 * Builds the reason of the PreToolUse deny of the report tool.
 *
 * @param wikiName - the name of the wiki
 * @returns the reason text
 * @sideEffects none
 */
export function denyReason(wikiName: string): string {
  return `${reasonStart(wikiName)} Then call \`${HANDBACK_TOOL}\` again with your report.`;
}

/**
 * Decides whether to block the stop of the subagent, from its whole transcript.
 *
 * @param stopHookActive - `stop_hook_active` of the input: a stop hook already blocked this stop
 * @param transcript - the JSONL text of the transcript of the subagent
 * @param wikiName - the name of the wiki (`wiki.name` of the config)
 * @returns the JSON to print on stdout, or null to let the agent stop
 * @sideEffects none; a transcript line that is not JSON or does not parse is skipped
 */
export function buildOutput(stopHookActive: boolean, transcript: string, wikiName: string): object | null {
  if (stopHookActive) return null;
  const s = scan(transcript, wikiName);
  return s.searched && !s.sent ? { decision: "block", reason: blockReason(wikiName) } : null;
}

/**
 * Decides whether to deny the report call of the subagent: the same check as `buildOutput`, and only when the
 * transcript holds no earlier call of the report tool. The call that the hook checks may already be in the transcript,
 * so a call with its id is not an earlier call.
 *
 * @param transcript - the JSONL text of the transcript of the subagent
 * @param wikiName - the name of the wiki (`wiki.name` of the config)
 * @param toolUseId - `tool_use_id` of the call that the hook checks
 * @returns the PreToolUse deny JSON to print on stdout, or null to allow the call
 * @sideEffects none
 */
export function buildHandbackOutput(transcript: string, wikiName: string, toolUseId?: string): object | null {
  const s = scan(transcript, wikiName, toolUseId);
  if (!s.searched || s.sent || s.handedBack) return null;
  return {
    hookSpecificOutput: {
      hookEventName: HookEvent.PreToolUse,
      permissionDecision: "deny",
      permissionDecisionReason: denyReason(wikiName),
    },
  };
}

/** What the transcript of a subagent shows. */
interface Scan {
  searched: boolean;
  sent: boolean;
  handedBack: boolean;
}

// Reads the whole transcript once. `handedBack` is true when it holds a `tool_use` of the report tool with an id other than `currentId`.
function scan(transcript: string, wikiName: string, currentId?: string): Scan {
  const result: Scan = { searched: false, sent: false, handedBack: false };
  for (const text of transcript.split("\n")) {
    if (text.trim() === "") continue;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      continue;
    }
    const line = LINE.safeParse(json);
    if (!line.success || line.data.type !== TranscriptEntryType.Assistant) continue;
    const items = typeof line.data.message.content === "string" ? [] : line.data.message.content;
    for (const item of items) {
      if (item.type !== ContentItemType.ToolUse || item.name === undefined) continue;
      if (item.name.endsWith("__requestChange")) result.sent = true;
      if (item.name.endsWith("__search") && item.input?.wiki === wikiName) result.searched = true;
      if (item.name === HANDBACK_TOOL && item.id !== currentId) result.handedBack = true;
    }
  }
  return result;
}

/**
 * Runs the hook on its stdin text. A fault never blocks: it is logged and the result is null.
 *
 * @param raw - the stdin text
 * @param readFile - reads a transcript file by path
 * @param getWikiName - gives `wiki.name` of the config, null when the project has no config file or no wiki
 * @param log - receives the message of a fault
 * @returns the JSON to print on stdout (a block on SubagentStop, a deny on PreToolUse), or null to let the agent stop
 *   or the call run
 * @sideEffects calls `log` on a fault
 */
export function run(
  raw: string,
  readFile: (path: string) => string,
  getWikiName: () => string | null,
  log: (message: string) => void,
): object | null {
  try {
    const wikiName = getWikiName();
    if (wikiName === null) return null;
    const json: unknown = JSON.parse(raw);
    if (INPUT.parse(json).hook_event_name === HookEvent.PreToolUse) {
      const call = parseHandbackInput(json);
      return call.isSubagent ? buildHandbackOutput(readFile(call.transcriptPath), wikiName, call.toolUseId) : null;
    }
    const input = parseStopInput(json);
    return buildOutput(input.stopHookActive, readFile(input.transcriptPath), wikiName);
  } catch (e) {
    log(`wiki-submit: ${errorMessage(e)}`);
    return null;
  }
}

if (isMain(import.meta.url)) {
  let raw = "";
  process.stdin.on("data", (c) => (raw += String(c)));
  process.stdin.on("end", () => {
    const output = run(
      raw,
      (p) => readFileSync(p, "utf8"),
      () => loadWikiName(),
      (m) => process.stderr.write(`${m}\n`),
    );
    if (output !== null) process.stdout.write(JSON.stringify(output));
  });
}
