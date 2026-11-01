// Example Stop hook for Claude Code (technical/updates.md, "Consumer correction duty", O5): the harness-side lever of the correction duty.
//
// It blocks the stop when the transcript shows a wiki read (`getFact` or `search`) and no `requestChange`
// call, and tells the model to submit a correction if a fact disagreed with what it observed.
// It blocks one time per stop: when Claude Code sets `stop_hook_active`, the hook lets the stop through,
// so the hook cannot loop.
//
// Install: copy the snippet in settings.example.json into `.claude/settings.json` of the consumer's project
// and set the path to this file. Claude Code sends the hook input as JSON on stdin and reads the answer
// from stdout: `{"decision":"block","reason":"..."}` blocks, empty output with exit 0 allows.
//
// If the environment variable WIKIFACT_HOOK_LOG names a file, each run appends one JSON line to it.
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const REASON =
  "You read wiki facts (getFact or search) and made no requestChange call. " +
  "If any fact disagreed with what you observed, call requestChange now with what you saw and why. " +
  "If every fact agreed with what you observed, say so in one sentence and finish.";

/** The tool names in a transcript (JSON lines). A wiki tool name ends with the bare tool name. */
export function wikiToolCalls(transcript) {
  const names = [];
  for (const line of transcript.split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part?.type === "tool_use" && typeof part.name === "string") names.push(part.name);
    }
  }
  return names;
}

const tail = (name) => name.split("__").pop();

/** Returns the block decision, or null to allow the stop. */
export function decide(input, transcript) {
  if (input?.stop_hook_active) return null;
  const names = wikiToolCalls(transcript).map(tail);
  const read = names.some((n) => n === "getFact" || n === "search");
  const corrected = names.some((n) => n === "requestChange");
  return read && !corrected ? { decision: "block", reason: REASON } : null;
}

function main() {
  let raw;
  try {
    raw = readFileSync(0, "utf8");
  } catch {
    return;
  }
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }
  let transcript;
  try {
    transcript = readFileSync(input.transcript_path, "utf8");
  } catch {
    return;
  }
  const result = decide(input, transcript);
  if (process.env.WIKIFACT_HOOK_LOG) {
    try {
      appendFileSync(
        process.env.WIKIFACT_HOOK_LOG,
        JSON.stringify({ at: Date.now(), blocked: result !== null, active: !!input.stop_hook_active }) + "\n",
      );
    } catch {
      // The log is optional.
    }
  }
  if (result) process.stdout.write(JSON.stringify(result));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
