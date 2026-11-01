# Operator console

Technical layer. The requirements are in [../requirements/console.md](../requirements/console.md). The design is in [../design/console.md](../design/console.md).

The console has 3 pages that answer the 3 goals ([Overview](console.md#overview), [Service health](console.md#service-health), [Jobs](console.md#jobs)) and the pages of the tools ([Pages](console.md#pages)). The tables that the signals read (`searches`, `sessions`, `search_results`, `model_calls`) are in [storage.md](storage.md) and [lookup.md](lookup.md). This file does not define their columns.

## Mount in the service

The service of [Service mode](deployment.md#service-mode), and `serve --http` on one database, mount a second path prefix, `/console/`, that serves HTML pages to a human operator. [console.md](../design/console.md) is the design. The rules that the code cites:

- The console reads through its own read-only connection per request. It records no retrieval row, no search row and no session. A human read is not a consumer event of [Scores](lookup.md#scores) or of the [search log](lookup.md#search-log-and-sessions).
- The console makes no model call and runs no SQL of its own. Every read is a Store API function.
- The server renders every page. A page is one request and one connection. The console serves one script of its own. The script refreshes a page in place, shows a chart value under the cursor and focuses the search box. A page works without it, except the automatic refresh and the dialogs ([Architecture](console.md#architecture)).
- The worker owns every table that the pipeline reads or writes. A console write to one of them is a `change_requests` row of kind `operatorEdit`. The worker runs it in queue order with no model question ([The operatorEdit request](console.md#the-operatoredit-request)). The service process writes a `change_requests` row, a retrieval row and the rows of the search log, as the MCP server does. The console writes only the first.
- The console edits no fact. A start of a job and the reindex are `operatorEdit` requests. An edit of the wiki metadata is direct, through the registry.
- The `Route` of the HTTP layer returns an MCP server factory or a plain request handler. The MCP branch keeps its POST-only rule. A plain handler that throws after the headers went out still ends the response.
- Every console request logs one `console_page` line with the path, the status and the duration, at level `error` on a 500 and `info` otherwise ([Logging](deployment.md#logging)). Every write of [Writes of the console](console.md#writes-of-the-console) logs one `console_action` line.
- The registry writes `wikifact.json` for a console edit of the description or of the config keys of [Direct edits of non-request fields](console.md#direct-edits-of-non-request-fields). It restarts the worker child after its current request when a key that the worker reads at start changed. A rename stops the worker child, moves the folder, mounts the new name and starts the worker. The MCP URL changes.
- In local mode on the loopback, the write routes of the console need no authentication. In deployed mode they answer 403 until the bearer token of [future.md](../future.md) exists. In every mode, a console POST is refused with 403 when its `Sec-Fetch-Site` is `cross-site`, or when its `Origin` names another host or port than the service ([Authentication](console.md#authentication)).

## Architecture

The service mounts one path prefix on its HTTP port, `/console/`. Every route under it returns an HTML page, except the export route, which returns a file, and the 2 asset routes, which return the style sheet and the script. [Routes](console.md#routes) lists the routes. The MCP paths (`/mcp`, `/wikis/<name>/mcp`) do not change. A request to an unknown path gets 404. The console is on whenever `serve` serves HTTP. Over stdio there is no console.

A page is a string of HTML that template functions in TypeScript build. One shared style sheet and one shared script come from the same prefix. Filters, sorts and spans are query parameters. A form is a plain HTML form. A chart is inline SVG that the server draws. There are 3 chart kinds ([Charts](console.md#charts)) and none needs a library. No bundle and no browser build exist. The script is one TypeScript file that `tsc` compiles for the browser with its own config ([Code layout and build](console.md#code-layout-and-build)). The reasons for a server-rendered page are in [Pages and the shell](../design/console.md#pages-and-the-shell).

The script adds what a round trip cannot give: the refresh in place, the chart tooltip, the search key, the auto-apply of a toolbar, the menu close and the dialogs. Every behavior has a data attribute or a part class as its key, and a page works without the script ([Interactions](console.md#interactions)). The definition of a datum is in the `title` of its label, so without the script the browser shows it after its delay.

A graph view of the facts, in [future.md](../future.md), is its own phase and its own script file.

The server side is `src/console/`:

| File | Duty |
|---|---|
| `routes.ts` | Maps `/console/*` to the page handlers. It plugs into the `Route` of `src/mcp/http.ts`: a route may answer a plain HTTP request instead of an MCP one. |
| `pages/*.ts` | One file per page of [Pages](console.md#pages): `wikis.ts`, `overview.ts` (Overview), `health.ts` (Service health), `jobs.ts`, `search.ts`, `fact.ts`, `requests.ts`, `request.ts`, `settings.ts`, `export.ts`. Each handler parses the query with zod, opens a read-only store, calls Store API functions, closes the store, and returns the page. `request-versions.ts` the versions of a change on the Request page, `forms.ts` and `operator-edit.ts` the form pieces and the words of an operator edit. |
| `signals.ts` | The settings and the definitions of the signals ([Signals, settings and interpretations](console.md#signals-settings-and-interpretations)). It sits beside `pages/overview.ts`, the page. |
| `interpretations.ts` | The list of interpretations ([The list of interpretations](console.md#the-list-of-interpretations)). |
| `html.ts` | The shell ([The shell](console.md#the-shell)): the top bar with the wiki switcher, the tabs, the status pill and the More menu. The page header, the main area, the escape function, the table and the time helpers. Every string from the database passes through the escape function. |
| `pages/parts/` | The parts of [Parts](console.md#parts), 1 file per concern with an index: the wiki guard (read-only store, `now`, status pill), the query parser, the links, the badges and markers, the blocks, the data parts (`data.ts`), the controls, the lists, the form fields, the service row. |
| `diff.ts`, `charts.ts` | The word diff of a version against the one before, and the inline SVG charts. |
| `logs.ts` | The log reader: the lines of a log file set that match a filter, newest first (the trace of the Request page), and the count of the error and warn lines of a window (the service panel of the Wikis page). The file names come from the one naming function of `src/log/`. |
| `health.ts` | The rules and the thresholds of [Service health](console.md#service-health), as functions. The 3 live rows (worker, failed requests, failed calls), which the status pill, Service health and the Wikis table read. |
| `errors.ts` | Maps a thrown error to a status and an error page: 400 for a bad query, 404 for an unknown wiki or id, 409 for a refused write, 500 for the rest. |
| `style.ts` | The style sheet of [Visual design and interaction](console.md#visual-design-and-interaction), a string constant. |
| `client/console.ts` | The browser script of [Interactions](console.md#interactions). It imports nothing and reads only the DOM. |
| `write.ts`, `post.ts`, `write-paths.ts`, `actions.ts`, `settings.ts`, `auth.ts` | The write routes of [Writes of the console](console.md#writes-of-the-console). |

The `src/mcp/http.ts` change: `Route` returns 1 of 2 handlers, an MCP server factory or a plain request handler `(req, res) => Promise<void>`. The MCP branch keeps its POST-only rule. The console branch handles GET, and POST for the write forms.

## Signals, settings and interpretations

`src/console/signals.ts` holds the settings of the signals as named constants, each with a comment that names its source in the design:

| Constant | Value | Meaning |
|---|---|---|
| `SPAN_RECENT_SEARCHES` | 200 | The size of the "recent" span, in searches ([The span of the signals](../design/console.md#the-span-of-the-signals)). |
| `GROWTH_STRETCHES` | 50 | The most stretches of the growth series, in `src/store/signals.ts` ([The signals](../design/console.md#the-signals)). A wiki with more searches cuts them into longer stretches of a round size. |
| `STAGE_NEW_MIN` | 1.0 | Additions per search over this: "New" ([The signals](../design/console.md#the-signals)). A first guess. |
| `STAGE_MATURE_MAX` | 0.2 | Additions per search under this, with the corrections per search at or over the additions: "Mature". Otherwise: "Growing". A first guess. |
| `SEARCH_MISS_SHARE` | 0.2 | The share of missed facts among the change requests after a search over this: the search does not list the facts the wiki has. A first guess. |

The same file holds `SIGNAL_DEFINITIONS: Record<Signal, string>`. Each value is the text of the cell "Definition" in the table of [The signals](../design/console.md#the-signals), word for word. The `Signal` enum is in `src/domain/enums.ts` with these members: `AdditionsPerSearch`, `CorrectionsPerSearch`, `ReadsPerSearch`, `NoResultSearches`, `NoReadSearches`, `SearchMisses` and `CostPerWrite` (value `costPerWrite`). The enum `Span` has the members `Recent = "recent"` and `All = "all"`. A test checks that the `Record` has an entry per member, so a new signal has a definition.

The data of the signals starts at different versions, so a wiki that ran before them shows empty or low values for the span before: the search log and the sessions have data from 2026-10-16; the session on a change request (the link of a correction to its session) from v0.1.36; the stored tool calls (`tool_calls`, which the Service health rows and charts read) from v0.1.37; and the rule that a rejection is not a failed tool call from v0.1.46 (an older stored call that ended in a rejection counts as failed).

### The list of interpretations

`src/console/interpretations.ts` is the only place that holds an interpretation. It exports `INTERPRETATIONS: readonly Interpretation[]`, 1 entry per row of the table in [The signals](../design/console.md#the-signals):

| Field | Type | Meaning |
|---|---|---|
| `id` | `InterpretationId` (enum) | The key. Members: `Stage` (the reading of the number "Additions per search"), `PoorSearches`. |
| `of` | `Signal` | The signal that the interpretation reads. |
| `read` | `(data: InterpretationData) => string \| null` | 1 sentence that leads with a verdict word (Growing fast, Growing, Mature, Good, Poor, Weak) and says what the current numbers mean for the operator; the sentence holds no number, the stat shows it. `null` when the data cannot say anything (no searches, no change request after a search). The page shows the sentence as the hover and focus text of the number it reads, and nothing for `null`. `InterpretationData` holds the numbers of a block: `stage`, `misses`; an entry whose number is missing returns `null`. |
| `status` | `InterpretationStatus` (enum) | `Assumed = "assumed"` or `Tested = "tested"`. The developer's record: no page shows it. |
| `test` | `string \| null` | The name of the test and its section in the design, `null` while no test exists. |

Rules:

- The initial status of every entry is `Assumed`. A test result changes 1 entry: its `status`, in the same change that holds the result.
- An entry whose test fails is deleted. The signal and its definition stay.
- An entry with the status `Tested` has a `test`. A unit test checks this, and checks that each `id` is unique.
- A page does not write an interpretation by hand. It calls `reading(data, id)` of [Parts](console.md#parts), which reads the list, and gives the sentence to the `reading` field of a stat.
- The readings and their thresholds are in [The signals](../design/console.md#the-signals). A threshold is a named constant of `src/console/signals.ts`, a first guess.

## Endpoint counters

The MCP endpoint counts its calls in the store, 1 row of `tool_calls` per call, read by `toolCallStats` ([Store API additions](#store-api-additions), [Endpoint counters](deployment.md#endpoint-counters)). The store row is the only record: the console keeps no counter in memory, so a restart of the service loses no call ([Service health](../design/console.md#service-health)).

The Service health page and the status pill read `toolCallStats(store, now)` on the read-only connection of the page. `lastHour` is the rolling hour before `now`: `calls`, `failed`, and `searchP50Ms` and `searchP95Ms`, the nearest-rank percentiles of the `search` durations in that hour (`null` with no search). The page takes the stats of the panel "Reachability, last hour" (the calls, the failed calls and the time of a search) from `lastHour` alone, never from the last bucket, so the calls and the search time share 1 window. It takes the charts "Calls per hour" and "Search time per hour", and the failed calls of the panel "Failures, 24 hours", from the 24 `buckets`; the pill takes its failed-calls row from `lastHour`. `SEARCH_BAR_MS` (100) is a constant of `src/console/pages/health.ts`: the bar for the time of a search, which the color of the stat "Search time" reads and the chart draws.

A failed call is a tool result with `isError: true`, or a thrown error. `runTool` of `src/mcp/tools.ts` turns a thrown error into a result with `isError`, so both reach the same line: `runTool` writes 1 `tool_calls` row per call, in the `try` branch with `ok: true` and in the `catch` branch with `ok: false` ([Endpoint counters](deployment.md#endpoint-counters)). The management endpoint writes the row into the wiki that the call names.

## Store API additions

Every read below is a function in `src/store/` with a unit test on an in-memory store. The console is its first caller. The MCP tools and the evals may call them later. The reads for the signals are in [Store API reads for the signals](console.md#store-api-reads-for-the-signals).

| Function | Returns |
|---|---|
| `listFacts(store, opts)` | A page of facts with header, content, confidence, usefulness, version count, created, last changed seq, `isDeleted`; and `total`, the count that match. Filters: `deleted` (`live`, `deleted`, `all`), `minConfidence`, `maxConfidence`, `unread`, `changedSince`. Sort: `created`, `changed`, `confidence`, `usefulness`, `versions`, `header`. Cursor paging, `limit` 1 to 200, default 50. |
| `getFactDetail(store, id, now)` | The fact with every version newest first, as `getFact` with `agent: true`, plus per version the `changes` row, the retrieval counts by kind and whether the version is observed ([Confidence](lookup.md#confidence)); the dependents, the references with live state, and the usefulness. |
| `listRequests(store, opts)` | A page of `change_requests` rows joined with the last `changes` row of each: status, kind, outcome, reject reason, duplicate of, attempts, times, error, written fact ids, duration. Filters: `status`, `kind`, `outcome`, `rejectReason`, `factId`, `since`, `text`. Sort: received, finished, duration. Cursor paging. |
| `getRequestDetail(store, id)` | The row, the children of a split, every `changes` row of the request (a merge writes one before the request's own), and the fact versions of each, with the version before each one for a diff. |
| `listChanges(store, opts)` | A page of `changes` rows newest first, each with its request kind and its versions. Filters: `outcome`, `kind`, `factId`, `fromSeq`, `toSeq`. |
| `sampleFacts(store, n, now)` | `n` random live facts with header, content and confidence, a fresh set on every call. |
| `toolCallStats(store, now)` | In `src/store/toolCalls.ts`. The wiki tool calls of the table `tool_calls`: `{ buckets, lastHour }`. `buckets` are 24 whole hours that end at the hour of `now`, oldest first, each `{ startMs, byTool: Record<McpToolName, { calls, failed }>, searchP50Ms, searchP95Ms }` (the percentiles are the nearest rank over the `search` durations of the bucket, `null` with no search); `lastHour` is `{ calls, failed, searchP50Ms, searchP95Ms }` of the rolling hour `(now - 1 hour, now]` over every tool (the percentiles are the nearest rank over the `search` durations of that rolling hour, `null` with no search; a search 30 minutes ago at an hour boundary is in it). 1 query. The writes are `recordToolCall` and `pruneToolCalls`. |
| `requestThroughput(store, now)` | In `src/store/throughput.ts`. The change requests finished in 24 buckets of 1 whole hour of the clock that end at `now`, per bucket by outcome (`accepted`, `duplicate`, `rejected`, `split`, and `failed` for the status failed), and the totals of the processed requests (a split and a request with no change are not one): `last24h`, `lastHour` (a rolling hour), `perHour` (`last24h / 24`) and `meanMs` (the mean of `finished_at - started_at`, `null` when none). 1 query. |
| `readBatchNow(store)`, `writeBatchNow(store, at)` | In `src/store/batch.ts`. The meta key `batch_now` (`{ at }`, or `undefined`) that the button "Run a batch now" writes; `planBatch` reads and deletes it. |
| `listActivity(store, opts)` | The rows of `listRequests` with the same filters, sort and paging, plus per row the versions that its `changes` rows wrote (fact id, header, kind of write). |

The reads `getFactDetail` and `listActivity` serve the pages of the tools. They show counts, not rates.

Only the Wikis table reads `listChanges` (its newest row). The reads that no page called (`retrievalTimeline`, `getFactAt`, `stateAt`, `seqAt`, `diffStates`, `searchExplain` and `indexHealth`) are deleted; a page that needs one writes it then.

The `confidence`, `usefulness` and `decay` functions already exist and the new reads call them. No score is stored.

### Store API reads for the signals

The reads live in `src/store/signals.ts`, `src/store/jobs.ts` and `src/store/searchReads.ts`, and the store index exports them. Each takes an open read-only store. Each of the 5 signal reads takes a `SpanBounds`. No read writes a row. The tables `sessions`, `searches`, `search_results` and `model_calls` are defined in [storage.md](storage.md) and [lookup.md](lookup.md). A read here names the tables it reads, and no column of them.

A "change request" in these reads is a `change_requests` row of kind `submission`, except a row whose outcome is `split`. The children of a split are rows of their own, so they count in its place ([Facts the search missed](../design/console.md#the-signals)).

| Function | Parameters | Result | Tables it reads |
|---|---|---|---|
| `spanBounds(store, span, recentSearches)` | `span`: a `Span`. `recentSearches`: the size of the recent span (the caller passes `SPAN_RECENT_SEARCHES`). | `SpanBounds`: `{ searches, fromAt, toAt }`. For `Recent`: the newest `recentSearches` searches. `fromAt` is the time of the oldest of them and `toAt` the time of the newest. For `All`: every search, with `fromAt` and `toAt` as `null` (no bound). `searches` is 0 when the wiki has no search. | `searches` |
| `growthSeries(store, bounds)` | `bounds`: a `SpanBounds`. | `GrowthStretch[]`, oldest first; empty for a span with no search. The searches of the bounds, in time order, are cut into stretches of `size` searches, `size` the smallest of 1, 2, 5, 10, 20, 50, ... that gives at most `GROWTH_STRETCHES` stretches (a stretch ends at a multiple of `size` in the searches of the wiki so far, so the first and the last may be shorter). Per stretch `{ searches, count, additions, corrections, additionsPerSearch, correctionsPerSearch, liveFacts, liveBefore }`: `searches` is the count of searches of the wiki so far at the last search of the stretch (the searches before the span plus the position in the span), `count` the searches of the stretch, `additions` and `corrections` the counts of change requests with `received_at` from the first search of the stretch up to the first search of the next one (no end for the last stretch), the 2 `PerSearch` values those counts divided by `count`, and `liveFacts` the count of facts whose newest version with `created_at` at or before the `at` of the last search of the stretch is not a deletion, and `liveBefore` the same count at the times before the first search of the stretch. A change request is an addition when its `changes` rows wrote at least 1 fact version with no earlier version of the same fact (a lower `seq`), and a correction when they wrote a version with an earlier one, or a deletion (`is_deleted`); one that does both counts once in each, one that wrote nothing counts in neither. A change request received before the first search of the bounds counts nowhere. The divisor is never 0. | `searches`, `change_requests`, `changes` (for the outcome `split`), `fact_versions` |
| `readsPerSearch(store, bounds)` | `bounds`: a `SpanBounds`. | `{ searches, noResult, unminted, counts, unlinkedReads }`. `noResult` is the count of searches in the bounds with `result_count` 0. `unminted` is the count of searches in the bounds with results and no `search_results` row: they ran before the minted ids, so no read can link to them. `counts` has 4 numbers: the searches with results and a `search_results` row, with 0, 1, 2, and 3 or more reads; a search with no result is in `noResult` and in no count, because it has no result to read, and an unminted search is in `unminted` and in no count (`searches` is `noResult` plus `unminted` plus the 4 counts). A read links to the search that minted its `ref`, as [lookup.md](lookup.md#the-link-of-a-read-to-its-search) defines. `unlinkedReads` is the count of reads in the bounds with a NULL `ref`. It is in no count. | `searches`, `search_results`, the read rows (`retrievals`) |
| `searchMisses(store, bounds)` | `bounds`: a `SpanBounds`; only `fromAt` applies, to `received_at` (a request comes after its search, so the requests of the newest search lie after `toAt`). | `{ afterSearch, missed }`. `afterSearch` is the count of change requests that name a search: `change_requests.search_id` (schema 10) is the `searchId` the consumer passed. A request with a NULL `search_id` is in neither count. A child of a split has the `search_id` of its parent. `missed` is the count of those with a target fact that this search did not list (`search_results`, kind `fact`). The target is `changes.duplicate_of` of the last `changes` row when its outcome is `duplicate`, or the fact of each `fact_versions` row of the request's `changes` that is a later version or a deletion. A request that wrote only first versions has no target and does not count; a request that is a new fact and a correction counts only through its corrected fact. A duplicate or a correction of a listed fact does not count. A request with no search before it is in neither. | `change_requests`, `changes`, `fact_versions`, `searches`, `search_results` |
| `tokenCost(store, bounds, prices)` | `bounds`: a `SpanBounds`, applied to `received_at` of the request. `prices`: the `PriceTable` of `src/config/prices.ts`, read from `config/prices.json` (zod-validated; USD per million tokens per model id, `cacheReadFactor` (0.1) and `cacheWriteFactor` (1.25, the price of a write to the 5-minute cache, the only cache that the transports write: [updates.md, Call settings](updates.md#call-settings))). The price lookup is plain code, not SQL. | `{ writes, usd, wastedUsd, tokens, wastedTokens, unpricedCalls }`. `writes` is the count of change requests that wrote at least 1 fact version. `usd` is the sum over the `model_calls` rows of the change requests of the bounds, and of the submissions of the bounds whose outcome is `split`, of `tokens_in * input + tokens_cache_write * input * cacheWriteFactor + tokens_cache_read * input * cacheReadFactor + tokens_out * output`, divided by 1,000,000. The formula is 1 function, `costUsd` of `src/config/prices.ts`. The bulk test and the question runner call it too. The benefit test reads the dollars that Claude Code reports. `wastedUsd` is the part of `usd` on change requests that wrote nothing, and on splits whose children wrote nothing. A split counts because it holds the cost of its claim check, and, on the batch path, the cost of the calls of its children before the promotion ([Model call rows](updates.md#model-call-rows)). A split is not a change request, so it is not in `writes`. `tokens` and `wastedTokens` are the same split in input, output and cache tokens. `unpricedCalls` is the count of rows whose model has no price; they count at $0. | `model_calls`, `change_requests`, `changes`, `fact_versions` |
| `listSearchReads(store)` | none | `SearchRead[]` in time order, for [the test of the reads per search](evaluation.md#the-test-of-the-reads-per-search); no page calls it. One entry per search with `result_count` above 0 and a `search_results` row: `{ id, query, at, results, omitted, reads }`. `results` are the listed facts of kind `fact`, in rank order, each `{ rank, factId, header }`, with the header of the newest version of the fact whose `created_at` is at or before the `at` of the search (the version the agent saw). A listed fact with no such version is not in `results`; its id is in `omitted`. `reads` has one entry per read row (kind `read`) that links to the search by `ref`, in time order, each `{ factId, header, content }` of the version that the row names (`retrievals.fact_version_id`). A fact read twice appears twice. | `searches`, `search_results`, `retrievals`, `fact_versions` |
| `jobRows(store)` | none | `{ cleanup, reindex }`. `cleanup` has 1 row, for the one `CleanupFinder` (the duplicate-fact check): `{ finder, lastSeq, lastRunAt, writesSince, interval, capped, pending, lastRequest }`. `lastSeq` is the `seq` of the finder in `meta.cleanup_seq`. `lastRunAt` is the time of the change at that `seq`, or `null`. `writesSince` is the count of accepted changes above `lastSeq` that belong to `submission` and `operatorEdit` requests only, the same count that the trigger reads ([Cleanup](cleanup.md#cleanup)). `interval` is the value of the finder in `meta.cleanup_every`, or its `CLEANUP_EVERY` seed. `capped` is true when the finder is in `meta.cleanup_full`. `pending` is true when the finder is in `meta.cleanup_pending` and a `cleanupRepair` request of the finder is `queued` or `running`. `lastRequest` is the newest `cleanupRepair` request whose document names the finder: `{ id, receivedAt, status, outcome }`, or `null`. `reindex` is the newest `operatorEdit` request whose document has `edit: "reindex"`, in the same shape, or `null`. When `meta.cleanup_seq` is absent, `lastSeq` is the highest `seq` and `lastRunAt` is `null`. | `meta`, `changes`, `change_requests` |

Details that the table leaves open, as built:

- `readsPerSearch` takes the searches of the bounds by their time, and the reads by `fromAt` alone, because a read comes after its search: the reads of the newest search of a `Recent` span lie after `toAt`. Only reads of kind `read` count.
- The outcome of a request, for `searchMisses`, `growthSeries` and `tokenCost`, is the outcome of its last `changes` row.
- `jobRows` reads `meta.cleanup_seq` once: when the value is absent, every finder has `lastSeq` = the highest `seq` and `lastRunAt` = `null`. The shape here is the one built; the older shape in [Jobs data](cleanup.md#jobs-data) is replaced by it.
- `endOpenSessions(store, now)` sets `ended_at` to `last_call_at`, and to `now` when `last_call_at` is later.
- The question caller takes the store as the option `store` of `buildQuestions` and writes the `model_calls` row from the `requestId` of the question context. Without a store, or without a request id (an eval), it writes no row.

The page handler computes each ratio from these counts and checks the divisor. A ratio with a divisor of 0 shows as a dash ([Overview](console.md#overview)).

The old reads `wikiSummary`, `connectivity`, `coverageFlags` and `wikiShape` are gone from the store, with their tests, their result types and the per-day series that only they read. The Structure and Pulse pages were their only callers. The Wikis table counts the live facts and the queued requests with `countLiveFacts` and `countQueued`.

## Routes

Every route is under `/console/`. Every route returns a page, except `export` and the 2 assets. Times show as `YYYY-MM-DD HH:mm` in the local time of the server, with the ISO time in `datetime` and the unix milliseconds in `title`; a time of today shows as `HH:mm` alone, with the ISO time in `title`. A log line and a request timeline show the seconds too. A day alone shows as `YYYY-MM-DD`. Durations have 1 form on every page (`durationText` in `html.ts`): under 1 second `<1 s`, under 60 seconds `N s`, under 60 minutes `N min`, else `N h`; whole numbers rounded down, no "about", no milliseconds, no decimals ("polled 9 s ago", "1 min wait", and "no wait" when the wait is under 1 second, from `waitText`). The one exception is the search time of the endpoint, which is a measure against a bar of 100 ms and stays in ms. Ids are ULIDs. A list route takes `limit` (1 to 200, default 50) and `cursor`, and the page ends with a link to the next page. A route on an unknown wiki returns 404. A bad query returns 400 with the zod message on the error page.

| Route | Page ([Pages](console.md#pages)) | Reads |
|---|---|---|
| `GET /console/` | [Wikis](console.md#wikis) | `listWikis` of [Management tools of the service](wikis.md#management-tools-of-the-service), plus per wiki the counts of facts, deleted facts, versions, requests by status, the last change time and the health verdict. The service row: version, started at, host, port, mode, wikis directory, log directory, the archives. |
| `GET /console/w/:w?span=recent\|all` | [Overview](console.md#overview) | `spanBounds`, `growthSeries`, `readsPerSearch`, `searchMisses`, `tokenCost`. `span` defaults to `recent`. A value outside the enum is a 400. |
| `GET /console/w/:w/health` | [Service health](console.md#service-health) | The worker status, the lock file state, `queueStats`, `requestThroughput`, the failed rows, the restart count (`ConsoleWiki.workerRestarts`) and `toolCallStats`. With `data-refresh`. |
| `GET /console/w/:w/jobs` | [Jobs](console.md#jobs) | `jobRows`. With `data-refresh`. |
| `GET /console/w/:w/search?q=&history=0\|1&sample=0\|1` | [Search](console.md#search) | With `q`: the consumer search of [search](lookup.md#search), or the agent search with history ([Store API reads for the update agent](updates.md#store-api-reads-for-the-update-agent)). The query cap of 512 tokens applies: a longer query is a 400. With `sample=1` and no `q`: `sampleFacts`, 10 random live facts. It writes no search row ([Reads not counted](../design/console.md#reads-not-counted)). |
| `GET /console/w/:w/facts/export?format=json\|md&deleted=0\|1` | A file | Every fact with its current version and confidence,, from 1 unpaged read, built in memory. Markdown is one list sorted by header, 1 line per fact. Reached from the More menu. |
| `GET /console/w/:w/facts/:id` | [Fact](console.md#fact) | `getFactDetail`. Reached from the search results and the Request page. |
| `GET /console/w/:w/requests?status=&kind=&outcome=&rejectReason=&fact=&q=&since=&sort=&cursor=` | [Requests](console.md#requests) | `listActivity`. With `data-refresh` when `status` is `queued` or `running`. |
| `GET /console/w/:w/requests/:id` | [Request](console.md#request) | `getRequestDetail`, and the trace: the lines of the worker log that carry this `request_id` (the `change`, `scope_overmatch`, `priorQuery`, `lookupRepair`, `cleanup_repair` and `attempt_failed` lines). The log window is 50 MB per file set ([Logging](deployment.md#logging)), so the trace of an old request can be gone, and the page says so. With `data-refresh` while the request is `queued` or `running`. |
| `GET /console/w/:w/settings` | [Settings](console.md#settings) | The resolved config of the wiki (`wikifact.json` merged with its preset; no secret is part of the config) and, when the writes of the console are on ([Authentication](console.md#authentication)), the keys of the file as it holds them, for the forms. |
| `GET /console/style.css`, `GET /console/console.js` | | The style sheet, from memory. The script, from the built file, read once at start. |

The write routes are in [Writes of the console](console.md#writes-of-the-console). A GET of a write path is 404. The routes of the removed pages (`pulse`, `facts` as a list, `changes/:seq`, `compare`) and the fact edit routes are gone: a GET answers 404 and a POST 405, like any unknown path. The enum `ConsoleSection` has the members `Signals` (value `""`), `Health`, `Jobs`, `Search`, `Facts` (the path of the fact page and the export), `Requests` and `Settings`.

## Pages

Every page answers 1 question. The primary block holds the answer, the secondary blocks hold the detail, and the rare tools sit last or behind a control. Each page below states its purpose, its primary and secondary content, its layout as an ordered list of blocks (the parts of [Parts](console.md#parts)), its interactions and its states. A block that the design does not list is not on the page.

| Goal or tool | Page |
|---|---|
| Goal 1, where the wiki is | [Overview](console.md#overview). |
| Goal 2, the service | [Service health](console.md#service-health). |
| Goal 3, the jobs | [Jobs](console.md#jobs). |
| Spot-check | [Search](console.md#search), [Fact](console.md#fact). |
| Check what the worker did | [Requests](console.md#requests), [Request](console.md#request). |
| Keep the wikis | [Wikis](console.md#wikis), [Settings](console.md#settings). |

Every object has a URL (`/console/w/<wiki>/facts/<id>`), so a link in a report or a chat opens the object. Every table sorts by its columns through a link in the column header, and the URL holds the sort and the filters.

Rules that hold on every page:

| # | Rule | Reason |
|---|---|---|
| L1 | One primary block per page, first and widest. A stat row or a header is never the primary block. It leads to it. | The operator finds the answer without a scan. |
| L2 | A page shows a number once. A number in a stat is not repeated in a chart title, a panel note or a lead line. | Repetition is noise. |
| L3 | A block with nothing to show says what would be there, in 1 muted sentence (`p.empty`), and takes no more room. A table with 0 rows is that sentence, not a header row over "none". A chart whose values are all 0 is that sentence in place of the drawing. | An empty frame reads as broken. |
| L4 | A control sits where its effect lands: the span control in the page header changes the whole page. A filter over a table changes the table. A sort link in a column changes that column's order. | The operator predicts what a click does. |
| L5 | A long text (content, justification, reasoning, an error) is never cut on a page about that object. In a list it is cut at a fixed width, with the full text on the object page, not in a `title`. | A `title` tooltip is not discoverable. |
| L6 | An id is never the visible text of a link. A link shows the header, the name, the seq or the time. The id sits in a `code` element on the object page only. | A ULID says nothing to a reader. |
| L7 | A write action opens a dialog ([Interactions](console.md#interactions)) from a button in the page header or a table row. The page shows no form on load, except Settings. | The page reads first, acts second (V8). |
| L8 | A page of a wiki carries the status pill of the shell and no other service text. The detail is on Service health. | Service health and the other pages do not overlap. |
| L9 | A number is a datum, in the data style. An interpretation is 1 note line with its info mark and its sentence, from the list of interpretations ([Data and interpretation](console.md#data-and-interpretation)). A page writes neither as free text. | The operator sees which part is measured. |
| L10 | The words match the complexity of the information. A table cell holds a value, not a sentence. A stat line under a number holds at most 4 words. A cell, a stat line, a marker and a label have no trailing period. A sentence appears only as a lead, an empty state or a note. | A short value is scanned, a sentence is read. |
| L11 | A page surfaces only what the operator acts on. A number or a row that changes nothing the operator does is cut. | Every number costs attention. |
| L12 | Headers and labels are in sentence case. A button label is a verb of 1 or 2 words. The 3 level words are `ok`, `warning` and `failing`, in the pill, the badge and the markers, never the color names. `levelWord(level)` maps a `HealthLevel` to its word; the enum values and the style classes keep `green`, `yellow` and `red`. A filter box has a placeholder and no label. | One vocabulary on every page. |
| L13 | The answer first and widest. Related blocks sit side by side. No panel holds 1 muted sentence. | The layout shows what belongs together. |

### The shell

Every page has the top bar, the main area and the dialogs (the look is [Shell](console.md#shell)).

The top bar (`header.app`) is 1 row:

- The product name, as a link to Wikis.
- The wiki switcher, a menu ([Interactions](console.md#interactions)). Its button shows the current wiki name. Its list holds every wiki and the Wikis page.
- The 2 tabs: Overview and Operation (the route of Operation is `health`). The current one is marked.
- At the right, the status pill and the "More" menu. The menu holds Search, Requests, Settings and Export, and the service version as the last, muted line.

On the Wikis page the bar holds the product name and the version only.

The status pill (`a.status`) is a dot in the level color and up to 4 words. The text is "ok" when the 3 live rows are green. Otherwise it is the level word and the name of the worst row, for example "failing · worker". It links to Service health. Its `title` holds the 3 rows, 1 per line, in plain words with no pid, lock or child text: "worker: polled 9 s ago", "failed change requests: 0 in 24 hours", "failed tool calls: 0 of 12 in the last hour". The pill reads 3 rows: the worker state, the failed change requests and the failed tool calls of the last hour (`toolCallStats`, `lastHour`). The queue is load, not a fault: it is no row, and a long queue leaves the pill unchanged. The Wikis table shows the same 3 rows as its health badge. A wiki with no stored call has no failed call, so its third row is green.

The page header (`header.page`) holds the heading. Under it is 1 line (`p.lead`) when the page has one. At the right are the controls of the page (`div.controls`): a segmented control, a link button, or the action buttons. A page has at most 3 action buttons. A fourth goes in an "Actions" menu. The dialogs that the buttons open sit at the end of `main`.

### Wikis

Purpose: pick a wiki, and see that the service runs. Primary: the wikis. Secondary: the service, the archives, the create form.

1. The wikis table: name (a link to Overview) with the subject under it, cut to 1 line with an ellipsis and the full text in its `title` (the one place the subject shows; no other page has it as a lead), health (the badge with the level word `ok`, `warning` or `failing`, a link to Service health), live facts, queued, worker (running or stopped), the last change time, the MCP URL in `code`, and the archive button when the console may write. One row per wiki, sorted by name. Empty state: "No wiki is mounted."
2. 2 panels side by side: "Service" (the service rows: version, started, address, mode, wikis directory, log directory) and "Archives" (a table: name, archived at, the restore button; empty state "No archive."). The panel beside the table shows the archives, so the service rows do not count them, and the table counts the wikis.
3. The header control: "Create wiki", a dialog with name, subject and quality.

### Overview

Purpose: how good the search is, how the wiki grows, and what it costs ([Approach](../design/console.md#approach)). Route `GET /console/w/:w`. It reads `spanBounds`, `growthSeries`, `readsPerSearch`, `searchMisses` and `tokenCost` once and does not refresh. The page has no lead: the wiki switcher names the wiki.

The header control is the span control, a segmented control with `Last 200 searches` (the 200 is `SPAN_RECENT_SEARCHES`) and `All` ([The span of the signals](../design/console.md#the-span-of-the-signals)). Its URL parameter is `span=recent|all`, default `recent`. `recent` passes `SPAN_RECENT_SEARCHES` to `spanBounds`. The span changes the 3 blocks.

The page has 3 blocks, 1 per question of goal 1, each a panel ([Parts](console.md#parts)). The label of a signal (of a stat, or the caption of a chart) is plain text with a dotted underline that carries its definition (the `definedLabel` part): the definition shows on hover or focus of the label, in the tooltip, the same for every signal. There is no fold and no click. Every block has the same anatomy: the panel head (the title), the content (the chart and the stats in 1 grid, top-aligned). The page has no reading line (the owner's verdict of October 16, 2026): the reading of a number is the hover and focus text of that number, through the `reading` field of a stat ([Parts](console.md#parts), [Interactions](console.md#interactions)). The panel has no hairline.

1. "Search quality", full width, the primary block (L1), a `cols-2` grid, top-aligned. The left cell: a histogram of 4 bars from `readsPerSearch.counts` (labels `0`, `1`, `2`, `3+`) with the axis titles "reads after the search" and "searches", with no box and the caption "Reads per search" as the label of its definition. The tooltip shows the count and the share of the searches with results and a minted id (`searches - noResult - unminted`). The right cell: the subsection "Poor searches", a `div.subsection` with its title (a `p.note`, "Poor searches") and under it a stat row of 3 stats, first "Searches with no result" (`noResult / searches` of `readsPerSearch`, and under it "A of B searches"; signal `NoResultSearches`), then "Searches with no read" (`counts[0] / (searches - noResult - unminted)`, and under it "A of B searches with a minted id"; signal `NoReadSearches`) and "Facts the search missed" (`missed / afterSearch` of `searchMisses`, and under it "A of B change requests after a search"; signal `SearchMisses`). The count of unlinked reads is not on the page: no action follows from it. The left cell is the plot alone. The reading `PoorSearches` is the `reading` of "Facts the search missed". "Searches with no read" and the histogram are plain data in ink. The block has no reading line.
2. "Wiki growth" (the owner's order of October 16, 2026: the search quality is the primary metric, the growth is the expected change in quality over time), full width. A `cols-main-side` grid. In the main column, 2 `plot` charts stacked with the same x positions (the option `inSlots` of [Charts](console.md#charts)), from `growthSeries(store, bounds)` in `src/store/signals.ts`, which replaces `stageSeries`: (1) "Live facts", a line of `liveFacts` per point, y "facts"; (2) "Additions and corrections per search", bars of 2 series "additions" and "corrections" per stretch, y "per search". `growthSeries` cuts the searches of the bounds, in time order, into stretches of `size` searches, `size` the smallest of 1, 2, 5, 10, 20, 50, ... that gives at most `GROWTH_STRETCHES` (50) stretches. A stretch ends at a multiple of `size` in the searches of the wiki so far (so that the x labels at round counts fall on stretch ends), so the first stretch of a span and the last may be shorter. Per stretch: `searches` (the count of the wiki so far at its last search, the x value), `additions` and `corrections` (the change requests with `received_at` from the first search of the stretch to the first search of the next one, by the rules of addition and correction of the old `stageSeries`), `additionsPerSearch` and `correctionsPerSearch` (divided by the searches of the stretch, never by a count from a start), and `liveFacts` (the facts whose newest version with `created_at` at or before the `at` of the last search of the stretch is live; a search has no `seq`, so the count is by time), and `liveBefore` (the same count at the times before the first search of the stretch). The x axis title is "searches so far". The x labels are search counts at round numbers (multiples of the smallest of 1, 2, 5, 10, ... that is at least a fifth of the searches that the chart shows (from its first point to its last; a quarter gave the single label "500" over 959 searches), so 5 labels at most; the chart option `labelIndexes`), not dates. The tooltip of a slot names the searches of the stretch ("searches 801 to 810") and its values: the live facts, and the additions and the corrections per search with 2 decimals. In the side column, 3 stats: "Live facts" (`liveFacts` of the last stretch, and under it "+N in the span", `liveFacts` of the last stretch minus `liveBefore` of the first, the live facts that the span added), "Additions per search" (the additions of the whole span divided by its searches, 2 decimals, and under it "in N searches"; no level; its `reading` is `Stage`) and "Corrections per search" (the same for the corrections). States: with 0 searches the block is "No searches yet". A chart whose points all hold 0 additions and 0 corrections is the sentence "No change request yet."
3. "Cost", full width, a stat row of 2 stats from `tokenCost`: the cost per write (`usd / writes`, as `$0.0123` under 1 dollar and `$2.14` above), with "$2.14 over 178 writes" under it, and "Spent on requests that wrote nothing" (`wastedUsd / usd`, as a share), with "$0.00 of $2.14" under it. When `unpricedCalls` is over 0, 1 muted note says "N calls of a model with no price are counted at $0." This block has no reading: the design states none. The price table is `ConsoleDeps.prices`, read from `config/prices.json` when the deps are built.

A ratio with a divisor of 0 shows a dash. When the wiki has 0 searches in all, each of the blocks 1 and 2 is its panel with the one line "No searches yet" and nothing else (no chart, no stat, no interpretation, no "so far" line). The block 3 does not depend on searches. It shows its stats when `writes` is over 0, and else the line "No writes in this span". The stats are named "Additions per search", "Corrections per search", "Searches with no result", "Searches with no read", "Facts the search missed", "Cost per write" and "Spent on requests that wrote nothing". Both stats of a block carry the `signal` of their datum.

The sentence of a reading is the `reading` field of the stat of its number (`reading(data, id)` of [Data and interpretation](console.md#data-and-interpretation), `null` when the data says nothing): the stat then puts `data-definition` and `title` with the sentence on its `span.n`, and `aria-describedby` to a hidden copy, as `definedLabel` does. "Searches with no result" has a level and no reading; "Additions per search" has a reading and no level. A number that has none of the two is plain.

The numbers with a reading rule take the `level` option of `stats` (the owner's verdict of October 16, 2026), the same class `ok`, `warning` or `failing` on `span.n` as on Service health, and none when the divisor is 0 (the value is a dash). The level comes from 1 function per signal in `src/console/interpretations.ts`, the same that the reading calls, so the color and the reading never disagree: `searchMissLevel` ("Facts the search missed": ok at or under `SEARCH_MISS_SHARE`, failing over it) and `noResultLevel` ("Searches with no result": ok at 0, warning over 0). "Additions per search", "Corrections per search" and the 2 cost stats have no rule and stay in ink. The histogram has no caption value, and the chart stays as it is.

### Service health

Purpose: does the service run ([Service health](../design/console.md#service-health)). Route `GET /console/w/:w/health`. The page refreshes in place every 15 seconds. The header holds the heading with the verdict badge, and no control.

**The Operation layout (B-012).** The heading and the tab read "Operation"; the route stays `/console/w/:w/health`, so the links of the pill and of old reports keep working. The tabs of the shell are "Overview" and "Operation". `GET /console/w/:w/jobs` answers 303 to `/console/w/:w/health#jobs`. Under the status line (block 1 below), the page is 2 `cols-2` grids of 1 row each, "now" then "24 hours", with the MCP server on the left and the queue worker on the right; between them, once a batch has run, the full-width panel "Batch, now"; then the jobs panel at full width. The 2 panels of a row share their top edge and their height (the screenshot of v0.1.57 showed 2 independent columns: the button in the worker head made that column 10 px lower, and every panel under it was out of line). A panel head with an aside has the height of a panel head without one: the compact button fits in the line height of the title. The blocks:

1. "MCP server, now": "Last tool call" (`durationText` of now minus the newest `tool_calls.at`, "N s ago"; a dash with none; the level of the failed tool calls row is not on it), "Tool calls" (the calls of the last `RECENT_WINDOW_MS`, 15 minutes, "N failed" under it: ok at 0 failed in the window, else the level of the failed tool calls row, so an older fault does not color "0 failed") and "Search time" (p95 of the searches of the last 15 minutes, "p50 N ms, bar 100 ms" under it, the level rule of today). `toolCallStats` gains `recent: { calls, failed, searchP50Ms, searchP95Ms, lastAt }` over the rolling window `(now - RECENT_WINDOW_MS, now]`; `lastHour` stays for the pill and the failed tool calls row.
2. "MCP server, 24 hours": 2 `plot` charts stacked, each at the width of the column, with the same 24 hour labels and x positions (the line chart takes the option `inSlots`, which puts each point at the centre of the slot of a bar, so an hour of the line lines up with the bar above it; `plot` takes `{ definition }` for a caption whose definition is no `Signal`): "Tool calls per hour" (bars) above "Search time per hour" (p95 line with the 100 ms reference). Under them the stat "Failed tool calls" of the 24 hours (its own level, as today).
3. "Queue worker, now": "State" and the pause control of today, "Queue" (the count and the wait, or "on hold"), and "Rate" (`requestThroughput(...).lastHour`, "per hour" under it; in ink).
4. "Queue worker, 24 hours": 2 `plot` charts stacked, as in 2: "Change requests processed per hour" (bars of `accepted + duplicate + rejected + failed`; its caption carries the definition "Accepted, duplicate, rejected or failed. A split is not counted: its children are." as the `definedLabel` of the caption) above "Queue length per hour" (a line of `queueLengthSeries`). Under them the stats "Failed change requests" (with the failures table of today when there is at least 1), "Restarts" and "Per change request".
5. "Jobs" (`section#jobs`), full width: the table and the dialogs of [Jobs](#jobs), unchanged.

`queueLengthSeries(store, now)` in `src/store/throughput.ts`: 24 points at the end of each whole hour of `requestThroughput`, each the count of `change_requests` rows of a kind that the queue counts (`countQueued`) with `received_at` at or before that time, (`started_at` NULL or after it) and (`finished_at` NULL or after it): the queue as it stood then (a row finished before schema 2 has no `started_at`, so the `finished_at` term keeps it out), from the rows alone, with no new table. 1 query. The current point is the queue now.

The blocks 2, 3 and 4 below keep their stats, texts, levels and rows, in the new places. The panels "Reachability, last hour", "Failures, 24 hours", "Worker performance, 24 hours" and "Load and response time, 24 hours" are gone as panels.

The page is a `div.col` of blocks, top to bottom: the status line, the `cols-2` grid of the present, "Batch, now" once a batch has run, the `cols-2` grid of the last 24 hours, and the jobs. It holds data with levels and no verdict line: no panel has a `p.reading`. The only reading is the status line (block 1), the `verdicts` part used once with `flush`. The stats keep their fixed width, and every panel title is plain (no `note` beside it). A stat whose number has a rule takes the optional `level` of the `stats` part ([Parts](console.md#parts)): the number is colored by a class `ok`, `warning` or `failing` on `span.n`, from `--good`, `--warn` and `--bad`; a line under a stat (`span.u`) colors the same way through a `span` of the level class inside it. No level word shows under a stat. The page shows no pid, no lock and no internal name.

1. "Is anything wrong?", no panel: `ul.interps.flush` (no hairline, no margin) under the header. Nothing when the 3 rows are ok (no `ul`, no "All good."), whatever the queue length. Else 1 line per row that is not ok, in the row order, in its level: the worker ("The worker has not polled for 3 min, and 2 requests wait.", "The worker is stopped.", "The last 3 model calls of the worker failed.", "The worker's model refuses its credential.", "The last model call of the worker failed."), the failed requests ("N requests failed in the last 24 hours, the last at 14:02." and, at red, " The next request will fail too.") and the failed calls ("N tool calls failed in the last hour.", at red "N of M tool calls failed in the last hour.").
2. A `cols-2` grid of 2 panels, the present. "Reachability, last hour" has 2 stats from `toolCallStats(...).lastHour`: "Tool calls" (`lastHour.calls`, in ink; under it "N failed", `lastHour.failed`, in the level of the failed tool calls row) and "Search time" (`lastHour.searchP95Ms` in whole ms, a dash with no search; under it "p50 N ms, bar 100 ms" or "no search, bar 100 ms", the bar being `SEARCH_BAR_MS`; the number is ok at or under the bar and warning over it, and has no level with no search). The page never reads the search time from the last bucket: the window of the search time and of the calls is the rolling hour. "Queue worker, now" has 2 stats: "State" (`running`, `paused` or `stopped`, level of the worker row; under it "polled 10 s ago" or "no poll yet", and under `paused` "rate limit, until <time>" from `pauseReason` and `pausedUntil` of `worker_status`, where `<time>` is `HH:mm` for a time of today and `YYYY-MM-DD HH:mm` for a later day (a weekly limit pauses for days, [Failure modes](updates.md#failure-modes), F26), or "operator, HH:mm" from `pausedSince` (or the `at` of the key) when the key exists; a stat line holds at most 4 words, L10) and "Queue" (the count queued, in ink with no level; under it "no wait", "N min wait" or "N h wait" from `estimatedWaitMs`, the queued count times the mean duration, 30 s per request when no mean exists; "on hold" while the key exists, because no request runs and a wait would be false).

The control of the queue (the owner's verdict of October 19, 2026: a large primary button on a row of its own is not a design). It is the aside of the panel head of "Queue worker, now" (`span.aside` at the right of the title, as an `h2` aside of [Shell](#shell)), because the panel holds the state that it changes (L4). It is 1 compact default button, the size of the "Run" button of Jobs, never the primary color: "Pause" when the store has no `queue_pause` key, "Resume" when it has one. The state itself shows in the "State" stat beside it, so the button carries a verb only. The page reads the key itself (`readQueuePause`), not the worker status, so the button changes at the next refresh after the write. In remote mode the aside is empty, as for every write.

The button opens a dialog (`dialogAction`, L7 and V8), not a page:

- "Pause the queue": 1 lead line, "The worker finishes the request that runs now, then starts no request until you resume. Agents can still send change requests: they wait in the queue."; the field "Why" (1 to 500 characters) with the help line "Shown on Operation while the queue is paused"; the submit "Pause" and "Cancel".
- "Resume the queue": 1 lead line, "The worker takes the next of the N queued requests at its next poll."; no field; the submit "Resume" and "Cancel".

The dialog states the exact effect, and a pause or a resume is undone with 1 click, so the dialog is the confirmation: its form posts with `confirm=1`, and no preview page follows (the exception to [Rules for the writes](#rules-for-the-writes)). The POST redirects to Service health.

While the key exists, the status line has the worker line `The operator paused the queue at HH:mm: “<note>”` in the warning level, also when the worker has not yet seen the key. The note stands in quotes as the operator wrote it, and the line adds no period after it.

The batch ([The batch](../design/console.md#the-batch)):

- The aside of the head holds 2 compact default buttons, "Run a batch now" then "Pause" (or "Resume"), with a gap of 1 space unit. Both fit in the line height of the title, so the head keeps its height. "Run a batch now" is a form with no dialog and no preview: it posts `POST /console/w/:w/health/batch` with `confirm=1`, which writes the meta key `batch_now` (`{ at }`, `writeBatchNow` in `src/store/batch.ts`), and the worker starts a batch at its next poll ([High volume mode](updates.md#high-volume-mode)). The button is disabled when no submission is queued. The POST redirects to Operation. In remote mode the aside is empty.
- "Batch, now", a full-width panel between the row of the present and the row of the 24 hours, only when the `batch_progress` key exists (`readBatchProgress(store)`, in `src/store/batch.ts`; `batchPanel` in `src/console/pages/health-batch.ts`). It shows the newest batch, and the next batch replaces it. Stats, in ink: "Done" ("N of M" requests, the requests that the promotion marked done out of those that the batch took; a request that went back to the queue is not counted), "Staged changes" (`staged`: the changes in the staging set, under it "in the staging set"), "Stale reruns" (the requests whose first write was refused as stale) and "Reconciliation" (`pending`, `running`, `promoting` or `done`). The panel has no level, no table and no button. While the worker status holds `lastBatchError` (a failed promotion), a line under the stats gives the time (`untilText`: with the date when it is not today) and the error, in the warning color (`leveled` with `HealthLevel.Yellow`, styled by `p.help .warning`), then "Its requests run one at a time." The worker clears `lastBatchError` when a batch ends and when the 1-at-a-time run of the dropped batch ends, so the line shows only while that run goes on.
3. A `cols-2` grid of 2 panels, the history. "Failures, 24 hours" has 3 stats: "Failed change requests" (the count of `failedRequestsIn`, level of the failed change requests row), "Failed tool calls" (the failed tool calls of the 24 `buckets` added; its own level: ok at 0, warning over 0, not the failed tool calls row, which reads the last hour) and "Restarts" (the count since the service started, under it "since start"; ok at 0, warning over 0). "Worker performance, 24 hours" has 2 stats, both in ink: "Change requests processed" (`requestThroughput(...).last24h`, under it "N per hour" from `perHour`) and "Per change request" (`meanMs` with `durationText`, a dash when none). The restart count is `ConsoleWiki.workerRestarts`, which the registry sets from the child watcher of [Worker restart](deployment.md#worker-restart). It is `undefined` for a worker outside the service, and the stat then shows a dash and "outside the service", with no level. Under the stats of "Failures, 24 hours", only when at least 1 request failed in the 24 hours, the failures table (received as a link to the request, failed at, attempts, the error cut to 2 lines with a fold "Full error"; no button). With no failed request the panel ends with the stats: there is no "Nothing failed" line.
4. "Load and response time, 24 hours", a panel with a `cols-3` grid of 3 `plot` charts at `CHART_WIDTH.third`, each of 1 series, with the `HH:00` labels in the local time of the server and the axis title "hour": "Tool calls per hour" (stacked bars, the tool calls of every tool added; y "calls"; empty "No call in 24 hours"), "Search time per hour" (a line chart of the p95 of each hour in whole ms, `null` for an hour with no search, with `SEARCH_BAR_MS` as the reference line "100 ms"; y "ms"; empty "No search in 24 hours") and "Change requests per hour" (stacked bars of `requestThroughput(...).buckets`, `accepted + duplicate + rejected + failed`; a `split` is not a request processed; y "requests"; empty "No request in 24 hours"). There is no split by tool or by outcome.

The page has no check of the index, the schema or the database, and no log tail: no use case names them. The log of a service is read in its files.

The rows, in `src/console/health.ts`:

| Row | Where it shows | Source | Green | Yellow | Red |
|---|---|---|---|---|---|
| Worker | The pill, the status line, and the color of the "State" stat of "Queue worker, now" | `worker_status` in `meta`, the lock file, the child state | polled within 60 s, last call ok | polled within 60 s and the last call failed with `other` or `rate_limit`, `consecutiveFailures` under 3; or the worker is paused (`state` `paused`: a rate limit is a wait, the worker is alive on its own timer; it is ok again after a successful call); or the store has the `queue_pause` key (the operator paused the queue) | no poll for 60 s, or `credential`, or 3 or more consecutive failures, or the child ended |
| Failed change requests, 24 hours | The pill, the status line, and the color of the "Failed change requests" stat of "Failures, 24 hours" | the `failed` rows with `finished_at` in the window | 0 | 1 or more | 1 or more whose `error` is a credential failure, because the next request fails too |
| Failed tool calls, 1 hour | The pill, the status line, and the color of the "N failed" under "Tool calls" of "Reachability, last hour" | `toolCallStats` (`lastHour`); a failed tool call is a call the service could not answer (an unexpected error or a timeout); a call refused with a reason is answered, not failed ([Endpoint counters](deployment.md#endpoint-counters)) | 0 failed | 1 or more failed | `FAILED_CALLS_RED_MIN` or more calls, and a failed share of `FAILED_CALLS_RED_SHARE` or more |

Three stats have a rule that is no health row: "Search time" (ok at or under `SEARCH_BAR_MS`, warning over it), "Failed tool calls" of "Failures, 24 hours" (ok at 0, warning over 0, over the 24 hours) and "Restarts" (ok at 0, warning over 0). They do not enter the verdict of the wiki. The stats "Tool calls", "Change requests processed" and "Per change request" have no rule and stay in ink.

The verdict of a wiki is the worst row. The badge on the Wikis table and on this page shows it. The row thresholds are constants in `src/console/health.ts`, each with a comment. `FAILED_CALLS_RED_MIN` is 5 and `FAILED_CALLS_RED_SHARE` is 0.5. The worker row rests on a rule that ships today. The failed requests and failed calls rows are first guesses with no measurement behind them. Their revision is in [future.md](../future.md). The rows Index, Schema, Database and "Errors, 24 hours", and their functions, are gone with the checks and the log tail. The enum `HealthRow` has the members `Worker`, `FailedRequests` and `FailedCalls`. The queue is load, not a fault (the owner's verdict of October 16, 2026): `HealthRow.Queue`, the queue thresholds and the queue level function are gone, and the Queue stat of "Queue worker, now" shows the length and the wait in ink. The enum `HealthLevel` is unchanged. A wiki with no stored call has no failed call: its row is green.

### Jobs

Purpose: what runs by itself, and when ([Jobs](../design/console.md#jobs)). Since B-012 the jobs are the last section of the Operation page (`section#jobs`, `jobsSection` in `src/console/pages/jobs.ts`), not a page: `GET /console/w/:w/jobs` answers 303 to `/console/w/:w/health#jobs`, and the previews of "Run" go back there. It reads `jobRows`, and it refreshes with the Operation page.

1. "Jobs", the primary block, a table with 1 row per job: "Merge duplicate facts" (the one check of the cleanup, as a verb), then "Rebuild the search index". A cell holds a value, not a sentence. The columns:

| Column | Cleanup row | Reindex row |
|---|---|---|
| Job | The name above, from `jobName(finder)`. | "Rebuild the search index". |
| Every | `interval` in writes ("1 write", "200 writes"), from `meta.cleanup_every` (the `CLEANUP_EVERY` seed when absent). | "manual". |
| Last run | `lastRunAt` as a time only. "never" when `lastRunAt` is `null`. | The time of `reindex.receivedAt`, or "never". |
| Next run | "in N writes", with N the interval minus `writesSince`, not under 0. "after its repairs" when `pending` is true, because the check waits for the repairs of its last run ([Cleanup](cleanup.md#cleanup)). Else "at the next write" when `capped` is true, and "after the current request" when N is 0, because the check starts when the request that runs ends; the word "now" never shows. | A dash. |
| Result | 1 word, as a link to `lastRequest`: "repaired" when the `cleanupRepair` request wrote (outcome `accepted`), "nothing found" in muted text when it was done and wrote nothing, the `failing` marker when it failed, and `queued` or `running` while it waits. A dash when there is no request. | The marker of the status of `reindex` as a link (`done`, `failing`, `queued`, `running`), or a dash. |
| (action) | The button "Run", compact, which does not wrap. The column has no header text and a fixed width, so the buttons align. | The button "Run". |

2. The dialogs of the buttons ([Run](console.md#run)), titled "Run the cleanup" and "Rebuild the search index". Each asks "Why" (1 to 500 characters, with the help line "Kept with the request, 500 characters at most"), and its submit button is "Preview".

The table always has 2 rows: the cleanup, then the reindex. The page has no empty state.

#### Run

"Run" on the cleanup row posts to `POST /console/w/:w/jobs/cleanup`. It queues the `operatorEdit` document `{ edit: "cleanup", note }`, which runs the duplicate-fact finder now ([Cleanup run](console.md#cleanup-run-the-backend-of-the-operator-action)). "Run" on the reindex row posts to `POST /console/w/:w/jobs/reindex`. It queues `{ edit: "reindex", note }`. Both routes follow the rules of [Rules for the writes](console.md#rules-for-the-writes): the preview, `confirm=1`, a 303 to the request page, 1 `console_action` line. The requirement "Operator start" of [cleanup.md](../requirements/cleanup.md) is met here.

### Data and interpretation

The parts of [Data and interpretation](../design/console.md#data-and-interpretation) are in `src/console/pages/parts/data.ts`:

| Part | Function | Markup |
|---|---|---|
| Defined label | `definedLabel(signal, label)` | `span.defined[tabindex=0]` holding the label. `data-definition` and `title` hold `SIGNAL_DEFINITIONS[signal]`; `aria-describedby` names a following `span.sr-only` (visually hidden) with the same text, so a screen reader reads it. The script shows the text in the tooltip on hover or focus. There is no fold, no chevron and no "Definition" link. |
| Reading | `reading(data, id)` | The sentence that `read(data)` of the entry of `INTERPRETATIONS` returns, or `null`; it throws for an unknown `id`. It renders nothing: a page gives it to the `reading` field of a stat. The status of the entry is the developer's record and no page shows it. |

A stat takes an optional `reading` field (a sentence, or `null`). With a sentence its `span.n` is focusable (`tabindex=0`) and carries `data-definition` and `title` with the sentence, and `aria-describedby` names a following `span.sr-only` with the same text (the same mechanism as `definedLabel`, so the script shows it in the tooltip). The `level` color is independent: a number may have a level, a reading, both or none. A stat that shows a signal takes an optional `signal` field. The `stats` part then makes the label of the stat a `definedLabel`. The histogram of the reads per search, which is no stat, does the same with its caption (`plot(caption, body, signal)`).

### Search

Purpose: what the wiki knows about a topic, as a consumer sees it. Primary: the search box and the result list. Secondary: the sample.

1. The search box, 18 px, marked `data-search`, with the placeholder "Search as an agent would: a phrase or a claim", and the search button at its right in the same row (`div.search-row`: the box grows, the button keeps its width). Enter submits. Under the box, one row (`div.search-options`, a flex row with 16 px gaps) of 2 small controls: a link "Random sample" (`?sample=1`) and a checkbox "Include old and deleted versions". A checkbox change submits the form when it has a query.
2. The results, a result list ([Parts](console.md#parts)), 760 px wide at most: each result has the header as a link, the content in full, and a meta row with the confidence meter; the score is not shown. A deleted fact carries a "deleted" marker, an old version an "old version" marker with the seq in its `title`. Over the list, 1 status line says the count and what the search is: "7 facts. Live facts only. Nothing is recorded." With "Include old and deleted versions" on, the page runs the agent search and the middle sentence is "All versions, deleted facts too."
3. "Random sample" shows 10 random live facts as the same list, a fresh set on every load, with the line "10 random live facts."

States: without a query and without the sample, the page shows the box and under it one sentence that says what the search is. No hit: "No fact matches. The relevance floor drops a hit whose cosine distance is over 0.31." A query over 512 tokens is a 400 whose message says the limit.


### Fact

Purpose: read one fact and its history. Primary: the fact as it stands, content and justification. Secondary: the history, the details, the usage.

1. The page header: the header of the fact as the heading. The page has no control: the console edits no fact ([Decisions](../design/console.md#decisions)).
2. The fact block, in the main column: the content at 18 px; under it the justification of the current version as stored ([Stored text](../design/console.md#stored-text)) in a quote block; under that a fold "Why this version" with the change reasoning. A deleted fact shows a "deleted" notice over the content.
3. The "History" section, in the main column: a timeline ([Parts](console.md#parts)), newest first, 1 entry per version: the time as a link to the request that wrote the version (the seq in the `title` of the link only), the markers (deletion, revival, observed or derived), the summary in 1 line, and a fold "Diff and reasoning" with the header and content diffs (word diff), the references added and removed, and the justification and the change reasoning as stored.4. The side column, a "Details" panel: status (live or deleted), origin of the current version (observed or derived), confidence (the meter), reads and confirms of the current version ("0 reads, 0 confirms"), references (header links with the live state), dependents (header links), id (`code`), created. Empty values say "none" in muted text.


### Requests

Purpose: what happened to the wiki, newest first. Primary: the table. Secondary: the filters.

1. The toolbar: a segmented "Status" control (All, queued, running, done, failed), an outcome select, a text field over the change text (the placeholder "Filter by text", no label), and the "More filters" fold with kind (in words: submission, lookup repair, operator edit, cleanup), reject reason, fact and since (a date field). The applied filters show as chips, with the same words and the date. The page has no lead.
2. The table over `listActivity`: received (the time, a link to the request); kind in words (submission, lookup repair, operator edit, cleanup); result (1 marker, from `resultMarker`: the outcome when the request is done (`accepted`, `duplicate`, `rejected: <reason>`, `split`), else the status: `queued`, `running`, or `failing` for a failed request); change (the text cut at 26 em, an operator edit or a cleanup request as its document in words with links ([Request](console.md#request)), an operator edit with its note, and under it one line with the facts written as header links, each with its write marker new, changed, deleted or revived); duration. Sort: received, duration. Empty state: "No request matches the filters." The page refreshes in place every 15 seconds while the status filter is queued or running.
The page has no header control.

The read is `listActivity` of [Store API additions](console.md#store-api-additions).


### Request

Purpose: fact-check what the pipeline did with one request. Primary: the change text and the result. Secondary: the justification, the timing, the trace.

1. The page header: "Request" as the heading with 1 marker (`resultMarker`: the outcome when the request is done, else the status; never "done" beside an outcome); the lead: the kind in words and the received time. The page has no control. A failed request stays as a record for the developer.
2. The main column, a "Submission" panel: the change text in a quote block, and under it the justification as stored ([Stored text](../design/console.md#stored-text)), labeled. The document of an operator edit or a cleanup request is JSON that code wrote: an operator edit shows it as a key-value list with a "Change" row in words with links to its facts, a cleanup request shows words in place of the JSON, and a document that does not parse shows as stored.
3. The main column, the "Result" section: 1 card per `changes` row of the request (a merge first, then the request's own), whose head holds the outcome marker and the time (no seq and no summary sentence: the version rows under it say the same, with links). For each version written: the header link with its write marker, the content diff against the version before (a new fact shows its content plain), the references as header links (L6), and a fold "Justification and reasoning" with both texts as stored. A rejected request shows the reject reason and the summary of the judgment. A failed request shows the error in a bad notice. A request that a split made into children ([Split of a compound submission](submit.md#split-of-a-compound-submission)) has the outcome "split" and a "Split into" panel above the result: 1 row per claim with the link to its request, the claim text and its status.
4. The side column, a "Timing" panel, a key-value list: received, started ("<time>, waited <duration>"), finished ("<time>, took <duration>"), failed attempts (a row only when over 0, with the next retry while queued), duplicate of (the header of the fact as a link), split from (the received time of the parent request as a link, on a child; never a raw id, L6). "Targets" (header links) and "Prior query" rows when the request has them.
5. The "Trace" panel at the end, a key-value list in plain words ([Plain words](../design/console.md#plain-words)) over the lines of the worker log that carry this request, oldest first: "Model tokens" ("6 in, 1,347 out"), "Duration", "Dependents checked" and "Dependents re-judged" from the change lines (summed), and 1 row per other line, its term the plain name of the event (for example "Claim check", "Failed attempt") and its value the words of the line. Empty state: "No trace. The log window of 50 MB per file set has rolled past this request, or the worker ran elsewhere."

The page refreshes in place while the request is queued or running.


### Settings

Purpose: read and edit the wiki's own fields ([Direct edits of non-request fields](console.md#direct-edits-of-non-request-fields)). Primary: the resolved config. Secondary: the forms.

The page has no lead (the wiki switcher names the wiki).

1. The "Config" panel: a key-value list with plain labels and units: Mode, Quality preset, Subject, Embedding model, Question timeout ("120 s"), Result cap, Agent result cap, Relevance floor; under it a sub-list "Weights": Update weight, Confirm weight, Read weight, Confidence half-life ("30 days"), Use weight, Use bound, Usefulness half-life ("30 days").
2. The "Model questions" panel: a table of the questions named by what they do ([Plain words](../design/console.md#plain-words)), the model and the effort.
3. The "Edit" panel, open on load (the one page whose job is the edit, V8), with 1 short lead ("Changes restart the worker after its current request. An empty field keeps the preset's value.") and 3 sections, each its own form: Description ("Save description"); Config, the keys as the file holds them with the labels of the Config panel (an absent key stays absent, so the preset keeps its role, and the question models hold only the operator's overrides; `mode` and `embeddingModel` are not listed) ("Save config"); Name ("Rename"). The control of the page header: "Archive" (a danger dialog). When the console's writes are off ([Authentication](console.md#authentication)), or the server serves one database and has no registry, the page shows blocks 1 and 2 only and says why there is no form.


### Preview and error pages

A preview page ([Rules for the writes](console.md#rules-for-the-writes)) shows the exact write in a panel, and the confirm form under it with 1 primary button. The shell of the page it came from stays, so the operator sees where the edit lands.

An error page shows the status as the heading and the message as a bad notice; the shell stays.

## Non-functional rules

- A page is 1 request, 1 read-only connection and under 1 second on a wiki of 10,000 facts. The 5 signal reads of Overview are counts over indexed columns, and `growthSeries` is 1 pass over `searches` and `fact_versions`. The status pill adds 4 reads to every page of a wiki: `queueStats`, the failed count, the worker status and the memory counter. `npm run console:timing` measures every page and writes `reports/console-timing.md`.
- No page holds more than 2,000 rows. Every list pages.
- No external script, style or font. The console serves its own style sheet and its own script, and nothing else. The script imports nothing, sets no cookie and stores nothing in the browser. The URL holds the chosen wiki, the span and the filters.
- Every string from the database or the query is escaped before it enters a page. The script inserts the server's HTML only, never a string that it built from a value.
- Every console read passes `now` to the score functions once per request, so every confidence on a page is from the same instant.
- No console read writes a row of the search log, a session or a retrieval ([Reads not counted](../design/console.md#reads-not-counted)). The connection is read-only, so a fault here is an error and not a bad row.

## Tests

The rules are in code-standard section 8. Each page handler has a unit test on an in-memory store seeded by `seedChange`. The test parses the page with `jsdom` and checks the numbers and text that a reader sees, never the markup. A test that needs the time uses an injected `now` or a fake clock. A boundary test uses the constant by name, 1 under and 1 over (`SPAN_RECENT_SEARCHES`, `GROWTH_STRETCHES`, `SEARCH_BAR_MS`, `FAILED_CALLS_RED_MIN`).

The tests of the removed code are gone with it: the tests of the Structure, Pulse, Facts, Change and Compare pages, of the fact edits, of the Requeue and Restart actions, of the old Health page (the log tail, the index, schema and database checks, the row `Errors`), of the "show ranking" view, of the overlap flags, and the store tests of `wikiSummary`, `connectivity`, `coverageFlags` and `wikiShape`.

Tests that stand for the new code:

| Test | What it proves |
|---|---|
| `src/console/__tests__/overview-page.test.ts` | The 3 blocks from a seeded store, the "Poor searches" subsection with its 3 stats beside the histogram. A store with 0 searches shows "No searches yet" and nothing else in the first 2 blocks, never `NaN`. `span=recent` and `span=all` give different counts on a store with more than `SPAN_RECENT_SEARCHES` searches, in the "Wiki growth" chart too: over `recent` it starts at the first search of the span, and its tooltip shows the values of the point. A bad `span` is a 400. Each datum has its definition. Each reading is the `title` and the `aria-describedby` text of its number ("Additions per search", "Facts the search missed"), with no status word, a number whose data cannot say anything has none, and the page has no `p.reading` and no `ul.interps`. The level class of each number with a rule ("Searches with no result" warning, "Facts the search missed" failing on the seeded store) and none on the numbers with no rule. |
| `src/console/__tests__/health-page.test.ts` | The panels in order: "Reachability, last hour" and "Queue worker, now" in a `cols-2` row with no note beside the title, "Failures, 24 hours" and "Worker performance, 24 hours" in a second `cols-2` row, "Load and response time, 24 hours". The status line (a line of a row that is not `ok`, with its level class and its detail; nothing, no `ul`, when every row is ok), outside every panel, and no `p.reading` in a panel. "Reachability, last hour" with its stats Calls ("N failed" under it) and Search time of seeded `tool_calls` rows (`recordToolCall` on an injected `now`), the search time over the rolling hour (a search of the previous hour bucket counts), the level class of Search time at `SEARCH_BAR_MS` and 1 ms over, and the color of the failed calls under Calls. "Queue worker, now" with State and Queue, the level class of State (no poll, stopped), and the Queue in ink with a wait in hours ("N h wait") and no line in the status line for 606 queued requests. "Failures, 24 hours" with its 3 stats and "Worker performance, 24 hours" with its 2, by label, their level classes (Restarts at 0 and over 0, Failed calls ok at 0 and warning over 0 also for a failure older than the last hour, Failed requests warning and failing) and the performance stats in ink, the failures table present with a failed request (its error, its fold) and absent, with no extra line, without one. "Load and response time, 24 hours" with 3 charts of 1 series each, the axis titles and the bar, and the empty sentences. A worker outside the service says so. The page has no button, no check, no log, no pid and no lock. |
| `src/console/__tests__/jobs.test.ts` | The table has the cleanup row and the reindex row. The "next run" text follows `writesSince` and `interval` at the boundary, 1 under and 1 over. A capped finder shows "at the next write". The result column links to the last request as "repaired", "nothing found", `failing` or its status. |
| In `actions.test.ts`: the 2 Run routes | `POST /console/w/:w/jobs/cleanup` queues an `operatorEdit` with `edit: "cleanup"`. `POST /console/w/:w/jobs/reindex` queues `edit: "reindex"`. Each needs the note, answers 403 from another origin or outside local mode, and writes 1 `console_action` line. |
| `src/console/__tests__/interpretations.test.ts` | Each `Signal` has a definition. Each `id` is unique. An entry with the status `Tested` has a `test`. Each reading is checked as its exact text (verdict word first, no number) at both sides of each of its thresholds, by the name of the constant, and for the `null` case. Each level function of a signal (`searchMissLevel`, `noSearchSessionsLevel`, `noResultLevel`) is checked at each threshold, by the name of the constant. |
| In `parts.test.ts`: `definedLabel` and `reading` | The `definedLabel` part holds the text of its signal in `title`, `data-definition` and the element that `aria-describedby` names. A stat with a `reading` holds the sentence in the `title`, `data-definition` and `aria-describedby` text of its number, and a stat with `null` or no reading holds none. `reading(data, id)` returns the sentence, `null` for no data, and throws for an unknown id. A stat with a `level` has the class `ok`, `warning` or `failing` on its number, and a stat without has none. A part test may assert the class names that the style sheet selects. |
| In `status.test.ts`: the 3 rows | The pill is "ok" when the 3 rows are green, with a title of 3 lines and a long queue (606 requests) that leaves it "ok", else the level word (`warning` or `failing`) and the row. A failed-call count at the boundary of `FAILED_CALLS_RED_MIN` and of `FAILED_CALLS_RED_SHARE` changes the level. The pill links to Service health. |
| In `health.test.ts`: `failedCallsLevel` | The rule at its boundaries. |
| In `health.test.ts`: `liveHealth` | The 3 rows in order; a queue of 606 requests leaves the verdict green and adds no row. |
| `src/mcp/__tests__/tools.test.ts`: `runTool` | `runTool` records 1 call on the success path and 1 failed call on the error path. |
| `src/store/__tests__/signals.test.ts` | Each signal read on a seeded store. `growthSeries` cuts the searches into at most `GROWTH_STRETCHES` stretches (the boundary at 50 and 51 searches), divides the requests of each stretch by its own searches, gives the live facts by time at the last search of each stretch and just before its first (a deleted fact is not live), ends each stretch of a span at a multiple of the stretch size in the searches of the wiki (a wiki of 1,003 searches, a span of 200), counts an addition, a correction, a deletion, a request that adds and corrects (once in each) and a request that wrote nothing (in neither), and counts a request received before the first search nowhere. A split request is not counted, its children are. `readsPerSearch` leaves an unlinked read out of every count, and a search with no result is in `noResult` and in no count. `searchMisses` counts a duplicate of an unlisted fact and a correction of an unlisted fact, and does not count a duplicate of a listed fact, a correction of a listed fact, an addition after a search, a request with no search before it, a request with no session, or a request whose session has no search before it (a search of another session does not link). `tokenCost` prices each model call by a fake price table, counts the cost of a request that wrote nothing as wasted, and counts the calls of an unpriced model. No read adds a row. |
| `src/store/__tests__/throughput.test.ts` | `requestThroughput` on an in-memory store with an injected `now`: 24 whole-hour buckets, the count by outcome and hour, the failed status, a split and a request with no change out of the totals, the rolling hour, the mean duration and `null` when none. |
| `src/store/__tests__/jobs.test.ts` | `jobRows` with `meta.cleanup_seq` present and absent, with a finder in `meta.cleanup_full`, and with a reindex request. |
| `src/console/__tests__/charts.test.ts` | The reference line, the tooltip text of a position, the detail of a histogram bar and the null points of a line chart. |

The requirement tests of [Operator console](../requirements/console.md) are in `__tests__/requirements/console.test.ts`. The rows `Wiki growth`, `Search quality`, `Cost`, `Service health`, `Queue pause`, `Jobs` and `Data and interpretation` are tests, each with the name of its row and a seeded in-memory store (`tool_calls` rows seeded through `recordToolCall` on a fake clock for the panel "Reachability, last hour" of `Service health`). The list of pages that the timing run measures is in `scripts/console-timing.ts`; the `Fast page` test proves the bar logic of `scripts/lib/console-timing.ts`.

## Writes of the console

The console writes in 2 ways ([Approach](../design/console.md#approach)). The `operatorEdit` request carries a start of a job and the reindex. A direct write through the registry carries the name, the description and the config of a wiki. A direct write of the `queue_pause` key of `meta` carries the pause of the queue ([The pause of the queue](../design/console.md#the-pause-of-the-queue)). The console makes no other write.

### Operator actions

| Action | Route | Does | Exists today as |
|---|---|---|---|
| Reindex, "Run" of the reindex job | `POST /console/w/:w/jobs/reindex` | A queued job of kind `operatorEdit` with `edit: "reindex"` ([The operatorEdit request](console.md#the-operatoredit-request)). The worker runs `reindex` in queue order, with the embedder that it already holds for its index writer. Reindex writes every index table, so it cannot run beside a pipeline commit ([Operator edits in the queue](../design/console.md#operator-actions-in-the-queue)). The page follows the request. | `wikifact reindex` |
| Run the cleanup, "Run" of the cleanup job | `POST /console/w/:w/jobs/cleanup` | A queued `operatorEdit` with `edit: "cleanup"` ([Cleanup run](console.md#cleanup-run-the-backend-of-the-operator-action)). | none |
| Pause the queue, resume the queue | `POST /console/w/:w/health/pause`, `POST /console/w/:w/health/resume` | Pause: the dialog of [Service health](#service-health) with the `note` (1 to 500 characters, as the note of an `operatorEdit`) posts with `confirm=1`, then `setQueuePause` on the write store of the wiki ([Queue and worker](updates.md#queue-and-worker)). Resume: the dialog with no field posts with `confirm=1`, then `clearQueuePause`. A POST without `confirm=1` (a client with no script) still gets the preview page. Each redirects to Service health. A pause of a paused queue and a resume of a running queue are refused with a 409 and the reason. The enum `ConsoleAction` has the members `PauseQueue` and `ResumeQueue`. | none |
| Run a batch now | `POST /console/w/:w/health/batch` | The button "Run a batch now" of [Service health](#service-health) posts `confirm=1`. It writes `batch_now` with `writeBatchNow`, so the worker starts a batch at its next poll ([High volume mode](updates.md#high-volume-mode)). A POST without `confirm=1` still gets the preview page. Redirects to Service health. The enum `ConsoleAction` has the member `RunBatch`. | none |
| Archive, unarchive, create a wiki | `POST /console/wikis`, `POST /console/w/:w/archive`, `POST /console/w/:w/unarchive` | The management tools of [Management tools of the service](wikis.md#management-tools-of-the-service), through the registry. Same guardrails. | the MCP management tools |

The enum `ConsoleAction` has no `Requeue`, `RestartWorker`, `CorrectFact`, `DeleteFact` or `AddFact`. The cleanup route is `POST /console/w/:w/jobs/cleanup` and the reindex route is `POST /console/w/:w/jobs/reindex`. The members are `RunCleanup` and `Reindex`, and `actionTemplate` in `write-paths.ts` gives the new paths. Both Run routes are in `actions.ts`. The registry has no public `restartWorker`: the service restarts a worker child itself, and `updateConfig` restarts it after a change of a key that the worker reads at start. Each write redirects to the page of the new request, which follows the request while it is queued or running.

The page refreshes in place through the script ([Architecture](console.md#architecture)), which skips a refresh while a field holds a typed value, so a half-typed note survives.

Every write asks the operator to confirm in the page. Every write logs 1 line with the event `console_action`, the action, the wiki and the id. The line is the audit trail of the writes that touch no wiki row.

### Direct edits of non-request fields

The fields that no change request can affect:

| Field | Where | How the edit lands |
|---|---|---|
| Wiki description | `wikifact.json`, a new optional `description` key | A direct write through the registry, no restart. The key is the future.md row "A wiki description apart from the subject": a longer text that `listWikis` and the console show and that no question gets. The worker never reads it. |
| Wiki name | The wiki folder | A direct action through the registry: stop the worker child, move the folder, mount the new name, start the worker. The name rules are those of `createWiki` ([Management tools of the service](wikis.md#management-tools-of-the-service)). The MCP URL changes, and the answer says so. |
| Wiki subject, quality, question overrides, searchCap, agentSearchCap, relevanceFloor, weights, questionTimeout | `wikifact.json` | The form edits the keys as the file holds them: an absent key stays absent, so the preset keeps its role. The registry writes the file and restarts the worker child between requests, because the worker reads the config at start. |
| Wiki mode, embeddingModel | `wikifact.json` | Refused. A mode change changes the host rules and the transport. An embedding model change needs a reindex and a restart; it stays a hand step with the `reindex` command. |

Not edits of the console: every field of a fact. The console edits no fact ([Decisions](../design/console.md#decisions)). References and justification are output of the draft step and have no edit of their own.

### The `operatorEdit` request

A new `RequestKind.OperatorEdit` with value `operatorEdit`. The console enqueues a `change_requests` row of this kind with:

- `change`: a JSON document, validated by zod, that names the edit: `{ edit: "reindex" | "cleanup", note: string }` (`cleanup`: [Cleanup run: the backend of the operator action](console.md#cleanup-run-the-backend-of-the-operator-action)). The `note` is the operator's reason, 1 to 500 characters, required. A `reindex` job writes no `changes` row, because it changes no fact; its audit trail is the request row and a log line.
- `justification`: NULL, as on a `lookupRepair` row.
- `targets`: the ids the edit touches.

The worker takes it in queue order. It runs no model question. It builds the change set in code, applies it through `applyChange` with outcome `accepted`, a summary that states the edit, and `change_reasoning` = `Operator edit: <note>`. The `changes` row and the versions are the audit trail ([Operator edits in the queue](../design/console.md#operator-actions-in-the-queue)). A console page shows the request as any other, with the kind in words ("operator edit", [Plain words](../design/console.md#plain-words)) and the note of the document.

Why through the queue and not a direct write: [Operator edits in the queue](../design/console.md#operator-actions-in-the-queue). The test for every console write is whether the pipeline reads or writes the table. The table below applies it.

| Write | Tables | Does the worker care | Path |
|---|---|---|---|
| Reindex | The index tables | Yes. The pipeline writes them in its transaction. | Queue |
| Create, archive, unarchive a wiki | The files and the registry | The registry stops the worker first. | Registry, as today |
| Wiki name, description | The folder, `wikifact.json` | No. The worker never reads them. | Registry, direct; a rename restarts the worker because its paths change |
| Wiki config | `wikifact.json` | The worker reads it at start only. | Registry, with a worker restart between requests |
| Start of a cleanup run | `meta`, `change_requests` | Yes. The worker owns the cleanup state. | Queue |
| Pause and resume of the queue | `meta`, the key `queue_pause` | The worker reads the key between 2 requests and never writes it. | Direct: a queued pause waits behind the queue that it must stop |
| Start of a batch | `meta`, the key `batch_now` | The worker reads it at each poll and deletes it when it starts the batch. | Direct: the worker starts a batch at its next poll |

The cost of the queue is a delay of up to one request's duration, about 30 seconds, and the page shows the request as `queued` until then.

An invalid `change` document (an unknown kind or a missing note) ends the request as `done` with the outcome `rejected`, the reason `unsupported` and the validation message as `error`, on the first attempt, as a Q7 rejection does. The console validates the same rules before it sends, so a rejection here is a race with another change.

### Rules for the writes

- Every write route answers 403 unless the service runs in local mode on the loopback ([Authentication](console.md#authentication)).
- Every write route takes a form body, validated by zod. A queued edit redirects to the page of the new request. An action redirects to the page it changed. A refusal is a 409 error page with the reason.
- A preview page shows the exact edit before the POST. The exceptions are the pause and the resume of the queue, whose dialog states the exact effect and posts `confirm=1`, and "Run a batch now", which has no dialog. The pause and the resume are undone with 1 click, and a batch only runs earlier the work that the worker runs anyway ([Service health](#service-health)).

## Authentication

In local mode the service binds the loopback, and the console is as exposed as the MCP endpoint: to the processes of this user on this machine. The reads need no authentication. In local mode on the loopback, the writes need none either: the MCP endpoint beside the console already accepts `requestChange` and `createWiki` from any local process.

A form POST is a simple request that a browser sends from any site, so a page on another site could submit a console form to the loopback port from this machine's browser. Every console POST therefore checks its origin: a request whose `Sec-Fetch-Site` header is `cross-site`, or whose `Origin` header names another host or port than the service, is refused with 403. A request with neither header (a terminal client, an old browser) passes. This check holds in every mode and is not authentication ([Local edits only](../design/console.md#local-edits-only)).

In deployed mode, every write route answers 403 and the pages show no form (requirements/deployment.md, "Edits refused when deployed"). A bearer token that would open the writes in deployed mode is the future.md row "Authentication on the deployed HTTP mode", and it is not built.

## Code layout and build

```
src/console/        the route, the page handlers, the frame and helpers, the health rules, the style sheet, the write routes
src/console/client/ the browser script, one file, compiled by tsconfig.client.json
src/store/signals.ts, src/store/jobs.ts  the reads of Store API reads for the signals (console.md)
scripts/console-shots.mjs  the screenshots of every page and state of a running console, through playwright-core on the Edge or Chrome of the machine
__tests__/console-ui.test.ts  the browser test of Browser test (console.md), through the same playwright-core
```

- `npm run build` runs `tsc -p tsconfig.build.json` and then `tsc -p tsconfig.client.json`. The client config has `lib` `dom` and `es2022`, `module` `es2022`, no Node types, and emits `dist/src/console/client/console.js`, next to the server's own `dist/src/console/` modules, which is what the package ships. The server reads that file once at start, next to its own module, and serves it; when the file is absent (a run from source without a build), the route answers 404 and the pages work without the script.
- The style sheet is a TypeScript string constant.
- The console code follows the code standard: enums for the health verdict, the edit kinds, the list filters, the cell classes, `Signal`, `Span`, `InterpretationId` and `InterpretationStatus` in `src/domain/enums.ts`; JSDoc on every export; no `any`; zod on every query and every form body.
- Unit tests in `src/console/__tests__/` on an in-memory store. One end-to-end test in `__tests__/console.test.ts`.
- `npm run console:shots -- --base http://127.0.0.1:7777 --out reports/console-shots` writes 1 full-page PNG per page of [Pages](console.md#pages) at 1440 px wide, in the light and the dark scheme (`-dark` in the file name), plus the state shots of [Browser test](console.md#browser-test). `playwright-core` is a dev dependency and drives the Edge or Chrome of the machine (`--browser <path>` names another executable). The folder is ignored by git, because the shots show local paths.

## Visual design and interaction

The rules of the look and the behavior of every page. The style sheet of [Architecture](console.md#architecture) is the one place that holds the look; the script of [Architecture](console.md#architecture) is the one place that holds the behavior. A page module adds markup through the parts of [Parts](console.md#parts); it holds no style attribute, no color and no script. The class names of [Shell](console.md#shell) to [Charts](console.md#charts) are the contract between the sheet, the script and the pages: a page uses no class that this section does not name, and the sheet styles no class that no page uses.

### Principles

| # | Rule | Reason |
|---|---|---|
| V1 | One sheet, written by concern: tokens, base, shell, text, parts, forms, tables, charts, dialogs. | A rule that is written twice drifts. |
| V2 | Every color is a token on `:root`, with a dark value under `prefers-color-scheme: dark`. A rule names a token, never a hex value. | Light and dark stay in step. |
| V3 | A class name names one part. Two parts never share a class. | The old `.bar` rule of the confidence meter matched `nav.bar` and clipped the left bar. |
| V4 | The data is the loud thing. Chrome (lines, borders, backgrounds, headings) is one step off the surface. A panel has a hairline and no shadow. | The operator reads numbers and text. |
| V5 | The system sans everywhere. Numbers in a column use `font-variant-numeric: tabular-nums`; a stat value uses the default figures. | Columns align; a stat value does not look loose. |
| V6 | A chart is drawn in a viewBox whose width is about the width it renders at, so the text is 13 to 14 px on screen. | A chart drawn at 800 units in a 380 px column rendered its labels at 5 px. |
| V7 | A page works from 720 px to 1600 px wide: the grids collapse to one column under 900 px, the top bar wraps, a table scrolls inside its box, nothing is cut and nothing scrolls sideways but a table. | The operator opens a link from a chat on a narrow window. |
| V8 | A write form opens in a dialog from a button. The page reads first, acts second. Settings is the one page whose forms are open, because its job is the edit. | The fact page showed 2 forms under the history; a reader scrolled past them and a writer scrolled to them. |
| V9 | Each page has one type size for its primary text that is larger than the body: 18 px for a fact's content and the search box, 16 px for a result header and a quote. Everything else is body (15 px) or small (14 px). | A hierarchy with 2 steps reads; one with 6 steps does not. |
| V10 | Every interactive element shows a focus ring (`:focus-visible`, 2 px accent, 2 px offset), a hover state and, where it has one, a current state (`aria-current`). A button is a `button`; a link is an `a`. A control that needs the script is marked by a data attribute and is also reachable without it (a link to the same URL, a form that submits) except the dialogs. | Keyboard use and the browser test depend on it. |
| V11 | One pattern per job: a segmented control for a choice of 2 to 5 values that changes the page; a select for more values; a menu for a list of links; a dialog for a write; a fold for detail that is rarely needed; a chip for an applied filter. A job never has 2 patterns on the console. | The operator learns each pattern once. |

### Tokens

Spacing on a 4 px scale: 4, 8, 12, 16, 24, 32, 48. Radius 8 px for a panel, 6 px for a field and a button, 999 px for a pill. Type (the owner's verdict of October 16, 2026: it was too small): 14 px for small text (table text, labels, notes, stat lines); 13 px for the text of a pill (marker, chip, tooltip); 15 px for body; 16 px for the content of a result, a quote, a result header and a panel title; 18 px for a fact's content and the search box; 20 px for a page heading; 28 px for a stat value. Line height 1.5 for body, 1.3 for a heading and a stat value. Weight 600 for a heading, a stat value and a panel title; 500 for a tab and a button; 400 elsewhere.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--page` | `#f6f6f4` | `#111110` | the body |
| `--surface` | `#ffffff` | `#1b1b1a` | a panel, a field, a dialog, the top bar |
| `--surface-2` | `#efeeeb` | `#262624` | a table header, a code span, a table row on hover, a segmented control track, a menu item on hover |
| `--ink` | `#161614` | `#f0efec` | text |
| `--ink-2` | `#5c5b57` | `#b8b7ae` | a label, a note, a lead |
| `--muted` | `#8e8d87` | `#7f7e78` | an axis label, a placeholder, an empty state |
| `--line` | `#e4e3dd` | `#2d2d2b` | a hairline, a gridline |
| `--line-2` | `#c9c8c0` | `#3d3d3a` | an axis, a field border |
| `--accent` | `#2563eb` | `#5b8def` | a link, a primary button, the confidence meter, a focus ring, a current tab underline |
| `--accent-wash` | `rgba(37,99,235,0.10)` | `rgba(91,141,239,0.16)` | a current segment, a notice |
| `--good` | `#15803d` | `#34c26a` | the green level |
| `--warn` | `#b45309` | `#f2a93b` | the yellow level |
| `--bad` | `#b91c1c` | `#f06c6c` | the red level, a danger button, an error |
| `--good-wash`, `--warn-wash`, `--bad-wash` | the level color at 12 percent | the level color at 20 percent | a badge background, a marker, an `ins`, a `del` |
| `--s0` to `--s3` | `#2563eb`, `#ea580c`, `#0f9f6e`, `#ca8a04` | `#5b8def`, `#f97316`, `#2fbf87`, `#eab308` | the 4 series of a chart, in this fixed order |
| `--shade` | `rgba(0,0,0,0.35)` | `rgba(0,0,0,0.6)` | the backdrop of a dialog |

The series order is fixed and never cycles. A chart has at most 4 series. A level color never stands for a series, and a series color never stands for a level. A level always shows its word next to its color.

### Shell

The body is one column: the top bar, then `main`. `main` is 1200 px wide at most, centered, with a 32 px gutter (16 px under 900 px) and 48 px under its last block.

The top bar (`header.app`) is sticky at the top, 52 px high, on the surface color with a hairline under it, one flex row with 16 px gaps that wraps under 900 px: the brand (`a.brand`, 15 px, weight 600, ink); the wiki switcher (`details.menu.wiki`, its summary shows the wiki name with a chevron); the tabs (`nav.tabs > a`, 15 px, weight 500, `--ink-2`; the current one, `aria-current="page"`, in ink with a 2 px accent underline across the bar's bottom edge); and at the right (`div.end`) the status pill (`a.status`) and the "More" menu (`details.menu.more`).

The page header (`header.page`) has 24 px over it and 20 px under it: the heading (`h1`, 20 px) with its markers or badge inline; the lead (`p.lead`, 15 px, `--ink-2`, 4 px under the heading); the controls (`div.controls`) at the right, vertically centered on the heading, as a flex row with 8 px gaps. Under 900 px the controls wrap under the heading.

A section of a page is a panel ([Parts](console.md#parts)) or a plain section (`section.plain`) with an `h2` at 16 px, 32 px over it and 12 px under it. An `h2` may hold an aside (`span.aside`) at its right: a link or a segmented control at 14 px. A page shows no heading over one line of content.

The grid (`div.grid`): `cols-2` is 2 equal columns, `cols-3` is 3, `cols-2-1` is 2 columns in a 2 to 1 ratio, `cols-main-side` is a main column of `minmax(0, 1fr)` and a side column of 320 px; the gap is 16 px; every grid is one column under 900 px. A child spans the row with `span-all`. A cell that holds more than one block is a column (`div.col`, the blocks stacked with a 16 px gap), so the main column of a `cols-main-side` grid holds its panels in order and the side column holds its own.

### Parts

Every part is a function in `src/console/pages/parts/` that returns the markup below. A page composes parts; it writes no element of a part by hand.

| Part | Function | Markup and look |
|---|---|---|
| Stat row | `stats(items)` | `div.stats > a.stat` or `div.stat` (`a` when `href` is set): `.l` the label at 14 px `--ink-2` (a `span`; for a signal it holds a defined label); `span.n` the value at 28 px weight 600 (a stat with the optional `level` gives the number a second class `ok`, `warning` or `failing`, from `levelWord`, colored `--good`, `--warn`, `--bad`; a stat with no rule has none and stays in ink); `span.u` the line under it at 14 px `--muted`. A grid of fixed 240 px tracks from the start of the row, 32 px between columns, 16 px between rows: a stat is never stretched across the page. In a half-width panel (a cell of a `cols-2` grid, from 900 px) the tracks are 3 of at most 150 px with 24 px between columns, so that 3 stats fit across. The row has no border, no background and no hairline: a panel has 1 hairline, under its head. |
| Panel | `panel({ title, note?, aside?, span?, id? }, body)` | `section.panel`: the surface color, a hairline, 8 px radius, 16 px padding. `header.panel-head` with `h2` (16 px, weight 600) and `p.note` (14 px `--ink-2`, same line, after the title) and `span.aside` at the right, and a hairline under it (the only one of the panel). The aside adds no height to the head: it is centered on the line of the title, and a compact button or a segmented control in it stays inside the padding of the head, so a head with an aside and a head without one have the same height and 2 panels of a row line up ([Service health](#service-health)). A grid inside a panel body is top-aligned. `div.panel-body` under it. `span` adds `span-all`; `id` is the anchor of the panel. |
| Column | `column(blocks)` | `div.col`: the blocks of one grid cell, stacked with a 16 px gap ([Shell](console.md#shell)). |
| Empty state | `empty(text)` | `p.empty`: 15 px `--muted`, no padding, no border. |
| Note line | `note(text)` | `p.note`: 14 px `--ink-2`, under a chart or a list; one line of detail that is not a number of the stat row (L2). |
| Key-value list | `kv(rows)` | `dl.kv`: a 2-column grid, the term (`dt`) at 14 px `--ink-2` in a 140 px column (every key-value list, main or side), the value (`dd`) in body text; 6 px between rows. A `dd` may hold `code`. |
| Segmented control | `segmented(name, items)` | `nav.segmented[aria-label]`: an inline flex row on the surface-2 track, 6 px radius, 2 px padding; each item an `a` at 14 px weight 500 `--ink-2`, 4 px by 10 px padding, 4 px radius; the current one (`aria-current="true"`) on the surface color in ink with a hairline. Each item is a link to the URL with that value. |
| Toolbar | `toolbar({ fields, more?, applied?, hidden?, submit? })` | `form.toolbar[method=get][data-auto]`: a wrapping flex row, 8 px by 12 px gaps; `label.field`; a `details.more` ("More filters") with a second row of fields; the "Apply" button; `hidden` carries the sort and the status of a segmented control. `ul.applied` under it: 1 `a.chip.remove` per applied filter ("label: value ×"), a link to the URL without it. The script submits on a select or checkbox change. |
| Table | `table(headers, rows, opts?)` | `div.scroll > table`. `th` at 14 px weight 600 `--ink-2` on `--surface-2`, sticky; a sort header is `a` with `aria-sort` on the `th` and a `▲` or `▼` glyph. `td` at 14 px, 11 px by 12 px padding, a hairline under each row, `--surface-2` on hover. `td.num` right-aligned tabular, with its `th`. `td.key` 16 em minimum. `td.act` is the column of a row action (`act(cell)`; its header has no text, `""`): 96 px wide, right-aligned, with the compact button (4 px by 10 px padding, 14 px); the button of a page header is the default size. A table that stands alone on a page sits on the surface color in a bordered box. `td.wide` cuts at 26 em with an ellipsis. With 0 rows: `p.empty` with `opts.empty`, no table. `opts.count` renders `p.count` ("90 facts") over the table. |
| Paging | `paging(next)` | `nav.paging`: a right-aligned `a.button` "Next page" under the table; nothing when there is no next page. |
| Result list | `results(items)` | `ol.results`: 760 px wide at most; `li.result` with 16 px padding, a hairline between items: `h3` (16 px weight 600, the header link, the markers after it), `p.content` (16 px), `div.meta` (14 px: the chips, the meter). |
| Timeline | `timeline(entries)` | `ol.timeline`: a 2 px rail in `--line` at the left; `li.entry` with 20 px left padding and a 10 px dot on the rail in `--line-2` (`--accent` on the current version); `div.when` (14 px: the time link with the seq in its `title`, the markers), `p.what` (body: the summary), and an optional `details.fold` (the entry gives its summary and body), open when the entry says so (`open`). |
| Defined label | `definedLabel(signal, label)` | `span.defined`: the label as plain text at 14 px `--ink-2` with a 1 px dotted underline in `--line-2` (offset 3 px) and `cursor: help`: it looks like a label, not a link or a button. The hidden text is `span.sr-only` (1 px, clipped). A stat or a chart caption takes it as its label when it has a `signal`. |
| Verdict list | `verdicts(lines, flush?)` | The status line of Service health, the only use: `ul.interps` of `li.interp` holding a `p.reading`, a 2-column grid (14 px info mark, the sentence) at 14 px `--ink-2`, with no word at the end: a line is a rule over the health rows, not an assumption. Each line takes its level as a class (`green`, `yellow`, `red`): `yellow` is in `--warn`, `red` in `--bad`. `flush` drops the hairline and the margin, for the line under the page header. |
| Menu | `menu({ label, cls }, items)` | `details.menu`: `summary` as a default button with a chevron; `div.menu-list` absolutely under it, on the surface color, a hairline, 8 px radius, 4 px padding, 200 px wide at least; each item `a` at 15 px, 6 px by 12 px padding, the surface-2 color on hover, `aria-current` on the current one; a `hr` between groups; a `p.muted` as the last line. The script closes it on an outside click and on Escape ([Interactions](console.md#interactions)). |
| Status pill | `statusPill(level, text, title, href)` | `a.status.green`, `.yellow`, `.red`: a pill at 14 px with a dot, on the level wash, in ink. |
| Dialog action | `dialogAction({ id, label, title?, danger? }, body)` | Returns `{ button, dialog }`. `button[data-dialog=id]` (default or `danger`); several buttons may name the same dialog; `dialog.sheet#id[aria-labelledby]` (named by its `h2`, so a reader and a test find it by the role `dialog` and its name) holding `form.action` with `h2` as the title (`title`, else `label`), the fields, and `div.buttons` with the primary submit and a `button[formmethod=dialog]` "Cancel". 480 px wide, 24 px padding, 8 px radius, on the surface color over `--shade`. The page puts the dialog at the end of `main`. |
| Badge | `levelBadge(level)` | `span.badge.green`, `.yellow`, `.red`: a pill at 14 px: an 8 px dot in the level color, the level word (`levelWord`: `ok`, `warning`, `failing`), the level wash. The status pill reads the same words. |
| Filter field | `filterField(name, placeholder, value)` | `label.field` around an `input` with the placeholder and an `aria-label` of the same text, and no visible label. |
| Result marker | `resultMarker(status, outcome, reason)` | 1 marker: the outcome marker of a done request that has an outcome, else the status marker (`failing` for a failed request). |
| Marker | `marker(text, cls)` | A pill at 13 px: `marker` (the bad wash) for deleted, deletion, failed and rejected; `marker.live` (the good wash) for live, revival, observed, done and accepted; `marker.derived` (the surface-2 color) for derived, old version, queued, running and duplicate. |
| Confidence meter | `meter(confidence)` | `span.meter`: the number at 14 px tabular, then a 72 px by 6 px track in `--line` with the accent fill. |
| Quote | `quote(text, label?)` | `blockquote.quote`: 16 px, a 3 px accent left border, 12 px left padding, in ink; `p.label` (14 px `--ink-2`) over it when labeled. |
| Notice | `notice(text, bad?)` | `p.notice`, `p.notice.bad`: a box with the accent wash and a 4 px accent left border; with `bad`, the bad wash and border. |
| Fold | `fold(summary, body, open?)` | `details.fold`: the summary at 14 px `--ink-2` with a chevron that turns when open; the body with 8 px over it; closed on load unless `open`. |
| Diff | `ins`, `del` | The good wash under an insert, the bad wash and a strike under a delete. |
| Link button | `a.button` | The look of a default button. |
| Form fields | `label.field`, `input`, `select`, `textarea`, `button`, `button.primary`, `button.danger`, `p.help` | Every field of a GET form (`parts/fields.ts`) and of a POST form (`forms.ts`) is a `label.field`. A radio choice (`radioChoice(name, value, label, { help, checked })`, `parts/fields.ts`) is a `label.field.choice`: the radio left of its label on one row, the help under the label in the label's column. A page writes no `label` by hand. A field has a 1 px `--line-2` border, 6 px radius, 6 px by 10 px padding, the accent border on focus. `primary` has the accent background and white text. `danger` has the bad color as text and border. A write form has 1 primary button. |
| Search box | `input.search[data-search]` | 18 px, full width, 10 px by 12 px by 10 px by 40 px padding, a magnifier glyph at the left. |
| Tooltip | `div.tooltip` | The script's chart tooltip: ink on the surface color, a hairline, 6 px radius, 13 px, 6 px by 8 px padding; multi-line. |
| Chart | `plot(caption, body, signal?)` | `figure.plot` has no box of its own inside a panel: the caption (`figcaption.l`, 14 px `--ink-2`, the style of a stat label; with a `signal`, a defined label) over the drawing. |

### Interactions

The script of [Architecture](console.md#architecture) holds every behavior below. Each is keyed by a data attribute or a part class, is delegated on the document so a refresh of `main` needs no rebinding, and inserts the server's HTML only. The script imports nothing and stores nothing.

| Behavior | Key | Rule |
|---|---|---|
| Refresh in place | `main[data-refresh=N]` | Every N seconds: fetch the page, replace the content of `main`, keep the scroll. Skipped while a field in `main` has the focus or a value that differs from its default, a dialog is open, or a menu is open. |
| Definition tooltip | `[data-definition]` | On pointer over or focus of a label, or of a number with a reading (its sentence is in `data-definition`), show the tooltip with the definition (at most 360 px wide, wrapping), next to the cursor or under the focused label, and hold the `title` off the element so the browser shows no second tooltip; put it back on pointer out or blur. |
| Chart tooltip | `svg.chart` marks with a `title` | On pointer over a mark, show the tooltip with the title text next to the cursor and hold the `title` element off the mark, so the browser shows no second tooltip; put it back on pointer out. A column slot of a line or stacked chart has an invisible hit rect over its whole height whose title lists the label and every series value, one per line, so the whole day is one tooltip; the slot shows a crosshair line on hover (CSS). |
| Search key | `[data-search]` | `/` outside a field focuses and selects the box. Escape in the box clears it when it has text, and blurs it when it is empty. |
| Auto-apply | `form[data-auto]` | A change of a select or a checkbox submits the form. A text field submits on Enter, natively. |
| Menu | `details.menu` | A click outside an open menu closes it. Escape closes it and returns the focus to its summary. Opening one menu closes the others. |
| Dialog | `button[data-dialog=id]` | The click opens `dialog#id` with `showModal`, so Escape closes it and the focus goes to its first field. The Cancel button closes it through `formmethod=dialog`. A dialog that closes returns the focus to its button. |

Without the script: the refresh, the tooltip, the key and the menu-close rules are absent; the menus, the folds and the segmented controls work natively; the toolbar applies through its button; the dialogs do not open. The console serves the script on every page, so the no-script case is the fallback for a failed load only.

### Charts

A chart keeps 3 kinds of `charts.ts`: a line chart, stacked bars and a histogram. The viewBox width is the width of the column the chart sits in (V6), given by the page as `width` from the fixed set of `charts.ts`: 1120 units for a full-width panel, 740 for the main column of a 2 to 1 grid, 560 for a column of a 2-column grid, 360 for a column of a 3-column grid; the plot is 160 high, the text 13 units.

| Mark | Rule |
|---|---|
| Line | 2 units, round joins and caps, the series color. |
| Point | Radius 3, the series color, a 2 unit ring in the surface color. Drawn when the axis has 31 labels or fewer; a longer axis draws lines only. |
| Bar and histogram bar | At most 24 units wide inside its slot at the 560 width (the cap scales with the width, so a bar renders at the same size on screen), a 3 unit rounded top, square at the baseline; a 2 unit gap in the surface color between the segments of a stack and between adjacent bars. |
| Slot | `g.slot` over each x position of a line or stacked chart: `line.cursor` from the plot top to the axis, hidden until hover; `rect.hit` over the slot's width and the plot's height, transparent, with the `title` of the position: the label and every series value, or the text that the page gives in `tips` (the stage chart names the search count, the additions and the corrections). A histogram bar's `title` is the name, the label, the value and the optional `detail` (the share of the searches). |
| Grid | 2 lines, solid, 1 unit, `--line`; the axis in `--line-2`. Never dashed. |
| Y axis | 3 labels: 0, the middle and the top. The top is the smallest of 1, 2, 4, 6, 8 and 10 times a power of 10 that is at or over the largest value, so the middle is a whole number too when the top is 2 or more. |
| X axis | Up to 5 labels on a dense axis: the first, the last and up to 3 between. A label that would sit within half a step of the last is dropped, so the last 2 never overlap. The page gives each label as a string: a date is `MM-DD`, an hour is `HH:00`, and a count of searches is the count itself. A page may name the labels to show with the option `labelIndexes` (the stage chart: round numbers). |
| Axis titles | The options `xTitle` and `yTitle`, on all 3 kinds of chart, in 13 px `--ink-2` (`g.axis-title`). The x title (`text.x-title`) is centered under the axis labels, in 18 extra units of height that a chart without an x title does not have. The y title (`text.y-title`) is rotated by -90 degrees at the left; the plot starts 56 units from the left edge to make room for it. A chart without titles draws none. |
| Legend | For 2 or more series only, in `--ink-2`, a 10 unit swatch with 4 units gap, in the series order. |
| Empty | When every value is 0 or null, the chart is the empty state sentence of L3 ("No call since the service started.") in place of the drawing, and no axis is drawn. |
| Reference line | A horizontal line at a given value in `--line-2`, 1 unit, solid, and its label (for example "100 ms") in `--ink-2` above the plot at the right end, after a short sample of the line (in `--line-2`, like the line), where no point can cover it. It is not a series and not in the legend. Service health draws `SEARCH_BAR_MS` with it. |
| Capped axis | The option `capMultiple` of `lineChart` (Service health sets 2 for the search time): the top of the axis is `niceTop` of the larger of the reference value and `capMultiple` times the median of the non-null values of all series. A value over that top is clipped: the point and the vertex of the line sit on the top edge, and a `g.clipped` holds a triangle and the true value (`fmt`) in `--ink`, beside it (at its left when the point is in the right half). The tooltip keeps the true value. With no value over the top nothing changes. The value labels never overlap (#49): the chart places them from left to right, and each label takes the first row, counted down from the top edge, in which its box does not touch the box of a label already placed. A row is 1 line of the label font lower. The width of a box is the count of its characters times the average character width of the label font, plus 4 px of space on each side. The triangle of each clipped point is a box in row 0 too (its own width plus the same space), placed before the labels; a label does not test the triangle of its own point. The text of a label has a halo in the background color of the card (`paint-order: stroke`), so a line of the chart that passes under it does not cut the digits. |
| Null point | A line chart draws no point and no segment to or from a null value. A histogram bar of 0 is a flat bar. |
| Text | Always a text token, never a series color. |

### Browser test

The interactions of [Interactions](console.md#interactions) and the layout rules of V7 and V10 are proved in a real browser. `__tests__/console-ui.test.ts` compiles the browser script into a temporary folder, starts the console in the test process (`startHttpServer(consoleRoute(registryDeps(registry), { scriptFile }))` on a registry over a seeded temporary wikis folder), and drives a headless Chromium through `playwright-core` on the Edge or Chrome of the machine. It is skipped with a named reason when neither is installed. `npm run test:ui` (`vitest.ui.config.ts`) runs it, and `npm run check` runs it beside the unit tests. It checks:

| Case | Proof |
|---|---|
| Shell | Every page of [Pages](console.md#pages) answers 200 with the top bar, the current tab marked, and no horizontal scroll at 1440 px and at 720 px (`document.documentElement.scrollWidth <= innerWidth`). The 3 tabs are Overview, Service health and Jobs. |
| Wiki switcher and More menu | A click opens the menu. A click outside closes it. Escape closes it and the focus is on the summary. Opening the other menu closes the first. The More menu holds Search, Requests, Settings and Export. |
| Status pill | It links to Operation and its text is "ok" on the seeded wiki. |
| Span control | A click on "All" loads the page with `?span=all`, the segment is current, and the 3 blocks show. The blocks are, in order, "Search quality", "Wiki growth" and "Cost". |
| Definition | A hover over a signal label shows `div.tooltip` with its definition (at most 360 px wide), and Tab to the label shows it too. |
| Stable gutter | The x position of the brand link is the same on a short page (Jobs) and a tall page that scrolls (Overview): the style sheet has `scrollbar-gutter: stable` on `html`. |
| Layout | A stat is 180 to 280 px wide and starts at the left of its row, a stat row has no hairline, a panel head has 1 hairline, a key column is 140 px, and the row buttons of Jobs are compact and align. |
| Search | `/` focuses the box. Typing and Enter loads `?q=`. The result list shows the seeded fact's content. Escape clears the box. "Random sample" shows 10 or fewer results. The page has no "show ranking" control. |
| Toolbar | A change of the outcome select on Requests loads the page with `?outcome=` and shows the applied chip. A click on the link of the chip removes the filter. |
| Sort | A click on a column header of Requests sets `aria-sort` and the URL. |
| Dialog | "Run" on a Jobs row opens the dialog, the first field has the focus, Escape closes it and the focus returns to the button. Cancel closes it. The 2 buttons of the head of "Queue worker, now" fit in the line height of the title, at the wide and the phone width. |
| Fold | "Diff and reasoning" on a history entry opens the diff. |
| Tooltip | A hover over a slot of the stage chart shows `div.tooltip` with the lines of the point. A hover over a slot of the calls chart on Service health shows the lines of the hour. A move out hides it. |
| Refresh | On Requests with `?status=queued`, a typed character in the text field holds the refresh: after 16 seconds the field still holds the text. |
| Focus ring | Tab from the body lands on the brand link, then the wiki switcher. The focused element has a visible outline (`getComputedStyle(el).outlineStyle !== "none"`). |

`npm run console:shots` takes the screenshots through the same `playwright-core`, full page, at 1440 px, in the light and the dark scheme, and in addition one shot of each open menu, an open dialog and a chart tooltip, so a visual change comes with the pictures of its states.

## Cleanup run: the backend of the operator action

The cleanup has one operator action ([Cleanup](cleanup.md)), and this section gives its backend call. The `cleanup` row has a page action: "Run" on [Jobs](console.md#jobs) for the full run. It follows [Rules for the writes](console.md#rules-for-the-writes): a dialog with the note, a preview of the exact document, `confirm=1` queues the `operatorEdit` request, a 303 to the request page, one `console_action` log line, and the origin and mode checks of every POST. The route is `POST /console/w/:w/jobs/cleanup`. The table has no other row; when a page gets an action, its text goes into [Pages](console.md#pages).

| Action | What the operator does | Backend call |
|---|---|---|
| Run the cleanup now | Starts the duplicate-fact check of the cleanup at once, also when its interval has not passed. | `operatorEdit` document `{ edit: "cleanup", note }`. Writes `meta.cleanup_seq` and `meta.cleanup_full`. |

The results of a cleanup are `cleanupRepair` requests and their `changes` rows. The request and change views show them as any other request, with the kind in words ("cleanup", [Plain words](../design/console.md#plain-words)) and the document in words with links ([Request](console.md#request)). A verdict with no change writes no `changes` row; the request row shows that it finished with no write.

