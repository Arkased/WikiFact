// technical/lookup.md, "MCP tool contracts": the 4 consumer tools. technical/storage.md, "Storage": a read connection per request, one write connection per server process.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../config/index.js";
import { ChangeOutcome, LogEvent, LogLevel, McpToolName, RequestStatus, SearchHitKind } from "../domain/enums.js";
import { EMBED_WINDOW, countTokens } from "../embed/index.js";
import type { Logger } from "../log/index.js";
import { errorMessage } from "../must.js";
import {
  closeStore,
  enqueueRequest,
  getChangeForRequest,
  getFact,
  getRequest,
  getSearchQuery,
  isFactId,
  openStoreFor,
  queuePosition,
  queueStats,
  readQueuePause,
  readWorkerStatus,
  recordRetrieval,
  recordToolCall,
  resolveRef,
  searchAndLog,
  type Store,
} from "../store/index.js";
import { FolderLockedError, WikiError } from "../service/errors.js";
import { MS_PER_SECOND } from "../time.js";
import { CORRECTION_DUTY, EMPTY_NOTE, RESULT_NOTE, SEARCH_TRIGGER } from "./instructions.js";
import type { SessionHandle } from "./sessions.js";
import { workerWarning } from "./warning.js";

export { CORRECTION_DUTY };

/**
 * technical/lookup.md, "MCP tool contracts": the tool metadata that makes Claude Code load a tool at session start
 * instead of deferring it to its name. `search`, `getFact` and `requestChange` carry it.
 */
const ALWAYS_LOAD_META = { "anthropic/alwaysLoad": true } as const;

/** What the tools need to run. */
export interface ToolDeps {
  dbPath: string;
  config: Config;
  /** The server's one write connection: queue rows and retrieval rows only. */
  writeStore: Store;
  /** One typed line per tool call. */
  log: Logger;
  /** Resolves when the embedder is warm; `search` awaits it, so a call during the warm-up waits instead of failing. */
  ready?: () => Promise<unknown>;
  /** The MCP session of the calls; absent in tests with no transport. */
  session?: SessionHandle;
}

/**
 * Finds the store and the deps for one tool call. The management endpoint looks the wiki up by name; a wiki endpoint
 * ignores the name and returns its own deps.
 *
 * @param wiki - the `wiki` argument of the call; `undefined` on a wiki endpoint
 * @returns the deps of the wiki that the call is about
 * @throws {ToolError} when the name is not a mounted wiki
 */
export type DepsResolver = (wiki: string | undefined) => ToolDeps;

/** The options of `registerWikiTools`. */
export interface WikiToolsOptions {
  /** Finds the deps of the wiki that each call is about. */
  resolve: DepsResolver;
  /** One typed line per tool call. */
  log: Logger;
  /** True on the management endpoint: every tool gets the required argument `wiki`. */
  withWikiArg: boolean;
  /** The session of the calls; absent in tests with no transport. */
  session?: SessionHandle;
}

/** What `runTool` needs besides the call: the logger, the store and the session of a wiki endpoint. */
export interface ToolRun {
  /** One typed line per tool call. */
  log: Logger;
  /** The write connection of the wiki that the call is about: receives the `tool_calls` row of each call. Absent: no row. */
  store?: Store;
  /** Counts the call on the session. */
  session?: SessionHandle;
}

// The `tool_calls` row of a call. The counters are not worth a failed call, so a failed write is dropped.
function storeCall(run: ToolRun, tool: McpToolName, ok: boolean, durationMs: number): void {
  if (run.store === undefined) return;
  try {
    recordToolCall(run.store, { at: Date.now(), tool, ok, durationMs });
  } catch {
    // dropped: the store is closed or locked
  }
}

/** A rejection that the calling model reads: it becomes a tool error result with the message as its text. */
export class ToolError extends Error {}

// A rejection is an error that a tool throws on purpose with a message for the agent: a `ToolError`, or a `WikiError`
// of the registry (a bad wiki name, a twin, the cap, an unknown wiki or archive). A folder that stays locked is a
// `WikiError` too, but it is a fault of the service and a failed call.
function isRejection(e: unknown): boolean {
  return e instanceof ToolError || (e instanceof WikiError && !(e instanceof FolderLockedError));
}

/** The result of one tool call: text, the structured output, and `isError` for a tool error. */
export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

