import { describe, expect, it } from "vitest";
import { parseStream } from "../stream.js";

const line = (o: unknown): string => JSON.stringify(o);

const toolUse = (id: string, name: string, input: unknown) => ({
  type: "assistant",
  message: { content: [{ type: "tool_use", id, name, input }] },
});

const result = (over: Record<string, unknown> = {}) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "The answer.",
  total_cost_usd: 0.12,
  num_turns: 4,
  usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 40 },
  ...over,
});

describe("parseStream", () => {
  it("reads the answer, the dollars, the turns, the usage and the tool uses", () => {
    const text = [
      line({ type: "system", subtype: "init" }),
      line(toolUse("a", "mcp__wikifact__search", { query: "lock takeover" })),
      line(toolUse("b", "Read", { file_path: "src/a.ts" })),
      line(result()),
    ].join("\n");
    expect(parseStream(text)).toEqual({
      answer: "The answer.",
      costUsd: 0.12,
      turns: 4,
      usage: { input: 10, output: 20, cacheRead: 300, cacheWrite: 40 },
      toolCalls: [{ tool: "mcp__wikifact__search", query: "lock takeover" }, { tool: "Read" }],
    });
  });

  it("counts a tool use once when the stream repeats its message", () => {
    const text = [line(toolUse("a", "Grep", {})), line(toolUse("a", "Grep", {})), line(result())].join("\n");
    expect(parseStream(text).toolCalls).toEqual([{ tool: "Grep" }]);
  });

  it("reports an error result", () => {
    const text = line(result({ is_error: true, result: "You hit your limit" }));
    expect(parseStream(text).error).toBe("You hit your limit");
  });

  it("reports a stream with no result, and ignores lines that are not JSON", () => {
    const parsed = parseStream(["not json", line(toolUse("a", "Read", {}))].join("\n"));
    expect(parsed.error).toBeDefined();
    expect(parsed.toolCalls).toEqual([{ tool: "Read" }]);
  });

  it("reports a run that ended on the turn limit", () => {
    const parsed = parseStream(line(result({ subtype: "error_max_turns", result: undefined })));
    expect(parsed.error).toBeDefined();
  });
});
