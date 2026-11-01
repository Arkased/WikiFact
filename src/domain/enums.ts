/**
 * Every enum of `src/`. A leaf module: it imports nothing, so no import cycle can form.
 * The string value of each member is the value that goes to the database, the log, the JSON
 * files and the model (docs/code-standard.md section 1).
 */

/** The kind of a queued change request. */
export enum RequestKind {
  /** A change submitted by a client. */
  Submission = "submission",
  /** A repair the worker queues after a lookup that missed a fact it should have found. */
  LookupRepair = "lookupRepair",
  /** An edit the operator console queues: a cleanup run or a reindex (technical/console.md, "The `operatorEdit` request"). */
  OperatorEdit = "operatorEdit",
  /** A repair the cleanup queues for one candidate of a finder (technical/cleanup.md, "Cleanup"). */
  CleanupRepair = "cleanupRepair",
}

/** How a run of a batch ended (technical/updates.md, "High volume mode", "Rules of the runner"). */
export enum BatchRunStatus {
  /** Every request of the batch ended and the reconciliation ran. */
  Done = "done",
  /** The queue pause or the stop signal came between 2 requests; the requests not started stay queued. */
  Stopped = "stopped",
  /** A model call hit a rate limit; the requests not finished are queued again and the worker pauses. */
  RateLimited = "rate_limited",
  /** The promotion failed (for example, the live wiki moved); the staging set is dropped and the requests are queued with an attempt counted. */
  Dropped = "dropped",
}

/** Why a batch stops between 2 steps. */
export enum BatchStopReason {
  /** The stop signal of the worker. */
  Signal = "signal",
  /** The operator paused the queue. */
  QueuePause = "queue_pause",
}

/** The state of a queued change request. */
export enum RequestStatus {
  /** Waiting for a worker, new or put back after a failed attempt. */
  Queued = "queued",
  /** Taken by the worker; set back to `Queued` on a restart. */
  Running = "running",
  Done = "done",
  /** Out of attempts (`MAX_ATTEMPTS`); only `requeue` puts it back. */
  Failed = "failed",
}

/**
 * The status one worker step reports: `Idle` when the queue is empty, else the status the
 * request was left in. Mirrors `RequestStatus.Done`, `RequestStatus.Queued` (retry) and
 * `RequestStatus.Failed`; the string values are the same.
 */
export enum RunOnceStatus {
  Idle = "idle",
  Done = "done",
  Queued = "queued",
  Failed = "failed",
  /** The model call hit a rate limit: the request is `queued` again with its attempt count unchanged, and the worker pauses. */
  RateLimited = "rate_limited",
}

/** What the worker is doing, as the worker status records it (technical/updates.md, "Queue and worker"). */
export enum WorkerState {
  Running = "running",
  /** Waiting out a pause; it polls nothing and takes no request until `pausedUntil`. */
  Paused = "paused",
}

/** Why the worker is paused, as the worker status records it; the string is the text the console shows. */
export enum PauseReason {
  RateLimit = "rate limit",
  /** The operator paused the queue (technical/updates.md, "Queue and worker"). */
  Operator = "operator",
}

/** How the store recorded a change. */
export enum ChangeOutcome {
  Accepted = "accepted",
  Duplicate = "duplicate",
  Rejected = "rejected",
  /** A compound submission that Q7 split into child submissions, one per claim (technical/submit.md, "Split of a compound submission"). */
  Split = "split",
}

/**
 * The outcome of processing one request. Mirrors `ChangeOutcome` (accepted, duplicate,
 * rejected, split) with the same string values, plus `Skipped` for a request that wrote no change.
 */
export enum ProcessOutcome {
  Accepted = "accepted",
  Duplicate = "duplicate",
  Rejected = "rejected",
  Split = "split",
  Skipped = "skipped",
}

/** Why a change was rejected. */
export enum RejectReason {
  /** The justification does not support the claim. */
  Unsupported = "unsupported",
  /** The justification contradicts the claim. */
  Contradicted = "contradicted",
  /** The submission holds more than one claim (Q7, step 1). */
  Compound = "compound",
}

/** What kind of support a justification gives its claim (Q7). */
export enum SupportKind {
  /** First-hand and repeatable: the submitter saw, measured, ran, or read the code or the document. */
  Observation = "observation",
  /** Second-hand: someone told the submitter, or a document says so and the submitter did not check. */
  Report = "report",
  /** Inference, opinion or assumption. */
  Belief = "belief",
}

