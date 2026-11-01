// `node dist/wiki-context.js`: the SessionStart and SubagentStart hook. It adds 2 lines of wiki instructions to the
// context of each session and each subagent at its start: search the wiki before reading files, and send what the wiki
// lacks with `requestChange` before the task ends. The wiki name is `wiki.name` in `.claude/setup.config.json`. With no
// config file, or `wiki.name` null, it prints nothing. A fault prints nothing to stdout and exits 0, so it never blocks.
//
// Format source: the hooks reference of Claude Code, https://code.claude.com/docs/en/hooks, sections "SessionStart"
// and "SubagentStart". The hook reads JSON on stdin with `hook_event_name`, and writes
// `{"hookSpecificOutput": {"hookEventName": <that event>, "additionalContext": <text>}}` to stdout.
import { z } from "zod";
import { loadWikiName } from "./config.js";
import { ContextEvent } from "./enums.js";
import { errorMessage } from "./errors.js";
import { isMain } from "./main.js";

const INPUT = z.object({ hook_event_name: z.enum(ContextEvent) });

/**
 * Builds the output of the hook for one event.
 *
 * @param input - the JSON that Claude Code sends on stdin
 * @param wikiName - the name of the wiki (`wiki.name` of the config), or null when the project has no wiki
 * @returns the JSON to print on stdout, or null when the project has no wiki (nothing to search: print nothing)
 * @throws {Error} when the input names no event that takes context
 * @sideEffects none
 */
export function buildOutput(input: unknown, wikiName: string | null): object | null {
  if (wikiName === null) return null;
  const parsed = INPUT.safeParse(input);
  if (!parsed.success) {
    throw new Error(`hook_event_name must be one of ${Object.values(ContextEvent).join(", ")}`);
  }
  const additionalContext = [
    `Search the \`${wikiName}\` wiki (the MCP tool \`search\`) before you read the files on a subject.`,
    "Before you finish your task, send what the wiki lacks or gets wrong with the `requestChange` tool: what you saw, and how you know.",
  ].join("\n");
  return { hookSpecificOutput: { hookEventName: parsed.data.hook_event_name, additionalContext } };
}

/**
 * Runs the hook on its stdin text. A fault never blocks: it is logged and the result is null.
 *
 * @param raw - the stdin text
 * @param getWikiName - gives `wiki.name` of the config, null when the project has no config file or no wiki
 * @param log - receives the message of a fault
 * @returns the JSON to print on stdout, or null to print nothing
 * @sideEffects calls `log` on a fault
 */
export function run(raw: string, getWikiName: () => string | null, log: (message: string) => void): object | null {
  try {
    const wikiName = getWikiName();
    if (wikiName === null) return null;
    return buildOutput(JSON.parse(raw), wikiName);
  } catch (e) {
    log(`wiki-context: ${errorMessage(e)}`);
    return null;
  }
}

if (isMain(import.meta.url)) {
  let raw = "";
  process.stdin.on("data", (c) => (raw += String(c)));
  process.stdin.on("end", () => {
    const output = run(
      raw,
      () => loadWikiName(),
      (m) => process.stderr.write(`${m}\n`),
    );
    if (output !== null) process.stdout.write(JSON.stringify(output));
  });
}
