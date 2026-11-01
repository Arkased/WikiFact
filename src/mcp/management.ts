// technical/wikis.md, "Management tools of the service": the endpoint `/mcp` of the service: the 4 management tools and the 4 wiki tools with a `wiki` argument.
// A wiki endpoint has the 4 wiki tools without the argument and none of the management tools.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CallFailureKind, McpToolName, Quality } from "../domain/enums.js";
import type { Logger } from "../log/index.js";
import { packageVersion } from "../paths.js";
import type { WikiRegistry } from "../service/registry.js";
import { managementInstructions } from "./instructions.js";
import type { SessionHandle } from "./sessions.js";
import { ToolError, registerWikiTools, runTool, type DepsResolver } from "./tools.js";

// Read once at load, so the server reports the installed version.
const VERSION = packageVersion();

const createWikiOutput = z.object({ name: z.string(), url: z.string(), created: z.boolean() });
const archiveWikiOutput = z.object({
  name: z.string(),
  removed: z.literal(true).optional(),
  archivedTo: z.string().optional(),
});
const unarchiveWikiOutput = z.object({
  name: z.string(),
  url: z.string(),
  restoredFrom: z.string(),
  note: z.string().optional(),
});
const listWikisOutput = z.object({
  wikis: z.array(
    z.object({
      name: z.string(),
      subject: z.string(),
      description: z.string().optional(),
      url: z.string(),
      liveFacts: z.number(),
      queued: z.number(),
      worker: z.object({
        running: z.boolean(),
        lastCall: z
          .object({
            ok: z.boolean(),
            kind: z.enum(CallFailureKind).optional(),
            message: z.string().optional(),
            at: z.number(),
          })
          .optional(),
      }),
    }),
  ),
  archived: z.array(z.object({ name: z.string(), folder: z.string(), archivedAt: z.string() })),
});

/**
 * Registers `createWiki`, `archiveWiki`, `unarchiveWiki` and `listWikis` on an MCP server.
 *
 * @param server - the server to register on
 * @param registry - the wikis of the service
 * @param log - receives one `LogEvent.Tool` line per call
 * @param session - the session of the client; each call counts on it; absent in a test
 * @sideEffects registers handlers on `server`; a later `createWiki` call creates a folder, a database and possibly a
 *   worker child; `archiveWiki` stops a worker child and moves or removes a folder; `unarchiveWiki` moves a folder
 *   back and mounts it (see `WikiRegistry`); `listWikis` reads every store and the `.archive/` folder
 */