const factVersionSchema = z.object({
  seq: z.number(),
  header: z.string(),
  content: z.string(),
  justification: z.string(),
  references: z.array(z.string()),
  changeReasoning: z.string(),
  isDeleted: z.boolean(),
  created: z.number(),
});

const searchOutput = z.object({
  searchId: z.string().optional(),
  results: z.array(
    z.object({
      kind: z.literal(SearchHitKind.Fact),
      id: z.string(),
      ref: z.string().optional(),
      header: z.string(),
      confidence: z.number(),
      score: z.number(),
    }),
  ),
  note: z.string(),
});
const getFactOutput = z.object({
  note: z.string(),
  id: z.string(),
  isDeleted: z.boolean(),
  confidence: z.number(),
  current: factVersionSchema,
});
const requestChangeOutput = z.object({
  requestId: z.string(),
  status: z.literal(RequestStatus.Queued),
  position: z.number(),
  estimatedSeconds: z.number().optional(),
  warning: z.string().optional(),
});
const getRequestOutput = z.object({
  requestId: z.string(),
  status: z.enum(RequestStatus),
  outcome: z.enum(ChangeOutcome).optional(),
  duplicateOf: z.string().optional(),
  factIds: z.array(z.string()).optional(),
  childIds: z.array(z.string()).optional(),
  error: z.string().optional(),
  attempts: z.number(),
  finishedAt: z.number().optional(),
});

/** Said by the description of every tool of the management endpoint. */
const WIKI_ARG_NOTE = " `wiki` is the name of a wiki from `listWikis`.";

/**
 * Runs a tool handler, logs one `LogEvent.Tool` line, and turns a thrown error into a tool error result.
 *
 * @param run - the logger, the store and the session to count the call on
 * @param tool - the tool name
 * @param args - the fields of the call that go into the log line; never a secret
 * @param fn - the handler
 * @returns the output as text and structured content, or a tool error whose text is the error message. The call is
 *   stored `ok: true` for the output and for a rejection (`ToolError`, `WikiError`), `ok: false` for any other error, `FolderLockedError` included
 * @sideEffects logs one line; reads the clock; counts the call on the session (one update on the store) and, with
 *   `run.store`, in 1 `tool_calls` row (a failed write is dropped, never fails the call); whatever
 *   `fn` does
 */
export async function runTool<T extends object>(
  run: ToolRun,
  tool: McpToolName,
  args: Record<string, unknown>,
  fn: () => Promise<T> | T,
): Promise<ToolResult> {
  const t0 = performance.now();
  run.session?.touch();
  const { log } = run;
  try {
    const out = await fn();
    storeCall(run, tool, true, performance.now() - t0);
    log({
      event: LogEvent.Tool,
      level: LogLevel.Info,
      tool,
      ...args,
      ok: true,
      durationMs: Math.round(performance.now() - t0),
    });
    return {
      content: [{ type: "text", text: JSON.stringify(out) }],
      structuredContent: Object.fromEntries(Object.entries(out)),
    };
  } catch (e) {
    const message = errorMessage(e);
    // A rejection with a reason is an answer; only an unexpected error is a failed call.
    const rejection = isRejection(e);
    storeCall(run, tool, rejection, performance.now() - t0);
    log({
      event: LogEvent.Tool,
      level: rejection ? LogLevel.Info : LogLevel.Error,
      tool,
      ...args,
      ok: rejection,
      error: message,
      durationMs: Math.round(performance.now() - t0),
    });
    return { content: [{ type: "text", text: message }], isError: true };
  }
}

// Each request gets its own read connection (technical/storage.md, "Storage").
async function withRead<T>(deps: ToolDeps, fn: (store: Store) => Promise<T> | T): Promise<T> {
  const store = openStoreFor(deps.config, deps.dbPath, { readonly: true });
  try {
    return await fn(store);
  } finally {
    closeStore(store);
  }
}

// The `wiki` input of the management endpoint. The type says optional because a wiki endpoint has no such input; the
// schema itself makes it required where it is present.
function wikiInput(o: WikiToolsOptions): { wiki: z.ZodOptional<z.ZodString> } {
  const input: object = o.withWikiArg ? { wiki: z.string().describe("The name of the wiki, from `listWikis`.") } : {};
  return input as { wiki: z.ZodOptional<z.ZodString> };
}