/** How a fact was retrieved. */
export enum RetrievalKind {
  /** The reader fetched the fact. */
  Read = "read",
  /** The reader confirmed the fact was right. */
  Confirm = "confirm",
}

/** The kind of a search hit. */
export enum SearchHitKind {
  Fact = "fact",
}

/** What a row of `stg_vectors` is the embedding of (technical/storage.md, "Staging tables"). */
export enum StagedVectorKind {
  /** A fact version; `ref` is the version id. */
  Fact = "fact",
}

/** The id of a model question. */
export enum QuestionId {
  Q1 = "Q1",
  Q2 = "Q2",
  Q3 = "Q3",
  Q4 = "Q4",
  Q5 = "Q5",
  Q6 = "Q6",
  Q7 = "Q7",
  Q8 = "Q8",
  Q9 = "Q9",
  Q10 = "Q10",
}

/**
 * The id of the group call of the bulk test architecture C (technical/updates.md, "The candidate architectures of the bulk
 * test"). It is no member of `QuestionId`: it has no preset, no question set and no `Questions` method; it runs on the
 * settings of Q4.
 */
export enum GroupQuestionId {
  /** The one call that judges and drafts all the claims of one group. */
  Group = "QG",
}

/** What the steps of one request before the group call of the bulk test architecture C came to (`prepareMember`). */
export enum MemberPrepKind {
  /** Q7 split or rejected the request; its change is written. */
  Ended = "ended",
  /** The request stays in its group. */
  Member = "member",
  /** The scope holds 2 or more live facts; step 3 needs the pipeline of 1 request at a time. */
  Crowded = "crowded",
}

/**
 * Gives the name of the `Questions` method (and of the `SPECS` key) for a question.
 *
 * @param id - the question
 * @returns the lower-case form, for example `q10` for `Q10`
 * @sideEffects none
 */
export function questionMethod(id: QuestionId): string {
  return id.toLowerCase();
}

/** The kind of work a question asks of the model; it picks the settings in `models.json`. */
export enum QuestionKind {
  Classification = "classification",
  Judgment = "judgment",
  Drafting = "drafting",
}

/** The reasoning effort of a model call. */
export enum Effort {
  Low = "low",
  Medium = "medium",
  High = "high",
  Xhigh = "xhigh",
  Max = "max",
}

/** The model quality preset. */
export enum Quality {
  Budget = "budget",
  Standard = "standard",
  Premium = "premium",
}

/** Where the wiki runs. */
export enum Mode {
  /** A deployed server with its own worker. */
  Deployed = "deployed",
  /** A local process that starts its own worker child. */
  Local = "local",
}

/** The transport that carries a model call. */
export enum TransportName {
  /** The Anthropic SDK. */
  Sdk = "sdk",
  /** The `claude` command line. */
  Cli = "cli",
}

/** Who makes the model call; it picks the rules text of the CLI transport. */
export enum CallerKind {
  Eval = "eval",
  Worker = "worker",
}

/** The code of a failed model call. */
export enum QuestionErrorCode {
  Timeout = "timeout",
  Refusal = "refusal",
  /** The output did not parse or did not validate. */
  Invalid = "invalid",
  /** The output was cut off at the token limit. */
  Truncated = "truncated",
}

/** The stop reasons of a model response that the code compares. */
export enum StopReason {
  Refusal = "refusal",
  MaxTokens = "max_tokens",
  EndTurn = "end_turn",
  ToolUse = "tool_use",
}

/** The action Q4 proposes for a related fact it finds wrong. */
export enum WrongRelatedAction {
  /** The whole fact is shown wrong, so it is deleted. */
  Delete = "delete",
  /** Part of the fact is shown wrong, so Q6 rewrites it without that part. */
  Narrow = "narrow",
}

/** What a judgment targets: the claim itself or a related fact it deletes or narrows. */
export enum JudgmentTargetKind {
  /** The fact of the claim itself, new or the one it corrects. */
  Claim = "claim",
  /** The deleted fact that the claim restates too weakly to restore it: it gets a live version that negates it. */
  Negate = "negate",
  /** A fact that the claim shows wrong as a whole (the existing fact itself, for a deletion by negation). */
  Delete = "delete",
  /** A related fact that the claim shows partly wrong. */
  Narrow = "narrow",
}

