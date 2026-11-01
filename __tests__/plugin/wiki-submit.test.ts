import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ContentItemType, TranscriptEntryType } from "../../plugin/src/enums.js";
import {
  blockReason,
  buildHandbackOutput,
  buildOutput,
  denyReason,
  parseHandbackInput,
  parseStopInput,
  run,
} from "../../plugin/src/wiki-submit.js";

const NAME = "fixture-wiki";

/**
 * One assistant transcript line with 1 tool call.
 *
 * @param name - the tool name
 * @param input - the tool input
 * @param id - the tool_use id
 * @returns the JSONL line
 */
function call(name: string, input: object, id = "t"): string {
  return JSON.stringify({
    type: TranscriptEntryType.Assistant,
    message: { content: [{ type: ContentItemType.ToolUse, id, name, input }] },
  });
}
const TEXT = JSON.stringify({
  type: TranscriptEntryType.Assistant,
  message: { content: [{ type: ContentItemType.Text, text: "hi" }] },
});
const SEARCH = call("mcp__wikifact__search", { wiki: NAME, query: "q" });
const CHANGE = call("mcp__wikifact__requestChange", { wiki: NAME, change: "c", justification: "j" });

describe("buildOutput", () => {
  it("blocks with the fixed reason after a search of the wiki", () => {
    expect(buildOutput(false, [TEXT, SEARCH].join("\n"), NAME)).toEqual({
      decision: "block",
      reason: blockReason(NAME),
    });
    expect(blockReason(NAME)).not.toBe("");
    expect(blockReason(NAME)).toContain(NAME);
  });

  it("lets the agent stop when it did not search", () => {
    expect(buildOutput(false, TEXT, NAME)).toBeNull();
  });

  it("lets the agent stop when it searched another wiki", () => {
    expect(buildOutput(false, call("mcp__wikifact__search", { wiki: "other" }), NAME)).toBeNull();
  });

  it("does not count a search whose input is not an object with a wiki", () => {
    expect(buildOutput(false, call("mcp__wikifact__search", { wiki: 5 }), NAME)).toBeNull();
  });

  it("lets the agent stop when it sent a requestChange", () => {
    expect(buildOutput(false, [SEARCH, CHANGE].join("\n"), NAME)).toBeNull();
    expect(buildOutput(false, [CHANGE, SEARCH].join("\n"), NAME)).toBeNull();
  });

  it("lets the agent stop when stop_hook_active is true", () => {
    expect(buildOutput(true, SEARCH, NAME)).toBeNull();
  });

  it("skips lines that are not JSON or hold no tool call", () => {
    expect(buildOutput(false, ["not json", "{}", SEARCH].join("\n"), NAME)).not.toBeNull();
    expect(buildOutput(false, "not json", NAME)).toBeNull();
  });

  it("ignores a tool call in an entry that is not an assistant entry", () => {
    const user = JSON.stringify({
      type: TranscriptEntryType.User,
      message: {
        content: [
          { type: ContentItemType.ToolUse, id: "t", name: "mcp__wikifact__search", input: { wiki: NAME, query: "q" } },
        ],
      },
    });
    expect(buildOutput(false, user, NAME)).toBeNull();
  });

  it("looks at the whole transcript", () => {
    expect(buildOutput(false, [SEARCH, TEXT, TEXT].join("\n"), NAME)).not.toBeNull();
  });
});

describe("buildHandbackOutput", () => {
  const denial = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: denyReason(NAME),
    },
  };
  const handback = call("SubagentHandback", {});

  it("denies the first call after a search, with a reason that asks for the report again", () => {
    expect(buildHandbackOutput(SEARCH, NAME)).toEqual(denial);
    expect(denyReason(NAME)).not.toBe("");
    expect(denyReason(NAME)).toContain(NAME);
    expect(denyReason(NAME)).not.toBe(blockReason(NAME));
  });

  it("denies when the transcript already holds the call that the hook checks", () => {
    const current = call("SubagentHandback", {}, "cur");
    expect(buildHandbackOutput([SEARCH, current].join("\n"), NAME, "cur")).toEqual(denial);
  });

  it("denies when the current call is absent from the transcript", () => {
    expect(buildHandbackOutput(SEARCH, NAME, "cur")).toEqual(denial);
  });

  it("allows when an earlier call has another id", () => {
    const earlier = call("SubagentHandback", {}, "old");
    const current = call("SubagentHandback", {}, "cur");
    expect(buildHandbackOutput([SEARCH, earlier].join("\n"), NAME, "cur")).toBeNull();
    expect(buildHandbackOutput([SEARCH, earlier, current].join("\n"), NAME, "cur")).toBeNull();
  });

  it("allows a call after an earlier handback call, whatever the denial looks like", () => {
    expect(buildHandbackOutput([SEARCH, handback].join("\n"), NAME)).toBeNull();
    expect(buildHandbackOutput([SEARCH, handback, TEXT, handback].join("\n"), NAME)).toBeNull();
  });

  it("allows when a requestChange exists", () => {
    expect(buildHandbackOutput([SEARCH, CHANGE].join("\n"), NAME)).toBeNull();
  });

  it("allows when the agent did not search", () => {
    expect(buildHandbackOutput(TEXT, NAME)).toBeNull();
  });

  it("allows when the agent searched another wiki", () => {
    expect(buildHandbackOutput(call("mcp__wikifact__search", { wiki: "other" }), NAME)).toBeNull();
  });
});