// The deps of the wiki that a call names, and the session row that the rows of the call link to. On the management
// endpoint the call counts on the row that the session opened in that wiki at connect (technical/deployment.md, "MCP
// sessions"); a wiki mounted after the session opened has no such row, so the call links to no session.
function resolveDeps(o: WikiToolsOptions, wiki: string | undefined): { deps: ToolDeps; sessionId: string | null } {
  const deps = o.resolve(wiki);
  const { session } = o;
  if (session === undefined) return { deps, sessionId: null };
  if (wiki === undefined || session.enterWiki === undefined) return { deps, sessionId: session.rowId };
  return { deps, sessionId: session.enterWiki(wiki, deps.writeStore) };
}

// The fact id of a `getFact` call: the target of its `ref`, or its `id`. Exactly one of the two is given.
function targetOf(store: Store, ref: string | undefined, id: string | undefined): string {
  if (ref !== undefined && id !== undefined) throw new ToolError("pass either `ref` or `id`, not both");
  if (ref !== undefined) {
    const found = resolveRef(store, ref);
    if (found?.kind !== SearchHitKind.Fact) throw new ToolError("no result has this ref; search again");
    return found.targetId;
  }
  if (id === undefined) throw new ToolError("pass a `ref` from a search result, or an `id`");
  return id;
}

// The fields of a call that go into its log line: the wiki name where there is one.
function logArgs(wiki: string | undefined, rest: Record<string, unknown>): Record<string, unknown> {
  return wiki === undefined ? rest : { wiki, ...rest };
}

// The `runTool` context of a wiki endpoint's call.
// On the management endpoint the store is that of the wiki that the call names (technical/deployment.md, "Endpoint
// counters"); a name that is no wiki has none.
const runOf = (o: WikiToolsOptions, wiki?: string): ToolRun => ({
  log: o.log,
  store: storeOf(o, wiki),
  session: o.session,
});

// The write connection of the wiki that a call names; none for a name that is no wiki.
function storeOf(o: WikiToolsOptions, wiki: string | undefined): Store | undefined {
  try {
    return o.resolve(wiki).writeStore;
  } catch {
    return undefined;
  }
}

function describeTool(o: WikiToolsOptions, text: string, tail = ""): string {
  return text + (o.withWikiArg ? WIKI_ARG_NOTE : "") + (tail === "" ? "" : ` ${tail}`);
}

function registerSearch(server: McpServer, o: WikiToolsOptions): void {
  server.registerTool(
    McpToolName.Search,
    {
      title: "Search the wiki",
      description: describeTool(
        o,
        SEARCH_TRIGGER +
          ' Search the wiki by free text. The query is a phrase of terms or a claim as a fact would read, not a question: "creeper explosion damage", "Q1 model in the standard preset". Returns facts (header and confidence), best first: the results are ordered by relevance, ' +
          "and the score of each result is the only relevance signal. " +
          "Call `getFact` for the content of a fact. " +
          "Open a result with `getFact` by its `ref`. When you send a change about this search, pass its `searchId`.",
        CORRECTION_DUTY,
      ),
      inputSchema: { ...wikiInput(o), query: z.string().describe("Free text. At most 512 tokens.") },
      outputSchema: searchOutput.shape,
      annotations: { readOnlyHint: true },
      _meta: ALWAYS_LOAD_META,
    },
    ({ wiki, query }) =>
      runTool(runOf(o, wiki), McpToolName.Search, logArgs(wiki, { queryChars: query.length }), async () => {
        const { deps, sessionId } = resolveDeps(o, wiki);
        await deps.ready?.();
        if (query.trim() === "") throw new ToolError("query must not be empty");
        const tokens = await countTokens(query);
        if (tokens > EMBED_WINDOW) {
          throw new ToolError(
            `query is ${tokens} tokens; the limit is ${EMBED_WINDOW} tokens (the input window of the embedding model). Shorten the query.`,
          );
        }
        // One function mints the ids and writes the log. When the log write fails, the results go out with no
        // searchId and no ref, so the consumer reads by id and nothing points at ids that do not exist.
        const out = await withRead(deps, (readStore) => searchAndLog(deps.writeStore, query, { readStore, sessionId }));
        if (out.logError !== undefined) {
          deps.log({
            event: LogEvent.RetrievalError,
            level: LogLevel.Error,
            tool: McpToolName.Search,
            id: "",
            error: errorMessage(out.logError),
          });
        }
        const note = out.results.length === 0 ? EMPTY_NOTE : RESULT_NOTE;
        return out.searchId === undefined
          ? { results: out.results, note }
          : { searchId: out.searchId, results: out.results, note };
      }),
  );
}