/** How Q4 relates the claim to the existing fact in its scope. */
export enum Q4Relation {
  /** The claim repeats the content of the existing fact. */
  Same = "same",
  /** The claim gives another value for the same scope: a correction. */
  Different = "different",
  /** The existing fact is about another subject or attribute: Q1 over-matched a sibling scope (F24). */
  Unrelated = "unrelated",
  /** The existing fact is live, and the claim says it is no longer true with no new content: a deletion. */
  Negates = "negates",
  /** The existing fact is deleted, and the claim restates it with an observation weaker than the deletion's. */
  Stale = "stale",
}

/** Q2's verdict on which of two facts in one scope has the content that stands. */
export enum Q2Stands {
  /** The content of the kept fact stands. */
  Kept = "kept",
  /** The content of the other fact stands. */
  Other = "other",
  /** The 2 contents are about another subject or attribute, so both can be true: Q1 over-matched a sibling scope (F24). */
  Unrelated = "unrelated",
}

/** The state of the worker child process of local mode. */
export enum WorkerChildState {
  /** The child lived past the start window. */
  Running = "running",
  /** The child ended: after the start window in a log line, inside it as the `started` value. */
  Exited = "exited",
  /** The child never ran: it failed to spawn or exited inside the start window (log line only). */
  NotRunning = "not_running",
}

/** The name of an MCP tool. */
export enum McpToolName {
  Search = "search",
  GetFact = "getFact",
  RequestChange = "requestChange",
  /** Reads the state of a request that `requestChange` queued. */
  GetRequest = "getRequest",
  /** The management tool of service mode that adds a wiki. */
  CreateWiki = "createWiki",
  /** The management tool of service mode that lists the wikis. */
  ListWikis = "listWikis",
  /** The management tool of service mode that archives or removes a wiki. */
  ArchiveWiki = "archiveWiki",
  /** The management tool of service mode that restores an archived wiki. */
  UnarchiveWiki = "unarchiveWiki",
}

/** What `serve` serves: one database, or every wiki of a folder (service mode, technical/deployment.md, "Service mode"). */
export enum ServeTarget {
  Db = "db",
  Wikis = "wikis",
}

/** One timed step of the consumer search, as `profileSearch` reports it. The value is the key in the eval results. */
export enum SearchStep {
  Embed = "embed",
  FtsFacts = "ftsFacts",
  KnnFacts = "knnFacts",
  Total = "total",
}

