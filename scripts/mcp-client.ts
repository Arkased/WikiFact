// `npm run demo:mcp [-- db]`: starts `node dist/src/cli.js serve --db <db>` over stdio and calls the tools.
// It shows how a script (such as the correction test) drives the server. Run `npm run build` first.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, type StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { McpToolName, SearchHitKind } from "../src/domain/index.js";
import { DEFAULT_DB_PATH } from "../src/paths.js";
import { isMain } from "../eval/lib/main.js";
import { JSON_INDENT } from "../src/constants.js";

/** The part of the search tool output that the script reads: the kind and id of each hit. */
const searchOutput = z.object({
  searchId: z.string(),
  results: z.array(z.object({ kind: z.enum(SearchHitKind), id: z.string(), ref: z.string() })),
});

/** How `runClient` starts the server and what it does with the output. */
export interface ClientRun {
  /** The server command, such as `node`. */
  command: string;
  /** The arguments of the command: the entry file, `serve` and `--db <path>`. */
  args: string[];
  /** The working directory of the server; default: the current one. */
  cwd?: string;
  /** Receives the result of each tool call; default: prints it. */
  show?: (label: string, result: Record<string, unknown>) => void;
  /** What happens to the stderr of the server; default: shown. */
  stderr?: StdioServerParameters["stderr"];
}

/** What `runClient` reports. */
export interface ClientReport {
  /** The names of the tools that the server lists. */
  tools: string[];
  /** How many tool calls the run made. */
  calls: number;
}

const print = (label: string, r: Record<string, unknown>): void =>
  console.log(`\n== ${label}\n${JSON.stringify(r.structuredContent ?? r, null, JSON_INDENT)}`);

/**
 * Connects to a server over stdio, lists its tools and calls the search, the reads, a change request and a read of an
 * unknown id.
 *
 * @param run - the server command and the output
 * @returns the tool names and the number of calls made
 * @throws {Error} when the server does not start or a result does not have the expected shape
 * @sideEffects starts the server as a child process and ends it on return; calls the tools, so the wiki gets a change request
 */
export async function runClient(run: ClientRun): Promise<ClientReport> {
  const show = run.show ?? print;
  const transport = new StdioClientTransport({
    command: run.command,
    args: run.args,
    stderr: run.stderr ?? "inherit",
    ...(run.cwd === undefined ? {} : { cwd: run.cwd }),
  });
  const client = new Client({ name: "manual-test", version: "0" });
  await client.connect(transport);
  let calls = 0;
  const call = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    calls += 1;
    return await client.callTool({ name, arguments: args });
  };
  try {
    const tools = (await client.listTools()).tools.map((t) => t.name);
    console.log("tools:", tools.join(", "));
    const s = await call(McpToolName.Search, { query: "how much damage does a creeper do" });
    show(McpToolName.Search, s);
    const { searchId, results } = searchOutput.parse(s.structuredContent);
    const fact = results.find((r) => r.kind === SearchHitKind.Fact);
    if (fact) show(McpToolName.GetFact, await call(McpToolName.GetFact, { ref: fact.ref }));
    show(
      McpToolName.RequestChange,
      await call(McpToolName.RequestChange, {
        change: "A creeper explosion does 12 damage.",
        justification: "I lost 12 health to one.",
        searchId,
      }),
    );
    show(`${McpToolName.GetFact} unknown id`, await call(McpToolName.GetFact, { id: "nope" }));
    return { tools, calls };
  } finally {
    await client.close();
  }
}

async function main(): Promise<void> {
  const db = process.argv[2] ?? DEFAULT_DB_PATH;
  await runClient({ command: "node", args: ["dist/src/cli.js", "serve", "--db", db] });
}

if (isMain(import.meta.url)) {
  main().catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  });
}
