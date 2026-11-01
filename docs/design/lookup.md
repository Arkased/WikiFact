# Look up facts

Design layer. The requirements are in [../requirements/lookup.md](../requirements/lookup.md). The technical details are in [../technical/lookup.md](../technical/lookup.md).

## Approach

A lookup has 2 steps: a search that returns short results, then a read of the result that the consumer chooses. The search is deterministic: the consumer writes the query, and no model takes part. The read returns 1 fact in full.

The 2 steps exist for 2 reasons:

1. The consumer reads a short list fast, and opens only what it needs.
2. The read of a fact is a choice of the consumer, so the wiki can count it. The search result is a choice of the search engine, so it does not count. If it counted, the rank would feed itself: a fact high in the list would get more counts and rise higher.

## How the design meets each requirement

### Search speed

The index and the facts are in 1 SQLite file per wiki, read in the process of the service, with no network call. The embedding model also runs in the process. The vector search reads a 1-bit copy of each vector first, which is fast, and then computes the exact distance on the best candidates only. A float index of the same size failed the bar at 100,000 facts, and the 1-bit index passed it.

### Key-word search, Question search

The search combines 2 methods, because each one finds what the other misses:

- A full-text search finds the exact words: names of functions, files, settings, error texts.
- A vector search finds the meaning when the words differ: "skellie" and "skeleton".

The 2 result lists merge by rank (reciprocal rank fusion), so neither score scale dominates. The design form of a query is a phrase of key words, as a fact would read. A question also works, because the full-text search drops the common question words ("how", "the", "can"), and the vector search reads the rest.

### No answer

A result must pass a relevance floor: its meaning is close to the query, or its text matches at least 2 of the query terms. A query that the wiki cannot answer then returns no fact, or only facts close in meaning: facts that an agent with that question could fairly open. It never returns an unrelated fact. An empty list tells the consumer to read the shared system itself; a short list of neighbors lets the consumer judge them from their headers.

The contract is relaxed from "an empty list". On a code wiki almost every query has close neighbors, and no text rule or distance limit separates them from real answers: the BM25 trial found no limit that passes every case.

The relevance test passes when at least 80 percent of the unanswerable queries meet this contract (`NO_ANSWER_SHARE`): the consumer is an AI agent, so cheap is better than perfect, and an unrelated header costs it 1 call.

Known weakness: some words are in many facts ("fact", "count"), so 2 of them can match by chance and let an unrelated fact through. The fix is in [../future.md](../future.md), "Relevance floor for common terms".

### Result cap

A search returns at most a set number of results. The consumer cannot raise the cap. A short list is a list that the consumer reads in full, and a consumer that reads every result can see when a fact disagrees with what it observes.

### Headers only

A search result holds the header of a fact, its confidence and its score, and no content. See "Approach" for the reason.

### Chosen reads count

A read by a consumer writes 1 retrieval row: a `getFact` on a live fact. A search writes none. The worker and the console read through other functions of the store, which write no row. So usefulness and confidence measure only what consumers choose.

### Confidence

Confidence is computed when a fact is read, from the events of the fact, and nothing is stored:

- An update (someone looked at the shared system and wrote what they saw) is strong evidence.
- A duplicate submission (someone looked and saw the same claim) is the same evidence, with no write.

Each event loses weight with age, by a half-life. Confidence is `1 - 2^(-S)`, where `S` is the decayed sum of the events, so it stays between 0 and 1. A deleted fact has confidence 0. A low confidence means "stale", not "wrong".

### Query limit

The embedding model reads a fixed number of tokens. A longer query is refused with an error that states the limit, and it is not cut, because a cut query searches for something that the consumer did not ask.

### Correction duty

The tool text of `search` and `getFact` ends with 1 sentence, the same as the last sentence of the server instructions and in the words of the result note: before you finish your task, send what you observed that the wiki lacks or gets wrong. The tool text is the only lever that the wiki has over a consumer at the moment of the read.

### When to search

The tool text says how to use a tool, and a consumer reads it only after it decided to use the tool. A client can also defer the tools: Claude Code shows only the tool names until the agent loads a tool. So the trigger goes where the client always shows it, in the server instructions of MCP. Claude Code loads them at session start, also when it defers the tools, and cuts them at 4,096 characters.

- A wiki endpoint sends instructions with the name and the subject of its wiki: search this wiki before you read other sources about the subject, because it is faster and cheaper.
- The management endpoint sends the same trigger with the name and the subject of each wiki. When the list does not fit in the limit, it names as many wikis as fit and points to `listWikis` for the rest.
- The `search` tool text starts with the same trigger, for a client that shows the tool text and not the instructions.