/** The `event` field of a log line. */
export enum LogEvent {
  /** A change was committed by the update agent. */
  Change = "change",
  /** Step 1 dropped a target that is not a fact. */
  Gather = "gather",
  /** Step 2 dropped an id that Q1 returned and that was not a candidate. */
  Scope = "scope",
  /** Step 4 dropped a wrong-related entry of Q4 that was invalid. */
  Judge = "judge",
  /** Step 4: Q4 found the matched fact to be another scope, a sibling that Q1 over-matched (F24). */
  ScopeOvermatch = "scope_overmatch",
  /** Step 9 checked whether the prior query finds the fact. */
  PriorQuery = "priorQuery",
  /** A lookupRepair request was skipped. */
  LookupRepair = "lookupRepair",
  /** A cleanupRepair request wrote nothing: the candidate was stale, or the model found no change (technical/cleanup.md, "Cleanup"). */
  CleanupRepair = "cleanup_repair",
  /** A cleanup run queued its requests (technical/cleanup.md, "Cleanup"). */
  CleanupRun = "cleanup_run",
  /** One attempt at a request failed. */
  AttemptFailed = "attempt_failed",
  /** A model call hit a rate limit: the request went back to the queue with no attempt counted, and the worker pauses. */
  RateLimitPause = "rate_limit_pause",
  /** The worker saw the operator pause of the queue for the first time (technical/updates.md, "Queue and worker"). */
  QueuePause = "queue_pause",
  /** The worker saw the operator pause end (technical/updates.md, "Queue and worker"). */
  QueueResume = "queue_resume",
  /** A request of a batch was refused at its write because another request of the batch changed a fact it rests on; it runs again alone (technical/updates.md, "High volume mode"). */
  BatchStale = "batch_stale",
  /** A batch of the high volume mode ended: the requests by outcome and the reconciliation. */
  BatchDone = "batch_done",
  /** A staging set of a batch was dropped, unpromoted: the batch stopped, the live wiki moved, or a crash left it (technical/updates.md, "High volume mode"). */
  BatchDropped = "batch_dropped",
  /** The worker loop started. */
  WorkerStart = "worker_start",
  /** The worker loop stopped. */
  WorkerStop = "worker_stop",
  /** The first line of the `worker` command. */
  Worker = "worker",
  /** The state of the worker child of `serve --with-worker`. */
  WorkerChild = "worker_child",
  /** The service started a new worker child after one exited without a request to stop (technical/deployment.md, "Worker restart"). */
  WorkerRestart = "worker_restart",
  /** An MCP session opened (technical/deployment.md, "MCP sessions"). */
  SessionStart = "session_start",
  /** An MCP session ended (technical/deployment.md, "MCP sessions"). */
  SessionEnd = "session_end",
  /** The first line of the `serve` command. */
  Serve = "serve",
  /** The HTTP server is bound to its port. */
  Listening = "listening",
  /** Service mode mounted a wiki at its endpoint. */
  WikiMounted = "wiki_mounted",
  /** The `createWiki` tool added a wiki. */
  WikiCreated = "wiki_created",
  /** The `archiveWiki` tool moved a wiki to `.archive/` or removed an empty one. */
  WikiArchived = "wiki_archived",
  /** The `unarchiveWiki` tool moved an archived wiki back and mounted it. */
  WikiRestored = "wiki_restored",
  /** An HTTP request failed. */
  HttpError = "httpError",
  /** Recording a retrieval row failed; the tool call still succeeded. */
  RetrievalError = "retrievalError",
  /** One MCP tool call. */
  Tool = "tool",
  /** The CLI transport could not delete a temp folder of a call after its retries. */
  TempFolderNotDeleted = "temp_folder_not_deleted",
  /** Which transport the questions use, and the rule that chose it. */
  QuestionTransport = "question_transport",
  /**
   * The exact input, context and output of one question. A worker with a log directory writes it to its call log
   * only (technical/deployment.md, "Logging"); without one, `WIKIFACT_LOG_CALLS=1` writes it to stderr.
   */
  QuestionCall = "question_call",
  /** A process told where its log files are (the one stderr line of a process that logs to files). */
  LogDir = "log_dir",
  /** A command refused to start: a host rule, a missing key, a lock held by another worker. */
  Refused = "refused",
  /** An error that no command caught reached the top of the process. */
  Unhandled = "unhandled",
  /** The worker took over the lock file of a process that is gone. */
  LockTakeover = "lock_takeover",
  /** The worker ran a reindex job of the operator console; it writes no `changes` row (technical/console.md, "The `operatorEdit` request"). */
  OperatorReindex = "operator_reindex",
  /** One request to the operator console (technical/console.md, "Mount in the service"). */
  ConsolePage = "console_page",
  /** One operator action of the console that changed something (technical/console.md, "Operator actions"). */
  ConsoleAction = "console_action",
}

/** The severity of a log line (technical/deployment.md, "Logging"). */
export enum LogLevel {
  /** A failed request, a failed model call, a refused start, a worker child exit, an unhandled error. */
  Error = "error",
  /** A retry, a rate limit, a stale lock taken over, a prior query that still misses. */
  Warn = "warn",
  /** Everything else. */
  Info = "info",
}

/** Why a model call failed, as the worker status records it (technical/updates.md, "Queue and worker"). */
export enum CallFailureKind {
  /** HTTP 401, or the CLI says the login is missing or expired. */
  Credential = "credential",
  /** HTTP 429. */
  RateLimit = "rate_limit",
  /** Any other failure. */
  Other = "other",
}