function registerGetFact(server: McpServer, o: WikiToolsOptions): void {
  server.registerTool(
    McpToolName.GetFact,
    {
      title: "Get a fact",
      description: describeTool(
        o,
        "Get the current version of a fact: header, content, justification, references and confidence. Pass the `ref` of a search result; pass `id` only for a fact id that you found inside a fact or a request.",
        CORRECTION_DUTY,
      ),
      inputSchema: {
        ...wikiInput(o),
        ref: z.string().optional().describe("The `ref` of a fact in a result of `search` (preferred)."),
        id: z
          .string()
          .optional()
          .describe("The id of a fact, when you have no `ref`; the read then links to no search."),
      },
      outputSchema: getFactOutput.shape,
      annotations: { readOnlyHint: true },
      _meta: ALWAYS_LOAD_META,
    },
    ({ wiki, ref, id: byId }) =>
      runTool(runOf(o, wiki), McpToolName.GetFact, logArgs(wiki, { ref, id: byId }), async () => {
        const { deps } = resolveDeps(o, wiki);
        const id = await withRead(deps, (store) => targetOf(store, ref, byId));
        const fact = await withRead(deps, (store) => getFact(store, id));
        if (!fact) throw new ToolError(`no fact with id "${id}"`);
        // A live fact records one `retrievals` row. A deleted fact records nothing.
        if (!fact.isDeleted) {
          try {
            recordRetrieval(deps.writeStore, id, { ref });
          } catch (e) {
            deps.log({
              event: LogEvent.RetrievalError,
              level: LogLevel.Error,
              tool: McpToolName.GetFact,
              id,
              error: String(e),
            });
          }
        }
        return { ...fact, note: RESULT_NOTE };
      }),
  );
}

function registerRequestChange(server: McpServer, o: WikiToolsOptions): void {
  server.registerTool(
    McpToolName.RequestChange,
    {
      title: "Request a change",
      description: describeTool(
        o,
        "Ask the wiki to add, correct or delete a fact. Describe what you observed in `change`, and say how you know in `justification`. " +
          "You do not write the fact and you do not need a target. The call returns at once and the wiki updates later; " +
          "`getRequest` shows whether it landed. " +
          "One claim per request is best. A change that holds 2 claims is split by the wiki into one request per claim, " +
          "and `getRequest` lists their ids as `childIds`; a claim that is still compound after the split is rejected. " +
          'Say what you saw, measured, ran or read in `justification`: a belief ("I think", "should be") is rejected. ' +
          "`getRequest` shows the reason of a rejection. " +
          "The answer carries the queue position and an estimate in seconds. " +
          "Name fact ids in `targets` when you know them; an id that is no fact is an error. " +
          "Pass the `searchId` of the search you ran, when it did not return the fact or listed the fact you correct.",
      ),
      inputSchema: {
        ...wikiInput(o),
        change: z.string().describe("What you saw, in free text. Not empty."),
        targets: z.array(z.string()).optional().describe("Fact ids the change is about."),
        justification: z.string().describe("How you know. Prose, no fact ids. Not empty."),
        searchId: z
          .string()
          .optional()
          .describe("The `searchId` that `search` returned for the search this change follows."),
      },
      outputSchema: requestChangeOutput.shape,
      annotations: { destructiveHint: false, idempotentHint: false },
      _meta: ALWAYS_LOAD_META,
    },
    ({ wiki, change, targets, justification, searchId }) =>
      runTool(
        runOf(o, wiki),
        McpToolName.RequestChange,
        logArgs(wiki, { targets: targets?.length ?? 0, hasSearchId: searchId !== undefined }),
        () => {
          const { deps, sessionId } = resolveDeps(o, wiki);
          if (change.trim() === "") throw new ToolError("change must not be empty");
          if (justification.trim() === "") throw new ToolError("justification must not be empty");
          for (const id of targets ?? []) {
            if (!isFactId(deps.writeStore, id)) throw new ToolError(`targets: no fact with id "${id}"`);
          }
          if (searchId !== undefined && getSearchQuery(deps.writeStore, searchId) === undefined) {
            throw new ToolError(`searchId: no search with id "${searchId}"; pass the searchId that search returned`);
          }
          const requestId = enqueueRequest(deps.writeStore, {
            change,
            targets,
            justification,
            searchId,
            sessionId: sessionId ?? undefined,
          });
          // The request is queued in every case; the warning tells the caller that nobody may process it soon.
          const warning = workerWarning(readWorkerStatus(deps.writeStore), Date.now(), readQueuePause(deps.writeStore));
          // The place counts the queued requests that run before this one under the queue order (no cleanup repair).
          const position = queuePosition(deps.writeStore, requestId);
          const { meanDurationMs } = queueStats(deps.writeStore);
          const estimatedSeconds =
            meanDurationMs === undefined ? undefined : Math.round((position * meanDurationMs) / MS_PER_SECOND);
          return {
            requestId,
            status: RequestStatus.Queued as const,
            position,
            ...(estimatedSeconds === undefined ? {} : { estimatedSeconds }),
            ...(warning === undefined ? {} : { warning }),
          };
        },
      ),
  );
}