function registerManagementTools(
  server: McpServer,
  registry: WikiRegistry,
  log: Logger,
  session?: SessionHandle,
): void {
  server.registerTool(
    McpToolName.CreateWiki,
    {
      title: "Create a wiki",
      description:
        "Create a new, empty wiki and return the MCP URL to connect to it. " +
        "The name is 1 to 40 lower-case letters, digits and hyphens. " +
        "The same name with the same subject returns the existing wiki (created: false). " +
        "A name that only differs from an existing wiki by case, hyphens or a final s is refused.",
      inputSchema: {
        name: z.string().describe("1 to 40 lower-case letters, digits and hyphens."),
        subject: z.string().describe("One sentence that says what the wiki covers. Every question gets it."),
        quality: z.enum(Quality).optional().describe("The preset of model settings. Default: standard."),
      },
      outputSchema: createWikiOutput.shape,
      annotations: { title: "Create a wiki", idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    ({ name, subject, quality }) =>
      runTool({ log, session }, McpToolName.CreateWiki, { name }, () => registry.addWiki(name, subject, quality)),
  );
  server.registerTool(
    McpToolName.ArchiveWiki,
    {
      title: "Archive a wiki",
      description:
        "Stop serving a wiki. An empty wiki (0 live facts, 0 queued requests) is removed. " +
        "Any other wiki is moved to .archive/ and a human or unarchiveWiki can restore it.",
      inputSchema: { name: z.string().describe("The name of the wiki.") },
      outputSchema: archiveWikiOutput.shape,
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    ({ name }) => runTool({ log, session }, McpToolName.ArchiveWiki, { name }, () => registry.archiveWiki(name)),
  );
  server.registerTool(
    McpToolName.UnarchiveWiki,
    {
      title: "Restore an archived wiki",
      description:
        "Move an archived wiki back, mount it and return its MCP URL. " +
        "Give the wiki name (the newest archive is restored) or the full archive folder name from listWikis.",
      inputSchema: { name: z.string().describe("A wiki name, or an archive folder name `<name>-<stamp>`.") },
      outputSchema: unarchiveWikiOutput.shape,
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    ({ name }) => runTool({ log, session }, McpToolName.UnarchiveWiki, { name }, () => registry.unarchiveWiki(name)),
  );
  server.registerTool(
    McpToolName.ListWikis,
    {
      title: "List the wikis",
      description:
        "List every wiki of this service with its subject, its description (when it has one), its MCP URL, its live facts, its queue and its worker " +
        "(whether it runs, and how its last model call went), and the archived wikis that unarchiveWiki can restore. " +
        "The `name` of a wiki is the `wiki` argument of search, getFact, requestChange and getRequest.",
      inputSchema: {},
      outputSchema: listWikisOutput.shape,
      annotations: { readOnlyHint: true },
    },
    () =>
      runTool({ log, session }, McpToolName.ListWikis, {}, () => ({
        wikis: registry.listWikis(),
        archived: registry.listArchived(),
      })),
  );
}

/**
 * Makes the resolver of the management endpoint: the `wiki` argument names a mounted wiki.
 *
 * @param registry - the wikis of the service
 * @param log - the logger that each wiki's tool calls use
 * @returns a resolver that gives the deps of the named wiki and throws a `ToolError` for an unknown name
 * @sideEffects none
 */
function registryResolver(registry: WikiRegistry, log: Logger): DepsResolver {
  return (wiki) => {
    const entry = wiki === undefined ? undefined : registry.get(wiki);
    if (!entry) throw new ToolError(`no wiki named "${wiki ?? ""}"; listWikis names the wikis of this service`);
    return { ...entry.deps, log };
  };
}

/**
 * Writes the instructions text of the management endpoint for the wikis mounted now. `createManagementServer` sends it as the MCP instructions.
 *
 * @param registry - the wikis of the service
 * @returns the text of `managementInstructions` over the mounted entries; reads memory only, never a store
 * @sideEffects none
 */
export function registryInstructions(registry: WikiRegistry): string {
  return managementInstructions(registry.entries().map((e) => ({ name: e.name, subject: e.config.subject })));
}

/**
 * Builds the MCP server of the management endpoint. One per session, so the instructions (technical/lookup.md, "Server instructions") list the wikis mounted at connect time.
 *
 * @param registry - the wikis of the service
 * @param log - receives one `LogEvent.Tool` line per call
 * @param session - the session of the client; each call counts on it, and no `sessions` row is written; absent in a test
 * @returns the server with the 4 management tools and the 4 wiki tools (each with the `wiki` argument), not yet
 *   connected to a transport
 * @sideEffects as `registerManagementTools` and `registerWikiTools`
 */
export function createManagementServer(registry: WikiRegistry, log: Logger, session?: SessionHandle): McpServer {
  const server = new McpServer(
    { name: "wikifact-management", version: VERSION },
    // technical/lookup.md, "Server instructions". This runs on every `initialize` request: read the mounted entries in memory, never
    // `listWikis`, which opens every store to count its facts.
    { instructions: registryInstructions(registry) },
  );
  registerManagementTools(server, registry, log, session);
  registerWikiTools(server, {
    resolve: registryResolver(registry, log),
    log,
    withWikiArg: true,
    session,
  });
  return server;
}