/** The name of an environment variable that the code reads. */
export enum EnvVar {
  AnthropicApiKey = "ANTHROPIC_API_KEY",
  AnthropicAuthToken = "ANTHROPIC_AUTH_TOKEN",
  AnthropicConfigDir = "ANTHROPIC_CONFIG_DIR",
  WikifactTransport = "WIKIFACT_TRANSPORT",
  WikifactClaudeBin = "WIKIFACT_CLAUDE_BIN",
  WikifactPresets = "WIKIFACT_PRESETS",
  WikifactCliBare = "WIKIFACT_CLI_BARE",
  WikifactLogCalls = "WIKIFACT_LOG_CALLS",
  WikifactHookLog = "WIKIFACT_HOOK_LOG",
  ClaudeConfigDir = "CLAUDE_CONFIG_DIR",
  ClaudeForcePromptCaching5m = "FORCE_PROMPT_CACHING_5M",
}

/**
 * Lists the values of a string enum.
 *
 * @param e - the enum object
 * @returns the member values in declaration order
 * @sideEffects none
 */
export function enumValues<E extends Record<string, string>>(e: E): E[keyof E][] {
  return Object.values(e) as E[keyof E][];
}

/**
 * Marks the end of an exhaustive `switch` over an enum: the compiler rejects a call whose
 * argument is not `never`, so a missing case is a type error.
 *
 * @param x - the value that no case matched; the type `never` makes the compiler check the cases
 * @throws {Error} naming the value, when the value reaches it at run time
 * @sideEffects none
 */
export function assertNever(x: never): never {
  throw new Error(`unhandled value: ${String(x)}`);
}

/**
 * Tells whether a value is a member of a string enum.
 *
 * @param e - the enum object
 * @param v - the value to test, for example a string from JSON, the environment or argv
 * @returns true when `v` equals a member value; narrows `v` to the enum type
 * @sideEffects none
 */
export function isMember<E extends Record<string, string>>(e: E, v: unknown): v is E[keyof E] {
  return typeof v === "string" && Object.values(e).includes(v);
}

/**
 * Renders the values of a string enum for a SQL `IN (...)` list.
 *
 * @param e - the enum object
 * @returns the values single-quoted and joined by a comma and a space, for example `'a', 'b'`
 * @sideEffects none
 */
export function sqlList<E extends Record<string, string>>(e: E): string {
  return Object.values(e)
    .map((v) => `'${v.replace(/'/g, "''")}'`)
    .join(", ");
}

/** What a route of the HTTP layer answers with (technical/console.md, "Mount in the service"): an MCP server factory or a plain request handler. */
export enum RouteKind {
  /** A Streamable HTTP MCP endpoint; POST only. */
  Mcp = "mcp",
  /** A handler that answers the HTTP request itself, as the console pages do. */
  Http = "http",
}

/** Why a console request failed; each kind has one HTTP status (technical/console.md, "Architecture", `errors.ts`). */
export enum ConsoleErrorKind {
  /** A query parameter did not validate: 400. */
  BadQuery = "bad_query",
  /** An unknown path, wiki or id: 404. */
  NotFound = "not_found",
  /** A write the console refuses: 409. */
  Refused = "refused",
  /** Anything else: 500. */
  Other = "other",
  /** A write while the console's writes are off (technical/console.md, "Authentication"): 403. */
  Forbidden = "forbidden",
}

/**
 * A section of a wiki in the console (technical/console.md, "Pages"). The value is the path segment under `/console/w/<wiki>/`.
 * The 3 tabs are Overview, Health and Jobs; the More menu holds Search, Requests and Settings; Facts is the
 * path of the fact page and the export.
 */
export enum ConsoleSection {
  /** Overview (technical/console.md, "Overview"), the first page of a wiki. */
  Overview = "",
  /** Service health (technical/console.md, "Service health"). */
  Health = "health",
  /** Jobs (technical/console.md, "Jobs"). */
  Jobs = "jobs",
  Search = "search",
  /** The fact page and the export; the console has no list of facts. */
  Facts = "facts",
  /** The request list (technical/console.md, "Requests") and the request page ("Request"). */
  Requests = "requests",
  Settings = "settings",
}

/** The class of a table cell of the console (technical/console.md, "Parts"). The value is the class name. */
export enum TableCellClass {
  /** A number: right-aligned, tabular figures. */
  Num = "num",
  /** A text that can be long: cut with an ellipsis, the full text on hover. */
  Wide = "wide",
  /** The first cell of a list: the key of the row, given room (min-width 14 em). */
  Key = "key",
  /** The row action of a table: no header text, a fixed width, right-aligned, so the buttons of a column align. */
  Action = "act",
}

