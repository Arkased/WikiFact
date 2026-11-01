// The Anthropic SDK consumer: a tool-use loop over the real MCP server on stdio.
import type Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { z } from "zod";
import { McpToolName } from "../../../src/domain/index.js";
import { serverSpawnCommand } from "../paths.js";
import { taskPrompt } from "../prompt.js";
import type { Consumer, ConsumerOut } from "./types.js";

/** The most model turns for one task. */
const SDK_MAX_TURNS = 16;
/** The `max_tokens` of each model call. */
const SDK_MAX_TOKENS = 2000;

/** The tools whose use counts as a wiki read, as strings to compare with the names the model gives. */
const READ_TOOLS: string[] = [McpToolName.GetFact, McpToolName.Search];
/** The correction tool, as a string. */
const REQUEST_TOOL: string = McpToolName.RequestChange;

/** The block of a model reply that asks for a tool call. */
type ToolUseBlock = Extract<Anthropic.ContentBlock, { type: "tool_use" }>;

/** The input of `callTools`. */
interface CallToolsInput {
  mcp: Client;
  uses: ToolUseBlock[];
  /** The names of the tools called so far; the function appends to it. */
  used: string[];
}

const toolArguments = z.record(z.string(), z.unknown());

async function callTools(params: CallToolsInput): Promise<Anthropic.ToolResultBlockParam[]> {
  const results: Anthropic.ToolResultBlockParam[] = [];
  for (const u of params.uses) {
    params.used.push(u.name);
    const args = toolArguments.safeParse(u.input);
    const r = await params.mcp.callTool({ name: u.name, arguments: args.success ? args.data : {} });
    results.push({
      type: "tool_result",
      tool_use_id: u.id,
      content: JSON.stringify(r.structuredContent ?? r.content),
      is_error: !!r.isError,
    });
  }
  return results;
}

/**
 * Builds the consumer that drives the Anthropic SDK with tool use against the real MCP server on stdio.
 * Needs `ANTHROPIC_API_KEY`. With the hook on, it nudges once after a read with no `requestChange`, as `stop-hook.mjs` does.
 *
 * @param model - the model id for every call
 * @returns a consumer for `runCorrections`; the server runs from `src/cli.ts` through tsx, so no build is needed
 * @sideEffects per task: starts the server as a child process, makes paid API calls, and the tools write to the seeded database
 */
export function sdkConsumer(model: string): Consumer {
  return async (task, ctx): Promise<ConsumerOut> => {
    const { default: AnthropicClient } = await import("@anthropic-ai/sdk");
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const transport = new StdioClientTransport({
      ...serverSpawnCommand(ctx.seeded.dbPath),
      stderr: "ignore",
    });
    const mcp = new Client({ name: "sdk-consumer", version: "0" });
    await mcp.connect(transport);
    try {
      const api = new AnthropicClient();
      const tools: Anthropic.Tool[] = (await mcp.listTools()).tools.map((t) => ({
        name: t.name,
        description: t.description ?? "",
        input_schema: t.inputSchema,
      }));
      const messages: Anthropic.MessageParam[] = [{ role: "user", content: taskPrompt(task) }];
      const used: string[] = [];
      let nudged = false;
      let text = "";
      for (let turn = 0; turn < SDK_MAX_TURNS; turn++) {
        const res = await api.messages.create({ model, max_tokens: SDK_MAX_TOKENS, tools, messages });
        messages.push({ role: "assistant", content: res.content });
        text = res.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n");
        const uses = res.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
        if (uses.length === 0) {
          const readSomething = used.some((n) => READ_TOOLS.includes(n));
          if (ctx.hook && !nudged && readSomething && !used.includes(REQUEST_TOOL)) {
            nudged = true;
            const { REASON } = await import("../stop-hook.mjs");
            messages.push({ role: "user", content: REASON });
            continue;
          }
          return { answer: text, toolCalls: used.length, turns: turn + 1 };
        }
        messages.push({ role: "user", content: await callTools({ mcp, uses, used }) });
      }
      return { answer: text, toolCalls: used.length, error: "turn limit" };
    } finally {
      await mcp.close();
    }
  };
}