The wiki writes the instructions from its own data. The effect is measured by the share of agent sessions with no search ([Search log and sessions](#search-log-and-sessions)).

The server instructions and the tool text are not enough. In the usage test of 2026-10-29, 0 of 5 subagents searched with the trigger in both places. With 1 line in the context of the agent, 5 of 5 searched first, and 4 of 5 when a hook added the line ([research](../research/agent-usage-2026-10-29.md)). So a `SessionStart` and `SubagentStart` hook adds 2 lines to the context of each session and each subagent:

- "Search the `<name>` wiki (the MCP tool `search`) before you read the files on a subject."
- "Before you finish your task, send what the wiki lacks or gets wrong with the `requestChange` tool: what you saw, and how you know."

The hook reads the name from the config key `wiki.name`, and adds nothing when the key is null. It writes no rule text in a file. The hook is in the WikiFact plugin of this repo ([Consumer plugin](publication.md#consumer-plugin)).

A subagent of a Claude Code session does not get the server instructions, and sees the tools by name only (observed on October 16, 2026: 3 of 4 agent types). The wiki reaches it from the server side only, in 2 more places: the tool definitions of `search`, `getFact` and `requestChange` are marked as always loaded (`_meta: { "anthropic/alwaysLoad": true }`), so a client that defers tools still shows their text; and the results of `search` and `getFact` carry a `note` with the submit duty ([When to submit](submit.md#when-to-submit)).

## Search log and sessions

The wiki keeps a log of the searches of its consumers: for each search, the process, the query, the time, the duration, and the facts that it listed, each with the id minted for it. The log answers the signals of the console ([console.md](console.md), "The signals"): the change requests per search and the reads per search.

**Minted ids.** A search mints 1 id per result (`ref`) and returns it beside the fact id, with the id of the search itself (`searchId`). `getFact` takes a `ref`, and `requestChange` takes a `searchId`. So a read names the search that listed what it reads, and a submission names the search that it follows. Nothing is attributed by time or by session: a read by fact id (an id from inside a fact, or from a request) is an unlinked read, and a submission with no `searchId` follows no search. The consumer sets up nothing. The ids travel in the tool contract, as the `wiki` argument does, and the tool text says so (requirements "Linked reads" and "Linked submissions"; the owner, October 17, 2026).

**What a context window is.** A minted id lives in the context window that received it, so the chain "search, its reads, its submissions" never crosses 2 context windows: a subagent cannot read by a `ref` it never saw. That is all the wiki can see of a context window. The subagents of a Claude Code process share its MCP connection, and no field of a call names the context window ([research](../research/session-per-context-window-2026-10-17.md)), so a context window that makes no call is visible to nobody. The owner ruled out every form of setup for that (a hook, an agent file, the transcript files of the client): the wiki tracks what the calls carry, and nothing more.

**Processes.** An MCP session is 1 Claude Code process with the tool available, counted from its connect, not from its first call: the process opens its session at its start, and the service writes it in every mounted wiki ([measured](../research/sessions-without-calls-2026-10-17.md)). A process that never calls a tool has a session too. A wiki mounted after the process connected has no row for it. No page of the console counts the sessions: a count of processes cannot measure the adoption by the agents.

The log holds only the searches of consumers. A search from the console records nothing ([console.md](console.md), "Reads not counted"). The log grows with the use of the wiki, as the retrieval rows do; a bound is a future feature with the fold of the retrieval rows.

## Rank

The rank of a result is its relevance, with a small boost for usefulness: how often consumers chose to read the fact, with the same decay by age. The boost is a bounded factor of at most 10%, so it reorders results of near-equal relevance, and it cannot lift a fact over a far more relevant one. An earlier design added the boost as a term, and then 1 read put a fact at the top of every query.

## How the feature is measured

The tests of this feature, by kind of change. The system-wide rules are in [System evaluation](evaluation.md). The bars are in the requirement rows "Search speed", "Key-word search", "Question search" and "No answer".

| Kind of change | Measurement | Why this measurement fits |
| --- | --- | --- |
| Search                                     | The relevance test, then speed   | A ranking change can move the correct fact out of the first results. The relevance test sees that. Then the speed test checks that the change keeps a search fast.                                             |

| Data | Why it fits its test |
| --- | --- |
| Queries with the expected first fact  | The relevance test needs a known correct fact for each query. Queries that the wiki cannot answer prove that the search returns an empty list.                                                                      |
| Synthetic facts and queries           | The speed bar is at a scale that no real wiki has yet. Generated facts reach that scale.                                                                                                                            |

## Decisions

| Decision | Reason |
|---|---|
| A search returns headers, and the consumer opens a fact to read it. | Only a read chosen by the consumer measures usefulness without feedback. |
| The search uses no model. | A lookup must be fast and cheap, and the same query must give the same result. |
| Full-text and vector search together, merged by rank. | Each finds what the other misses. A merge by rank needs no calibration of 2 score scales. |
| A relevance floor that can return an empty list. | 10 unrelated results cost the consumer more than no result. |
| Confidence is computed at read time from events, not stored. | The value changes with time alone, by the decay. A stored value would be stale. |
| The wiki keeps a search log, and a read links to its search through an id that the search minted for the result. | A link by time and session mixed the context windows of 1 process, and no field of a call tells them apart. A minted id names the search exactly and needs no setup. Decided by the owner on October 17, 2026; replaces the link through the MCP session of October 16, 2026. |