/** The kind of write one fact version is, against the version of the same fact before it (technical/console.md, "Requests"). */
export enum VersionWrite {
  /** The fact has no earlier version. */
  New = "new",
  /** A live version after a live one. */
  Changed = "changed",
  /** A deletion after a live version. */
  Deleted = "deleted",
  /** A live version after a deletion. */
  Revived = "revived",
}

/**
 * The class of a marker pill of the console (technical/console.md, "Interactions"). The value is the class attribute: the tone of the
 * pill, not the word in it.
 */
export enum MarkerClass {
  /** The bad wash: deleted, deletion, failed, rejected. */
  Bad = "marker",
  /** The good wash: live, revival, accepted. */
  Live = "marker live",
  /** The good wash: an observed version. */
  Observed = "marker observed",
  /** The surface-2 color: derived, old version, duplicate. */
  Derived = "marker derived",
  /** The surface-2 color: queued, running. */
  Queued = "marker queued",
  /** The good wash: a request that is done. */
  Done = "marker done",
}

/** Console (technical/console.md, "Shell"): the column layouts of `div.grid`. Every one is a single column under 900 px. */
export enum GridColumns {
  /** 2 equal columns. */
  Two = "cols-2",
  /** 3 equal columns. */
  Three = "cols-3",
  /** 2 columns in a 2 to 1 ratio. */
  TwoToOne = "cols-2-1",
  /** A main column and a 320 px side column. */
  MainSide = "cols-main-side",
}

/** Console (technical/console.md, "Parts"): the ids of the write dialogs; a button names one in `data-dialog`. */
export enum DialogId {
  CreateWiki = "create-wiki",
  /** "Run now" of the cleanup rows of Jobs. */
  RunCleanup = "run-cleanup",
  /** "Run now" of the reindex row of Jobs. */
  Reindex = "reindex",
  Archive = "archive",
  /** The pause of the queue, in the head of "Queue worker, now" on Operation. */
  PauseQueue = "pause-queue",
  /** The resume of the queue, in the same head. */
  ResumeQueue = "resume-queue",
}

/** Console (technical/console.md, "Parts"): the kinds of `details.menu` of the top bar. */
export enum MenuClass {
  /** The wiki switcher. */
  Wiki = "wiki",
  /** The "More" menu. */
  More = "more",
}

/** The keys of the `meta` table (technical/storage.md, "Tables" and technical/updates.md, "Queue and worker"). */
export enum MetaKey {
  /** The schema version of the database, as text. */
  SchemaVersion = "schema_version",
  /** The embedding model the index was built with. */
  EmbeddingModel = "embedding_model",
  /** The vector dimension of that model. */
  EmbeddingDim = "embedding_dim",
  /** The worker status JSON of technical/updates.md, "Queue and worker". */
  WorkerStatus = "worker_status",
  /** The operator pause of the queue, a JSON object `{ at, note }`; no key means that the queue runs (technical/updates.md, "Queue and worker"). */
  QueuePause = "queue_pause",
  /** The highest `seq` that the last run of each finder saw, a JSON object `{ [finder]: seq }` (technical/cleanup.md, "Cleanup"). */
  CleanupSeq = "cleanup_seq",
  /** The finders that the cap cut in their last run, a JSON array of finder names (technical/cleanup.md, "Cleanup"). */
  CleanupFull = "cleanup_full",
  /** The interval of each finder in writes, a JSON object `{ [finder]: writes }` (technical/cleanup.md, "Cleanup"). */
  CleanupEvery = "cleanup_every",
  /** The finders that ran and whose repairs have not yet set their next interval, a JSON array of finder names. */
  CleanupPending = "cleanup_pending",
  /** The request of the operator to start a batch at once, a JSON object `{ at }`; the worker deletes it (technical/updates.md, "High volume mode"). */
  BatchNow = "batch_now",
  /** The highest `seq` when the running batch started, as text. While the key exists a staging set of a batch exists; the key is deleted when the batch ends or its staging set is dropped (technical/updates.md, "High volume mode"). */
  BatchStartSeq = "batch_start_seq",
  /** The progress of the newest batch, a JSON object `{ taken, done, staged, stale, reconciliation }`; the next batch replaces it (technical/updates.md, "High volume mode"). */
  BatchProgress = "batch_progress",
  /** The marker that `npm run eval:bulk-wiki` writes into the wiki it builds, the text "1"; a copy keeps it (technical/updates.md, "The wiki of the bulk test"). */
  BulkTestWiki = "bulk_test_wiki",
}

