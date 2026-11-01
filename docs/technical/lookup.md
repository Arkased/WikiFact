# Look up facts

Technical layer. The requirements are in [../requirements/lookup.md](../requirements/lookup.md). The design is in [../design/lookup.md](../design/lookup.md).

## MCP tool contracts

Ids are ULID strings. Timestamps are unix milliseconds. The MCP server validates input with Zod and returns structured content.

### `search`

The query is a phrase of terms or a claim, as a fact would read: "creeper explosion damage", "Q1 model in the standard preset". It is not a question. The embedding and the full-text index match the words of a fact, and a question adds words no fact holds. The tool description says so to the consumer, and the relevance eval of [Tests](#tests) measures that form. A question still works through the stopword rule and the vector half, but it is the tolerance case, not the design.

```ts
// input
{ query: string }   // max length: the input window of the embedding model (O4), 512 tokens for the default, counted with its tokenizer

// output
{
  searchId: string;       // the id of this search (a ULID); `requestChange` takes it as `searchId`
  results: Array<{ kind: "fact"; id: string; ref: string; header: string; confidence: number; score: number }>;  // facts only
  note: string;           // RESULT_NOTE; EMPTY_NOTE when results is empty
}
```

`ref` is an id that this search minted for this result (a ULID, the `search_results.ref` column, unique over the wiki). `getFact` takes it, and the read then names this search ([Minted ids](../design/lookup.md#search-log-and-sessions)). The tool text of `search` says: "Open a result with `getFact` by its `ref`. When you send a change about this search, pass its `searchId`."

`note` is on the structured content and on the text content. `RESULT_NOTE` is "Before you finish: send what you observed that the wiki lacks or gets wrong with requestChange, one claim per request, with how you know." `EMPTY_NOTE` is "No fact matches. When you find the answer elsewhere, send it with requestChange so the next agent finds it here." Both constants are in `src/mcp/instructions.ts` ([When to submit](../design/submit.md#when-to-submit)).

`search`, `getFact` and `requestChange` carry `_meta: { "anthropic/alwaysLoad": true }` in the `tools/list` result (`ALWAYS_LOAD_META` in `src/mcp/tools.ts`, passed to `registerTool`), on the wiki endpoint and on the management endpoint; no other tool carries `_meta`. Claude Code defers the tools without it.

A query longer than the embedding window is rejected with an error that states the limit.

The result count is `searchCap` in `wikifact.json` ([O7](README.md#open-settings)). The consumer cannot raise it, because result size is a lever over consumers ([Consumer correction duty](updates.md#consumer-correction-duty)).

### `getFact`

```ts
// input
{ ref: string } | { id: string }   // exactly 1 of the 2. `ref`: the id of a result of a search (preferred). `id`: a fact id from inside a fact or from a request; the read then links to no search. Both or neither is a tool error

// output
{
  id: string;
  isDeleted: boolean;
  confidence: number;     // 0..1
  current: FactVersion;
  note: string;           // RESULT_NOTE, as in `search`
}

type FactVersion = {
  seq: number;
  header: string;
  content: string;
  justification: string;
  references: string[];   // ids of the facts this fact version depends on
  changeReasoning: string;
  isDeleted: boolean;
  created: number;
}
```

The consumer sees the current fact version only. A deleted fact comes back with `isDeleted: true`, confidence 0, and the deletion as its current fact version, with the justification for the deletion.

A call on a live fact records one `retrievals` row. A call on a deleted fact records nothing. The confidence in the answer is computed before the row is recorded, so the call does not count its own read.

Every rejection in this section is a tool error result (`isError: true`), not a protocol error, so the calling model can read the reason. An unknown id in `getFact` is a rejection.

### Server instructions

Every MCP server sends `instructions` on connect (the second argument of `McpServer`), as [../design/lookup.md](../design/lookup.md), "When to search" and [../design/submit.md](../design/submit.md), "When to submit" say. The code is `src/mcp/instructions.ts`.

- A wiki endpoint (`createServer`) sends the name and the subject of its wiki (`config.subject`; the name is the mounted name, `wikifact` for a single-wiki server), then `SEARCH_TRIGGER` and `CORRECTION_DUTY`. A wiki with no subject sends no subject. A subject that would push the text past `INSTRUCTIONS_CAP` is cut and ends with an ellipsis, so the triggers always arrive whole.
- The management endpoint (`createManagementServer`) sends one line per mounted wiki (name and subject), then the 2 triggers. The server is built per request, so the list is current at connect time. The text is at most `INSTRUCTIONS_CAP` (4,096) characters, the point where Claude Code cuts. It names as many wikis as fit, then says how many more there are and points to `listWikis`.
- The text of each trigger lives once, in the 2 constants of `src/mcp/instructions.ts`. `CORRECTION_DUTY` is "Before you finish your task, send what you observed that the wiki lacks or gets wrong with the `requestChange` tool: what you saw, and how you know." It is the last sentence of the instructions and the last sentence of the descriptions of `search` and `getFact`, on both endpoints; the `search` description starts with `SEARCH_TRIGGER`.
- The instructions are sent over MCP only: a consumer needs no hook and no setup. A subagent gets no instructions, so the triggers also travel in the tool definitions and the tool results ([MCP tool contracts](#mcp-tool-contracts)). `registryInstructions` in `src/mcp/management.ts` builds the text of the management endpoint from the mounted entries.


## Retrieval pipeline

`search(query)`:

1. Embed the query. For FTS5, split the query on whitespace, drop the English stopwords (the `stopword` package's list: "how", "the", "a", "can" and the like), quote each token, and join the tokens with `OR`, so that `-`, `"`, `*` and `AND` in the text are not read as syntax, and so that one matching term is enough to enter the list. BM25 ranks a row with more matching terms higher. When every token is a stopword, the FTS lists are empty and the vector lists carry the query. The first wiki showed that a query joined with `AND` matched nothing on 7 of 8 natural questions, and that without the stopword rule the function words of a question pull unrelated rows into the list.
2. FTS5 over `fact_versions_fts`, joined to `current_fact_versions`, live only. Top `K = 50` by BM25.
3. KNN over `current_vec` on the 1-bit column. Take `VEC_CANDIDATES = 100` rows, compute the exact distance on `full`, and keep the best `K` with their cosine distance. The table holds only live current versions, so no join or filter follows. [O8](README.md#open-settings) sets `VEC_CANDIDATES`.
4. Merge the 2 lists with Reciprocal Rank Fusion: `rrf(fact) = sum over lists of 1 / (60 + rank)`. Rank starts at 1.
5. Relevance floor: a fact passes when its cosine distance is at most `relevanceFloor` (config, default 0.31), or when its FTS row matches at least 2 distinct query terms (counted with the FTS5 `highlight` function), or when the query has 1 term and the row matches it. Every other hit is dropped. A row that entered the FTS list on 1 common word out of several ("fact" in "how many words can a fact have") does not pass on that alone. A query the wiki cannot answer then most often returns no fact, or only facts close in meaning, instead of 10 unrelated hits. The first wiki put the right facts at 0.19 to 0.28 and the best hit of an unanswerable query at 0.34, so the margin is thin, and the relevance eval of [Tests](#tests) guards it with a share: at least `NO_ANSWER_SHARE` of its unanswerable cases pass. On the dogfood wiki some queries still return unrelated facts that share common words; the owner accepted that, because an unrelated header costs the consumer 1 call.
6. `score = rrf * clamp(1 + W_USE * (usefulness - mean usefulness), 1 - USE_BOUND, 1 + USE_BOUND)` for each fact ([Usefulness](lookup.md#usefulness)), with `USE_BOUND = 0.1`. The boost reorders results of near-equal relevance and cannot lift a fact over one that ranks far above it. An additive boost did: one read, 0.01, was 5 times the whole spread of a 50-result list, so a fact that was read once topped every query of the first wiki.
7. Sort the facts. Cut to `searchCap` or `agentSearchCap`. Return headers and the score.

With `includeHistory` set, step 2 searches the whole `fact_versions` table and step 3 reads `fact_versions_vec`, which holds every version. The hits collapse to one entry per fact before the cut, and the entry names the version from the list where the fact ranked best.

The 512-token check of [search](lookup.md#search) lives in the MCP server, not in `search`. The query goes to the embedding model as it is, with no instruction prefix. The quoted tokens joined by spaces mean that FTS5 requires every token, so the FTS half returns nothing for a long query and the vector half carries it. The replay test decides whether the prefix or the join rule must change ([O4](README.md#open-settings)).

## Scores

Both scores are computed at read time, and nothing is stored. Both use the same decay function: `decay(t) = 2 ^ ( -(now - t) / HALF_LIFE )`.

### Confidence

For the current fact version `v` of a fact:

```
S = W_UPDATE  * decay(v.created_at)
  + W_CONFIRM * sum over r in retrievals(v, kind = confirm) of weight * decay(r.at)
  + W_READ    * sum over r in retrievals(v, kind = read)    of weight * decay(r.at)
confidence = 1 - 2 ^ (-S)
```

The events:

| Event | What it is | Counts on |
|---|---|---|
| Update | The creation of an observed version: one whose `content` or `is_deleted` differs from the version before it, and whose `justification` is not empty. Someone looked at reality and said what they saw. A deletion and a revival both count, even when the revival carries the old content. | `v.created_at` |
| Confirm | A duplicate submission. The submitter looked at reality and saw the same claim. The same evidence as an update, with no write. | `r.at` |
| Read | A consumer call to `getFact`. | `r.at` |

Which version is `v`:

| Version | Effect on confidence |
|---|---|
| An observed version. | It is `v`. Its creation is the update event. Events on older versions do not count. |
| A version that changes only references, header or justification. | Not `v`. It carries the prior events forward. A maintenance write ([Cleanup](cleanup.md#cleanup)) does not reset confidence. |
| A version with an empty justification. The pipeline derived it from the facts it references ([Pipeline](updates.md#pipeline), steps 7 and 9), and nobody looked. | Not `v`. It carries the prior events forward. A dependent rewrite ([Dependents loop](updates.md#dependents-loop)) does not reset confidence. |
| The current version is a deletion. | Confidence is 0. |

So `v` is the newest observed version of the fact, and the retrievals of it and of every version since then count. The first version of a fact is observed when its justification is not empty.

A fact with no observed version at all, such as the equivalence fact from a lookup repair ([Step 9. Prior query check](updates.md#step-9-prior-query-check)), has no `v`. Its confidence is the lowest confidence among the facts in its current `references`. The evidence sits on those facts, and this rule reads it from there. A deleted reference counts as 0. A fact with no observed version and no references has confidence 0. A cycle in the references skips the facts already visited.

Start values ([O1](README.md#open-settings)): `W_UPDATE = 1.0`, `W_CONFIRM = 1.0`, `W_READ = 0`, `HALF_LIFE_CONF = 30 days`. `W_READ` is 0 until the correction test shows that consumers correct the facts they read. Until then, an uncorrected read is not a signal ([Confidence](../design/lookup.md#confidence)).

### Usefulness

For a fact, over all its fact versions and both event kinds:

```
usefulness = sum over r in retrievals(f) of weight * decay(r.at)
```

Start values ([O2](README.md#open-settings)): `HALF_LIFE_USE = 30 days`, `W_USE = 0.01`, `USE_BOUND = 0.1`. At 0.05 one read still swapped 2 facts of near-equal relevance in the relevance eval; at 0.01 it did not. The usefulness enters the rank as a bounded multiplier ([Retrieval pipeline](lookup.md#retrieval-pipeline), step 8), never as an added term, so a read cannot lift a fact over a far more relevant one. The mean usefulness is over the facts of the result list, not the whole wiki, so an unread wiki and a busy wiki get the same treatment.

### Cost

A `search` fetches the retrieval rows for the merged candidate set in one query. The retrieval tables grow without bound.

A nightly fold job will bound them after the correction test has set the half-life. The fold is exact, because the decay is exponential: rows older than a cutoff `T0` collapse into one row at `T0` with their summed weight. A future feature ([future.md](../future.md)).

## Tests

Design: [How the feature is measured](../design/lookup.md#how-the-feature-is-measured). The command `npm run eval:all` runs these tests with the others ([System evaluation](evaluation.md)).

| Test | Requirement | Method | Pass condition |
|---|---|---|---|
| Relevance | AI agents add, correct and delete facts | `eval/relevance.ts` seeds the replay seed plus the facts of `eval/relevance.json`, with the real embedder, and runs its queries in the designed form of [search](#search), a phrase of terms or a claim, with the expected top fact, plus 2 question-form queries as a tolerance group and queries the seed cannot answer (`expectNone: true`, with an optional `allowNear`: the labeled fact headers that an agent with that question could fairly open, each case giving its reason in `note`). It records some facts first, so the usefulness boost is in play. Writes a result file. | Every terms query has its fact in the top 3 and at least 90 percent at rank 1; every question query is in the top 3; at least 80 percent of the unanswerable queries (`NO_ANSWER_SHARE`) return an empty list or only results in their `allowNear` (a result outside it fails the case); the report keeps the count and the ids of the failed cases. The first wiki's 8 probes are the first cases. A change to [Retrieval pipeline](#retrieval-pipeline) runs this before the speed test. |
| Speed | A lookup is fast | `eval/speed.ts` seeds N synthetic facts, runs 200 queries on a quiet machine of the class below, embedding included, reports p50 and p95. N in {1k, 10k, 100k}. | p95 under 50 ms at 100k without the query embedding, and under 100 ms with it. The float index of [Index tables](storage.md#index-tables) failed this (p95 241 ms at 100k), and the 1-bit index replaced it: p50 35 ms, p95 76 ms with the embedding, on Windows 10, Node 24, 12 cores, CPU only. The query embedding alone is 20 to 30 ms at p95. |

## Search log and sessions

Design: [Search log and sessions](../design/lookup.md#search-log-and-sessions). The tables are in [Tables](storage.md#tables).

### What the tools write

- `search` writes 1 `searches` row and 1 `search_results` row per result, in 1 transaction on the write connection of the MCP server. The transaction holds no other write. The row has the session id of the call, the query, the time, the duration of the search in ms and the count of results. Each `search_results` row has its minted `ref` (a ULID, schema 10), which the result carries to the consumer. When that write fails (the error line is logged, as before), the result carries no `searchId` and no `ref` fields: the consumer reads by `id`, and nothing points at ids that no row holds. A call with no session writes `session_id` NULL. A search that returns no result writes the `searches` row with `result_count` 0 and no `search_results` row.
- The search of the console writes no `searches` row, no `search_results` row and no `sessions` row. The console calls `search` of the store on a read-only connection ([Reads not counted](../design/console.md#reads-not-counted)).
- `getFact` writes the `retrievals` row as before, with the `ref` of the call in `ref` (schema 10) when the call came by `ref`, and NULL when it came by `id`. A deleted fact writes no row, as before. A `ref` that no search minted is a tool error ("no result has this ref; search again"). A `ref` resolves to its `kind` and `target_id`. 
- The session row comes from the transport ([Service mode](deployment.md#service-mode)): the wiki endpoint inserts it at the `initialize` request, and each tool call adds 1 to `call_count` and sets `last_call_at`. The management endpoint inserts it in a wiki on the first call of the session that names the wiki, with the same session id in every wiki ([MCP sessions](deployment.md#mcp-sessions)). The session id links nothing to a search, and no page counts it.

### The link of a read to its search

A read links to the search that minted its `ref`: `search_results.ref` is unique, and the row names the search. A read with a NULL `ref` (a read by `id`) is an unlinked read: it counts in no distribution of reads per search. A submission links to the search of its `searchId` (`change_requests.search_id`, schema 10), and a submission with NULL links to no search. No link is computed from time or from the session.

### Cost

A `search` adds 1 insert for the `searches` row and 1 insert for each result. `searchCap` bounds the results of 1 search ([O7](README.md#open-settings)), so a search adds at most `searchCap + 1` inserts. The log has no bound. The bound is a future feature, with the fold of the retrieval rows ([Cost](lookup.md#cost), [future.md](../future.md)).

### Store functions

Each function takes the store and a `span`. `span` is `{ lastSearches: 200 } | "all"`. With `{ lastSearches: N }`, the span holds the last `N` searches by id, and the sessions and the change requests that fall between the first and the last of these searches in time. With `"all"`, the span holds every row. The functions read through a read-only connection and write nothing.

| Function | Reads | Returns |
|---|---|---|
| `searchSignals(store, span)` | `searches`, `change_requests`, `changes` | The count of searches, the count of change requests, and the count of change requests with the outcome `duplicate` and of those that ended, for the span. |
| `readsPerSearch(store, span)` | `searches`, `search_results`, `retrievals` | For each search of the span, the count of reads that link to it. The result holds the count of searches with no result (`result_count` 0), and over the searches with results the count with 0, 1, 2, and 3 or more reads. |
| `sessionsSignals(store, span)` | `sessions`, `searches` | The count of sessions, the count of searches, and the count of sessions with no search, for the span. |
| `searchAndLog(store, query, opts)` | `fact_versions` (the search); writes `searches`, `search_results` | Runs a consumer search and logs it with a minted `searchId` and 1 minted `ref` per result. The one function that mints the ids and writes the log: the `search` tool calls it (with its read connection as `readStore`), and so do the harnesses (the replay eval, the test helpers) that send a real `searchId` with a submission. Returns the hits with their `ref` and the `searchId`; when the log write fails it returns the hits with no `ref` and no `searchId`, plus the error (`strict` throws it instead). Not a read: it writes. |
| `resolveRef(store, ref)` | `search_results` | The search, the kind and the target id that the `ref` names; undefined when no search minted it. `getFact` uses it. |
| `getSearchQuery(store, searchId)` | `searches` | The `query` of the search; undefined when no search has this id. The lookup repair uses it for the prior query. |

The functions apply [the link rule](lookup.md#the-link-of-a-read-to-its-search) to every read. The console cites them in [Where is the wiki](console.md).