describe("parseHandbackInput", () => {
  it("derives the subagent transcript path", () => {
    const input = { hook_event_name: "PreToolUse", agent_id: "a1", session_id: "s1", transcript_path: "/p/s1.jsonl" };
    expect(parseHandbackInput(input)).toEqual({
      isSubagent: true,
      transcriptPath: join("/p", "s1", "subagents", "agent-a1.jsonl"),
      toolUseId: undefined,
    });
  });

  it("takes the tool_use_id", () => {
    const input = { agent_id: "a1", session_id: "s1", transcript_path: "/p/s1.jsonl", tool_use_id: "toolu_1" };
    expect(parseHandbackInput(input).toolUseId).toBe("toolu_1");
  });

  it("passes a call outside a subagent", () => {
    expect(parseHandbackInput({ hook_event_name: "PreToolUse" }).isSubagent).toBe(false);
  });

  it("throws when the path fields are missing", () => {
    expect(() => parseHandbackInput({ agent_id: "a1" })).toThrow();
  });
});

describe("run on PreToolUse", () => {
  const stdin = JSON.stringify({
    hook_event_name: "PreToolUse",
    agent_id: "a1",
    session_id: "s1",
    transcript_path: "/p/s1.jsonl",
  });

  it("denies a subagent call after a search", () => {
    const read = vi.fn(() => SEARCH);
    expect(run(stdin, read, () => NAME, vi.fn())).toHaveProperty("hookSpecificOutput.permissionDecision", "deny");
    expect(read).toHaveBeenCalledWith(expect.stringContaining("agent-a1.jsonl"));
  });

  it("allows a call outside a subagent", () => {
    const raw = JSON.stringify({ hook_event_name: "PreToolUse" });
    expect(
      run(
        raw,
        () => SEARCH,
        () => NAME,
        vi.fn(),
      ),
    ).toBeNull();
  });

  it("allows and logs on a fault", () => {
    const log = vi.fn();
    const missing = (): string => {
      throw new Error("ENOENT");
    };
    expect(run(stdin, missing, () => NAME, log)).toBeNull();
    expect(log).toHaveBeenCalledOnce();
  });
});

describe("parseStopInput", () => {
  it("takes the agent transcript path and the flag", () => {
    const input = { stop_hook_active: true, transcript_path: "s.jsonl", agent_transcript_path: "a.jsonl" };
    expect(parseStopInput(input)).toEqual({ stopHookActive: true, transcriptPath: "a.jsonl" });
  });

  it("defaults the flag to false", () => {
    expect(parseStopInput({ agent_transcript_path: "a.jsonl" })).toEqual({
      stopHookActive: false,
      transcriptPath: "a.jsonl",
    });
  });

  it.each([null, {}, { transcript_path: "s" }, { agent_transcript_path: 5 }])("throws on a fault: %j", (input) => {
    expect(() => parseStopInput(input)).toThrow();
  });
});

describe("run", () => {
  const stdin = JSON.stringify({ agent_transcript_path: "a.jsonl" });

  it("returns the block output for a transcript with a search", () => {
    const log = vi.fn();
    expect(
      run(
        stdin,
        () => SEARCH,
        () => NAME,
        log,
      ),
    ).toEqual({ decision: "block", reason: blockReason(NAME) });
    expect(log).not.toHaveBeenCalled();
  });

  it("returns null when the project has no wiki", () => {
    const read = vi.fn(() => SEARCH);
    expect(run(stdin, read, () => null, vi.fn())).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it("returns null and logs when the transcript file is missing", () => {
    const log = vi.fn();
    const missing = (): string => {
      throw new Error("ENOENT");
    };
    expect(run(stdin, missing, () => NAME, log)).toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("ENOENT"));
  });

  it("returns null and logs on bad JSON on stdin", () => {
    const log = vi.fn();
    expect(
      run(
        "not json",
        () => SEARCH,
        () => NAME,
        log,
      ),
    ).toBeNull();
    expect(log).toHaveBeenCalledOnce();
  });
});