function registerGetRequest(server: McpServer, o: WikiToolsOptions): void {
  server.registerTool(
    McpToolName.GetRequest,
    {
      title: "Get a request",
      description: describeTool(
        o,
        "Get the state of a request that `requestChange` queued: its status (queued, running, done or failed), " +
          "the outcome of the change once it is done (accepted, duplicate, rejected or split), " +
          "`duplicateOf` (the fact id of the duplicate match), `factIds` (the facts the change wrote, new or new versions), " +
          "`childIds` (for a split, the request ids of the claims it was split into; read each with `getRequest`), " +
          "`error` (the reason of a failed request, or of a rejection at the first check: compound or unsupported), " +
          "and the attempts so far.",
      ),
      inputSchema: {
        ...wikiInput(o),
        requestId: z.string().describe("The `requestId` that `requestChange` returned."),
      },
      outputSchema: getRequestOutput.shape,
      annotations: { readOnlyHint: true },
    },
    ({ wiki, requestId }) =>
      runTool(runOf(o, wiki), McpToolName.GetRequest, logArgs(wiki, { requestId }), async () => {
        const { deps } = resolveDeps(o, wiki);
        const found = await withRead(deps, (store) => {
          const row = getRequest(store, requestId);
          if (!row) return undefined;
          const change = row.status === RequestStatus.Done ? getChangeForRequest(store, requestId) : null;
          return { row, change };
        });
        if (!found) throw new ToolError(`no request with id "${requestId}"`);
        const { row, change } = found;
        return {
          requestId: row.id,
          status: row.status,
          ...(change === null ? {} : { outcome: change.outcome }),
          ...(change?.duplicateOf === undefined ? {} : { duplicateOf: change.duplicateOf }),
          ...(change === null || change.factIds.length === 0 ? {} : { factIds: change.factIds }),
          ...(change === null || change.childIds.length === 0 ? {} : { childIds: change.childIds }),
          ...(row.error === null ? {} : { error: row.error }),
          attempts: row.attempts,
          ...(row.finishedAt === null ? {} : { finishedAt: row.finishedAt }),
        };
      }),
  );
}

/**
 * Registers the 4 wiki tools on an MCP server, for one wiki or for every wiki of a service.
 *
 * @param server - the server to register on; the tools are `search`, `getFact`, `requestChange` and `getRequest`
 * @param opts - how to find the deps of each call, the logger, and whether the tools take the `wiki` argument
 * @sideEffects registers handlers on `server`. Each later tool call resolves its wiki, opens and closes a read
 *   connection, logs one `LogEvent.Tool` line, and `getFact` and `requestChange` write one retrieval row or one
 *   queue row
 */
export function registerWikiTools(server: McpServer, opts: WikiToolsOptions): void {
  registerSearch(server, opts);
  registerGetFact(server, opts);
  registerRequestChange(server, opts);
  registerGetRequest(server, opts);
}

/**
 * Registers the 4 tools of one wiki, without the `wiki` argument.
 *
 * @param server - the server to register on
 * @param deps - the database path (for the per-call read connections), the config, the one write connection and the
 *   logger
 * @sideEffects as `registerWikiTools`
 */
export function registerTools(server: McpServer, deps: ToolDeps): void {
  registerWikiTools(server, {
    resolve: () => deps,
    log: deps.log,
    withWikiArg: false,
    session: deps.session,
  });
}
