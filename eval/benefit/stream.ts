// Reads the `--output-format stream-json` output of `claude -p` (technical/evaluation.md, "One agent run").
import { z } from "zod";

/** The token counts of one run, as the run record reports them. */
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** One tool use of a run: the tool name and, for a `search`, the query. */
interface ToolCall {
  tool: string;
  query?: string;
}

/** What the harness reads from the stream of one agent run. */
export interface StreamResult {
  /** The text of the final `result` event; empty when the run ended with no result. */
  answer: string;
  costUsd: number;
  turns: number;
  usage: TokenUsage;
  toolCalls: ToolCall[];
  /** The reason a run is not a normal end: the error text of the result, or a note that the stream had no result. */
  error?: string;
}

const usageSchema = z.object({
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  cache_read_input_tokens: z.number().optional(),
  cache_creation_input_tokens: z.number().optional(),
});

const resultEvent = z.object({
  type: z.literal("result"),
  subtype: z.string().optional(),
  is_error: z.boolean().optional(),
  result: z.unknown().optional(),
  total_cost_usd: z.number().optional(),
  num_turns: z.number().optional(),
  usage: usageSchema.optional(),
});

const toolUse = z.object({
  type: z.literal("tool_use"),
  id: z.string().optional(),
  name: z.string(),
  input: z.unknown().optional(),
});

const assistantEvent = z.object({
  type: z.literal("assistant"),
  message: z.object({ content: z.array(z.unknown()).optional() }),
});

/** The name of the search tool of a wiki, with or without the `mcp__<server>__` prefix of Claude Code. */
const SEARCH_TOOL = /(^|__)search$/;

function queryOf(name: string, input: unknown): string | undefined {
  if (!SEARCH_TOOL.test(name)) return undefined;
  const q = z.object({ query: z.string() }).safeParse(input);
  return q.success ? q.data.query : undefined;
}

/**
 * Reads the lines of a stream: the final `result` event (answer, dollars, turns, token usage) and the tool uses of the
 * assistant messages. The stream repeats a message once per content block, so a tool use is counted once by its id.
 *
 * @param text - the whole output of the process, one JSON event per line; a line that is not JSON is ignored
 * @returns the result; `error` is set when the stream has no result event or the result is an error
 * @sideEffects none
 */
export function parseStream(text: string): StreamResult {
  const toolCalls: ToolCall[] = [];
  const seen = new Set<string>();
  let result: z.infer<typeof resultEvent> | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      continue;
    }
    const res = resultEvent.safeParse(json);
    if (res.success) {
      result = res.data;
      continue;
    }
    const asst = assistantEvent.safeParse(json);
    if (!asst.success) continue;
    for (const block of asst.data.message.content ?? []) {
      const use = toolUse.safeParse(block);
      if (!use.success) continue;
      if (use.data.id !== undefined) {
        if (seen.has(use.data.id)) continue;
        seen.add(use.data.id);
      }
      const query = queryOf(use.data.name, use.data.input);
      toolCalls.push(query === undefined ? { tool: use.data.name } : { tool: use.data.name, query });
    }
  }
  if (!result) {
    return { answer: "", costUsd: 0, turns: 0, usage: zeroUsage(), toolCalls, error: "the stream has no result event" };
  }
  const u = result.usage;
  const answer = typeof result.result === "string" ? result.result : "";
  const failed = result.is_error === true || (result.subtype !== undefined && result.subtype !== "success");
  return {
    answer,
    costUsd: result.total_cost_usd ?? 0,
    turns: result.num_turns ?? 0,
    usage: {
      input: u?.input_tokens ?? 0,
      output: u?.output_tokens ?? 0,
      cacheRead: u?.cache_read_input_tokens ?? 0,
      cacheWrite: u?.cache_creation_input_tokens ?? 0,
    },
    toolCalls,
    ...(failed ? { error: answer !== "" ? answer : (result.subtype ?? "the run ended with an error") } : {}),
  };
}

/**
 * A usage of zero tokens.
 *
 * @returns a new usage object with every count 0
 * @sideEffects none
 */
export function zeroUsage(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}