/** The state of the reconciliation of a batch (technical/updates.md, "High volume mode", the meta key `batch_progress`). */
export enum BatchReconciliation {
  /** The requests of the batch still run, or the batch stopped before the staging set was promoted. */
  Pending = "pending",
  /** The reconciliation runs on the staging set and the live wiki. */
  Running = "running",
  /** The staging set is consistent and 1 transaction promotes it to the live wiki. */
  Promoting = "promoting",
  /** The staging set was promoted. */
  Done = "done",
}

/** Console (technical/console.md, "Store API additions"): which facts a list shows, by the state of their current version. */
export enum DeletedFilter {
  /** Facts whose current version is not a deletion. */
  Live = "live",
  /** Facts whose current version is a deletion. */
  Deleted = "deleted",
  All = "all",
}

/** Console (technical/console.md, "Store API additions"): the sort of a facts list. Scores and counts sort largest first, the header A to Z. */
export enum FactListSort {
  /** Newest fact first. */
  Created = "created",
  /** Most recently changed first, by the seq of the current version. */
  Changed = "changed",
  Confidence = "confidence",
  Usefulness = "usefulness",
  /** Most versions first. */
  Versions = "versions",
  Header = "header",
}

/** Console (technical/console.md, "Store API additions"): the sort of a requests list. Each sorts latest or largest first. */
export enum RequestListSort {
  Received = "received",
  /** A request without a finish time sorts last. */
  Finished = "finished",
  /** `finished_at - started_at`; a request without both times sorts last. */
  Duration = "duration",
}

/** Console (technical/console.md, "Health"): the health of one row, and of the wiki as its worst row. */
export enum HealthLevel {
  Green = "green",
  Yellow = "yellow",
  Red = "red",
}

/** Console (technical/console.md, "Health"): the rows of the wiki health table. */
export enum HealthRow {
  /** The worker status, the lock file and the child state. */
  Worker = "worker",
  /** The `failed` requests of the last 24 hours. */
  FailedRequests = "failed_requests",
  /** The failed calls of the MCP endpoint in the last hour. */
  FailedCalls = "failed_calls",
}

/**
 * The processes that write a log file set (technical/deployment.md, "Logging"). The value is the base of the file names, `<base>.<n>.log`
 * and `<base>-errors.<n>.log`; the worker's base takes its wiki name (`worker-<wiki>`).
 */
export enum LogProcess {
  /** `serve --db --http`: one database. */
  Serve = "serve",
  /** `serve --wikis`: the service. */
  Service = "service",
  /** The worker of one wiki, a child of the service or a `worker` command. */
  Worker = "worker",
}

/** Console (technical/console.md, "Health"): which process's log files the tail reads. The value is the `file` query parameter. */
export enum LogFile {
  Service = "service",
  /** The worker child of the wiki. */
  Worker = "worker",
}

/** Console (technical/console.md, "Routes"): the format of the facts export. The value is the `format` query parameter. */
export enum ExportFormat {
  Json = "json",
  /** Markdown, one list of the facts. */
  Md = "md",
}

/** Console (technical/console.md, "The `operatorEdit` request"): what an `operatorEdit` request does. The value is the `edit` field of its `change` document. */
export enum OperatorEditKind {
  /** Runs the duplicate fact check of the cleanup now (technical/updates.md, "Queue and worker", technical/cleanup.md, "Cleanup"). */
  Cleanup = "cleanup",
  /** Rebuilds the index tables. */
  Reindex = "reindex",
}

/** The result of a cleanupRepair request in its `cleanup_repair` log line: a request that wrote nothing. */
export enum CleanupRepairResult {
  /** The candidate no longer fits its finder. */
  Stale = "stale",
  /** The model judged the candidate and it needs no change; a verdict was written. */
  NoChange = "noChange",
}

/** A finder of the cleanup (technical/cleanup.md, "Cleanup"), in run order. The value is the `finder` of a `cleanupRepair` document. The cleanup has this one finder. */
export enum CleanupFinder {
  /** 2 live facts for one scope (F1): Q1, then the merge of step 3. */
  DuplicateFact = "duplicateFact",
}

