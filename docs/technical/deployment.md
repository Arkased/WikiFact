# Deployment and access

Technical layer. The requirements are in [../requirements/deployment.md](../requirements/deployment.md). The design is in [../design/deployment.md](../design/deployment.md).

## Install and run

- Install: `npm ci --ignore-scripts`, `npm run build` (README "Install" says why).
- Layout: a wiki is a folder under `wikis/` with `wikifact.json` and its database. The demo wiki is `wikis/demo/`. The database, its `-wal` and `-shm` files and its lock file are ignored by git. `--db` defaults to `./wikis/demo/game.sqlite`. The model cache `.cache/` stays at the repo root.
- Worker: `wikifact worker --db ./wikis/demo/game.sqlite`. One per database. It takes `game.sqlite.lock` with an exclusive open at start, and a second worker on the same file exits with a message. It polls the queue every 1000 ms when the queue is empty. A request queued while no worker runs waits in the queue.
- MCP server: `wikifact serve --db ./wikis/demo/game.sqlite`. Transport: stdio by default, `--http PORT` for shared use. Any number may run on one database. It never runs the worker.
- Repair: `wikifact requeue [id]` lists failed requests or puts one back in the queue. `wikifact check` compares the index tables with `fact_versions`. `wikifact reindex` rebuilds the index tables and embeds everything again.
- `wikifact.json` next to the database, as in `wikis/demo/wikifact.json`: `mode` ([Local mode](deployment.md#local-mode)), `subject`, `embeddingModel`, `questions` (model and effort per question), `questionTimeout` in seconds, `highVolume` (the batch: `batchSize`, `waitMs`, `concurrency` and `groupCut`, [High volume mode](updates.md#high-volume-mode)), `weights` ([Scores](lookup.md#scores), half-lives in ms), `searchCap`, `agentSearchCap`. Every missing key takes the [Open settings](README.md#open-settings) default. An unknown key is an error. The API key comes from `ANTHROPIC_API_KEY`. A second transport runs the questions through the Claude Code login: the question layer spawns `claude -p` in headless mode with the fixed prompt, the output schema through `--json-schema`, the model and effort from the config, and no tools. `WIKIFACT_TRANSPORT=sdk|cli` forces one transport, and `WIKIFACT_CLAUDE_BIN` names the binary. The CLI transport needs a login of the standalone CLI (`claude auth login`), because the token of a running Claude Code session does not reach child shells.
The CLI transport is for local development and the evals only. Anthropic's Consumer Terms allow a subscription login in Claude Code and claude.ai, and in local experimentation with `claude -p`, and not in another product or service. A deployed worker is another service, so it needs an API key. The eval runners default to the CLI transport when no key is set. The `worker` command does not: without a key it exits with a message, unless local mode is on or `WIKIFACT_TRANSPORT=cli` is set by hand for a local run.

### CLI transport temp folders

Each call of the CLI transport makes 2 temp folders: the working folder of `claude -p` (`wikifact-cli-`) and its config folder (`wikifact-cli-cfg-`). The call deletes both when `claude -p` ends, also when it fails or times out. The CLI and its child processes can still write to the config folder after the main process ends. So the delete retries for about 5 seconds (the `maxRetries` and `retryDelay` options of `fs/promises.rm`) and does not block the event loop. A folder that still fails to delete is logged with its path and its error, and the call goes on.

Claude Code makes its own folder `<temp>\claude\<path of the working folder>` for each working folder. Without a fix, that folder lands in the Temp folder of the user and stays after the call (70,000 empty folders by 26 October 2026, #75). So the child gets `TEMP`, `TMP` and `TMPDIR` set to a folder `tmp` inside its config folder; the folder of Claude Code then lands there, and the delete of the config folder deletes it. An eval that runs `claude -p` in a temp folder (`eval/benefit/agent.ts`, `eval/corrections/consumers/claude.ts`) does the same with a `tmp` folder in its run folder. `npm run clean-temp` and the cleanup of the test run delete the folders that older code left in `Temp\claude` ([Tests](../code-standard.md#8-tests)): the names `C--Users-*-AppData-Local-Temp-wikifact-*`, older than 1 hour.

## Local mode

`wikifact.json` has a `mode` key: `deployed`, the default, or `local`. Local mode is for one user, one account and one machine, where the only consumers are that user's own Claude Code sessions. That is the local experimentation the terms allow. In local mode:

- The worker uses the CLI transport without an API key. When a key is set, the SDK transport wins, as in every mode.
- `serve --http PORT` binds to `127.0.0.1` only, so the wiki cannot be served to other machines by accident. A `--host` other than the loopback is refused with a message. The stdio transport serves a single session; the loopback HTTP transport serves every session of this user on this machine ([Service mode](deployment.md#service-mode)).
- `serve --with-worker` starts the worker as a child process after the embedder is warm. The child takes the lock file as any worker does. When another process holds the lock, the server logs that and serves without a child. The server stops the child when it exits, and the child's `running` row goes back to `queued` on the next start as [Queue and worker](updates.md#queue-and-worker) says.
- The usual local setup is the service of [Service mode](deployment.md#service-mode) at user scope in Claude Code. `serve --with-worker` over stdio is for a manual test of one database.
- The first log line of `serve` and of `worker` names the mode, the transport, and the condition: "local mode: one user, one account, one machine".

In deployed mode `--with-worker` is accepted too, for one-machine deployments with an API key. The mode changes only the credential rule and the `--http` host rule.

The `.env` file is looked up next to the database first, then at the wikis root ([Service mode](deployment.md#service-mode)), then at the project root. The first file found wins. This lets a pinned install outside the repo read the token from the wiki folder.


## Service mode

One long-running server that holds every wiki of a wikis folder, for the sessions of one user on one machine, or for a deployed host with an API key.

```
wikifact serve --wikis ./wikis --http 7777 --with-worker
```

- `--with-worker` starts one worker child per wiki, each under its own lock file, and one for each wiki that `createWiki` adds. The server stops every child when it exits.
- `--wikis` and `--db` exclude each other. `--db` serves one wiki as before.
- A pinned install: `npm run deploy` reads the task's action and creates or re-creates the task first (that step alone needs elevation, one UAC click), stops the service itself (the process that listens on 127.0.0.1:7777 and its worker children, only when its command line names `wikifact`, through `pid-port` and `fkill`; it waits up to 10 s for the port to be free and stops the deploy with exit code 1 when it is not, before anything is installed; the hidden launcher detaches the service from the task, so an end of the task does not reach it), builds, packs and installs the current checkout globally, creates the deployment folder `~/wikifact/` with `wikis/` and the 2 launcher files when absent, creates or re-creates the task with the current launcher, and starts it. The deploy makes no Claude Code entry: the WikiFact plugin of this repo (`plugin/`) holds the entry of the management endpoint. `--no-task` skips the task steps. The stop comes first because the install replaces files that a running service holds open. The launcher is a PowerShell file started with `-File`, because a path with a space does not survive a `-Command` string through the task.
- The proof of `npm run ship` ([Ship a release](release.md#ship-a-release)) reads `/console/` for the new version up to 6 times, 2 s apart (10 s of waiting in all), because the first read right after the start can reach the old process during the swap (v0.1.43 reported "does NOT show v0.1.43" while the page showed it seconds later). It stops at the first page that names the version and fails when none does. It does not read the page when the port does not answer (`runProof` in `scripts/lib/ship.ts`).
- The server binds its port before it warms the embedder, and a tool call that arrives during the warm-up waits for it, so a session that starts right after logon connects.
- `npm run deploy` stays for a redeploy and refuses a checkout that is not a release tag.
- The task runs `wikifact serve --wikis ./wikis --http 7777 --with-worker --log-dir ./.logs` from `~/wikifact/`, with no console window, so the service runs whether a terminal is open or not. `wikis/` and the token file live in that folder.

### MCP sessions

Design: [MCP sessions](../design/deployment.md#mcp-sessions). The sessions feed [Search log and sessions](lookup.md#search-log-and-sessions).

- The HTTP transport in `src/mcp/http.ts` is no longer stateless. Each client gets 1 `StreamableHTTPServerTransport` with a `sessionIdGenerator`, and 1 MCP server. The `initialize` request creates both. The server answers with the header `Mcp-Session-Id`. The client sends the header on each later request. A request with an unknown session id gets status 404. A request with no header that is not an `initialize` request gets status 400.
- The module is `src/mcp/sessions.ts`. Its class `McpSessions` holds 1 record per open session of 1 endpoint: the session id, the transport, the server, the count of calls and the time of the last call. The registry holds 1 `McpSessions` per wiki (`WikiEntry.sessions`) and 1 for the management endpoint (`WikiRegistry.managementSessions`), which is made with no store of its own but with `wikiStores`, the mounted wikis and their write connections (the registry passes its entries); `serve --http` on one database holds 1. The record is in the memory of the service process. It keeps the set of wikis that hold a row of the session, each with its store. A management session writes its `sessions` row in every mounted wiki at once, when the `initialize` request registers it: `openSession` in each store with the MCP session id as `id` (the same id in every wiki), so a session that never calls a tool has a row in each wiki and is counted by the signal "sessions with no search". The first call that names a wiki (the `wiki` argument) opens no row; each call to a wiki calls `touchSession` on its row. A wiki mounted after the session opened (or made again under a name that was archived) gets no row for it; a call that names such a wiki counts nothing on a row and records its search and retrieval rows with no session. The `search` and `getFact` calls through the management endpoint pass the id to `recordSearch` and `recordRetrieval`, as the wiki endpoint does, so a read links to its search. A call of a management tool (`listWikis`, `createWiki`, ...) names no wiki and touches no row.
- The session id is a ULID, made before the server is built so that the tools of the session know it.
- The transport inserts the `sessions` row at the `initialize` request, with `client_name` and `client_version` from `clientInfo` when the client sends them. Each tool call adds 1 to `call_count` and sets `last_call_at`.
- A session ends in 2 cases. The client sends a DELETE with its session id. Or the session makes no call for `SESSION_IDLE_MS`, a constant of `src/mcp/sessions.ts` with the value 30 minutes. A timer of each `McpSessions` (`SESSION_SWEEP_MS`, 1 minute; it runs while the set holds a session) checks its records. An ended session closes its transport and its server, leaves the registry, and sets `ended_at` in its `sessions` row (a management session: in the row of each wiki that holds one). The end by timeout sets `ended_at` to the time of the last call.
- The stdio transport is 1 session for each process. The server inserts the `sessions` row at start and sets `ended_at` when the process ends. The session id is a ULID.
- A restart of the service ends no row in the store: the next start sets `ended_at` to `last_call_at` for each `sessions` row of its wikis with `ended_at` NULL, before it serves a call (`endOpenSessions`, when the registry mounts a wiki and when `serve --http` opens its database; the stdio transport does not, because another process may hold live sessions on the same database). A stop of the service, an archive or a rename of a wiki ends its open sessions with the reason `shutdown` first. An archive or a rename also sets `ended_at` of every management session row in that wiki only; those sessions stay open and keep their rows in other wikis.
- A `GET` on an endpoint answers 405: the service sends no server-initiated message, so it opens no stream. A DELETE with no session id answers 400.
- The session writes 1 `session_start` line and 1 `session_end` line ([Logging](deployment.md#logging)).

### Endpoint counters

Design: [MCP sessions](../design/deployment.md#mcp-sessions). The Service health page reads them ([Service health](console.md)).

- The calls are in the store, so that they survive a restart: a deploy restarts the service several times a day, and an empty panel is useless (decided by the owner on October 16, 2026). `runTool` writes 1 row into `tool_calls` of the wiki that the call names (`recordToolCall(store, { at, tool, ok, durationMs })` in `src/store/toolCalls.ts`, 1 insert; a failed write is dropped and never fails the call). The store row is the only record of the calls. The read is `toolCallStats(store, now)`, which gives `{ buckets, lastHour }` ([Store API additions](console.md#store-api-additions)); the Service health page and the status pill read it ([Endpoint counters](console.md#endpoint-counters)).
- Retention: the service deletes the rows older than 7 days (`TOOL_CALL_RETENTION_MS`) when it mounts a wiki and then once a day (`TOOL_CALL_PRUNE_MS`, the timer of the registry); `serve --http` on one database deletes them at its start.
- The read has 24 buckets of 1 hour. A bucket holds, for each tool, the count of calls and the count of failed calls. For `search` it also holds the p50 and the p95 of the durations of the bucket. The calls of the last hour (`lastHour`) are a rolling hour, kept apart from the buckets, so that the count does not fall to 0 at the turn of the hour.
- A failed tool call is a call the service could not answer: an unexpected error or a timeout. A call the service refused with a reason is answered, not failed. The refusals are the errors that a tool throws on purpose with a message for the agent: `ToolError` (invalid input, an unknown id, a query over the limit) and `WikiError` (the guardrails of the management tools: a bad name, a twin, the cap, an unknown wiki or archive). `FolderLockedError`, a subclass of `WikiError` in `src/service/errors.ts`, is the exception: an archive, restore or rename folder that stays locked after every retry is a fault of the service, so `runTool` counts it as a failed tool call (`ok` false, level `error`). `runTool` in `src/mcp/tools.ts` stores `ok` true and logs `ok` true for them, and `ok` false for any other thrown error; the result to the agent is an `isError` result either way. A request that never reaches a handler (a bad session id, an invalid body) is a `http_error` line and no failed call.
- `runTool` stores each call, so the rows and the `tool` lines agree. The management endpoint has no table of its own: Claude Code connects to only that endpoint, so every call goes through it. A wiki tool call through `/mcp` writes its row into the store of the wiki that its `wiki` argument names, with the same `tool`, `ok` and `durationMs` as a call through the wiki endpoint. A call that names no mounted wiki records nothing, and the 4 management tools (`listWikis`, `createWiki`, `archiveWiki`, `unarchiveWiki`) record nothing.

### Worker restart

Design: [Worker restart](../design/deployment.md#worker-restart). The code is in `src/service/registry.ts` and `src/mcp/worker-child.ts`.

- The registry watches the `exit` event of the worker child of each wiki.
- When the child exits and the registry did not ask for the stop, the registry starts a new child after a delay. The first delay is 5 seconds. The delay doubles with each exit in a row, up to 5 minutes. After a child has run for 10 minutes, the next delay is 5 seconds again.
- The code is `superviseWorker` in `src/service/worker-supervisor.ts`, which the registry puts around each child (`WikiEntry.worker` stands for the newest child). The constants are `RESTART_DELAY_MS` (5 s), `RESTART_DELAY_MAX_MS` (5 min) and `RESTART_RESET_MS` (10 min), in that file and re-exported by `src/service/registry.ts`.
- The registry counts the restarts since the service started, for each wiki, in `WikiEntry.workerRestarts`. The count resets when the service restarts, and when a rename or a config edit mounts the wiki again. The Service health page reads it.
- Each exit logs 1 `worker_restart` line at level `error` with the wiki, the exit code or signal, the delay and the count of restarts.
- A stop that the registry asks for is a config edit, a rename, an archive or a stop of the service. The registry sets a flag on the entry before it stops the child. The `exit` handler reads the flag and starts no child.
- A child that exits inside the start window of [Local mode](deployment.md#local-mode) because another process holds the lock is not an exit of this kind. It starts no new child, as before.
- The restart has no button on the console. The Service health page shows the count. A config edit that changes a key the worker reads at start still replaces the child (`updateConfig`); that is a stop that the registry asks for.

## Logging

Every process writes JSON lines, one per event, with `ts`, `event`, `level` and the fields of the log types of [Logging](deployment.md#logging). `level` is `error` for a failed request, a failed model call, a refused start, a worker child that exits (`worker_restart`), or an unhandled error; `warn` for a retry, a rate limit, a stale lock taken over, a prior query that still misses, a temp folder of the CLI transport that could not be deleted (`temp_folder_not_deleted`); else `info`. The events `session_start` and `session_end` are at level `info` ([MCP sessions](deployment.md#mcp-sessions)). `session_start` holds the wiki, the session id, and the client name and version when the client sends them. `session_end` holds the wiki, the session id, the count of calls and the reason (`delete`, `idle` or `shutdown`). `worker_restart` is at level `error` ([Worker restart](deployment.md#worker-restart)). The `tool` line of a rejection (a `ToolError` or a `WikiError` that is a refusal with a reason) is at level `info`, with `ok` true and the error text in `error`; the `tool` line of a failed call (an unexpected error, a timeout, a `FolderLockedError`) is at level `error` with `ok` false. So the service errors log (`service-errors.log`) holds failed calls only and no rejection ([Endpoint counters](deployment.md#endpoint-counters)).

A process writes to stderr by default. With `--log-dir <dir>`, or in service mode where the default is `<wikis>/.logs/`, it writes 2 files instead, through pino and pino-roll, and nothing to stderr after the first line that names the directory, except an unhandled error: each one is also printed to stderr as 1 line with the cause (a fatal start error of `serve`, a listen error for example), and a port in use adds the hint `port <n> is in use; pass --http <other port>`:

| File | Holds | Rotation and retention |
|---|---|---|
| `service.log` | every line | a new file at 10 MB; 5 files kept, 50 MB at most |
| `service-errors.log` | every `error` and `warn` line | a new file at 10 MB; 10 files kept, 100 MB at most |
| `worker-<wiki>-calls.log` | every `question_call` line of the worker, and no other line | a new file at 10 MB; 50 files kept, 500 MB at most |

Retention is by space, not by time: the oldest file goes when the count is reached. The context of a failure is in the full log while it is inside the 50 MB window. The worker child in service mode writes to the same directory with its own files, `worker-<wiki>.log` and `worker-<wiki>-errors.log`, under the same rules. A worker with a log directory also writes the call log, `worker-<wiki>-calls.log`: one `question_call` line per question call, with the `requestId`, the question, the model, the effort, the exact input, the `ctx` and the output. The call lines stay out of the full log, because 1 line is 5 to 20 KB and would push the context of a failure out of the 50 MB window. The call log is the source of the cases from real use (10), so it keeps about 5,000 requests. Without a log directory, `WIKIFACT_LOG_CALLS=1` writes the call lines to stderr, as before. The worst case on disk is 150 MB per process, and 500 MB more for the call log of a worker; a quiet service stays under 1 MB.

The deploy script of [Service mode](deployment.md#service-mode) passes `--log-dir`, so a service started by the task has no console output and the window of the task may be closed.


## Backup, logs and client

- Backup: copy the SQLite file while stopped, or `sqlite3 .backup` while running.
- Logs: one JSON line per tool call and per change, with a level ([Logging](deployment.md#logging)). A change line holds `seq`, `request_id`, outcome, token usage, duration.
- SQLite binding: `better-sqlite3`, with `sqlite-vec` loaded through `sqliteVec.load(db)` from the `sqlite-vec` package.
- Claude Code connects to the service of [Service mode](deployment.md#service-mode) over HTTP. The repo holds no `.mcp.json`: a second server on the repo's demo database next to the service would run a second worker on the same file. A stdio server for a manual test is started by hand with `node dist/src/cli.js serve --with-worker --db <file>`.