/** Console (technical/console.md, "Operator actions", "Direct edits of non-request fields"): what an operator action does. The value is the `action` field of the `console_action` log line. */
export enum ConsoleAction {
  /** Queues a reindex job. */
  Reindex = "reindex",
  /** Creates a wiki. */
  CreateWiki = "create_wiki",
  /** Archives a wiki. */
  ArchiveWiki = "archive_wiki",
  /** Restores an archived wiki. */
  UnarchiveWiki = "unarchive_wiki",
  /** Queues a cleanup run of all checks (technical/console.md, "Cleanup repair: the backend of the operator actions", technical/cleanup.md, "Cleanup"). */
  RunCleanup = "run_cleanup",
  /** Sets the description of a wiki. */
  SetDescription = "set_description",
  /** Edits keys of the config of a wiki. */
  UpdateConfig = "update_config",
  /** Renames a wiki. */
  RenameWiki = "rename_wiki",
  /** Pauses the queue: writes the `queue_pause` key (technical/console.md, "Operator actions"). */
  PauseQueue = "pause_queue",
  /** Resumes the queue: removes the `queue_pause` key (technical/console.md, "Operator actions"). */
  ResumeQueue = "resume_queue",
  /** Starts a batch at once: writes the `batch_now` key (technical/console.md, "Operator actions"). */
  RunBatch = "run_batch",
}

/** Console (technical/console.md, "Direct edits of non-request fields"): the keys of `wikifact.json` that the config form edits. The value is the key. */
export enum ConfigEditKey {
  Subject = "subject",
  Quality = "quality",
  /** Only the operator's overrides of the preset table. */
  Questions = "questions",
  SearchCap = "searchCap",
  AgentSearchCap = "agentSearchCap",
  RelevanceFloor = "relevanceFloor",
  Weights = "weights",
  QuestionTimeout = "questionTimeout",
}

/** A signal of the console (technical/console.md, "Signals, settings and interpretations"). */
export enum Signal {
  /** The additions per search. */
  AdditionsPerSearch = "additionsPerSearch",
  /** The corrections per search. */
  CorrectionsPerSearch = "correctionsPerSearch",
  /** The distribution of the reads per search. */
  ReadsPerSearch = "readsPerSearch",
  /** The searches that returned no result. */
  NoResultSearches = "noResultSearches",
  /** The searches with results that led to no read. */
  NoReadSearches = "noReadSearches",
  /** The change requests after a search whose target fact the search did not list. */
  SearchMisses = "searchMisses",
  /** The cost in dollars per write. */
  CostPerWrite = "costPerWrite",
}

/** Why an MCP session ended (technical/deployment.md, "MCP sessions"). */
export enum SessionEndReason {
  /** The client sent a DELETE with its session id. */
  Delete = "delete",
  /** The session made no call for `SESSION_IDLE_MS`. */
  Idle = "idle",
  /** The service, the wiki or the process stopped. */
  Shutdown = "shutdown",
}

/** The span of the signals (technical/console.md, "Signals, settings and interpretations"). */
export enum Span {
  /** The last `SPAN_RECENT_SEARCHES` searches. */
  Recent = "recent",
  /** Every row. */
  All = "all",
}

/** The field of a queued change request that names what a job (a cleanup finder or an operator edit) acts on. */
export enum JobRequestField {
  /** The cleanup finder that the repair request came from. */
  Finder = "finder",
  /** The kind of operator edit. */
  Edit = "edit",
}

/** Who wrote one message of a model conversation. */
export enum MessageRole {
  /** The question, or the correction after an invalid answer. */
  User = "user",
  /** The earlier answer of the model. */
  Assistant = "assistant",
}

/** The key of an interpretation of a signal (technical/console.md, "The list of interpretations"). */
export enum InterpretationId {
  Stage = "stage",
  PoorSearches = "poorSearches",
}

/** Whether a test backs an interpretation. */
export enum InterpretationStatus {
  /** No test has confirmed it. */
  Assumed = "assumed",
  /** A named test confirmed it. */
  Tested = "tested",
}

/** One run of a word diff: words kept, words only in the new text, or words only in the old text. */
export enum DiffOp {
  Keep = "keep",
  Insert = "insert",
  Delete = "delete",
}
