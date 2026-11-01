# How agents used the wiki, October 16, 2026

Research note. Read-only on the code and on the live data. Times are UTC.

## Method

1. The live wiki database `wikifact` (21 searches, 7 sessions, 94 retrievals, 1,085 change requests), read with read-only SQL. The counts are from before this research ran its own searches; the log now holds 22.
2. The transcripts of the 7 usage agents, read with a script that keeps the tool calls, the wikifact results and the final report. The transcripts hold every call twice (one line per content block); the counts here are of unique calls, and the search log confirms it (1 row per query).
3. The 7 usage agents are 7 of the 21 logged searches. The other 14 searches are from build agents that had the wiki in their instructions; they have no transcript here, so they get counts, not judgments.
4. The judgment "did the answer sit in the headers" is mine, from the current fact contents in the database. The agent questions all ask for "file references", so a file read is required by the question and is not proof that the wiki failed.
5. Batch 1 (5 agents) ran at 20:38 UTC, before the sessions fix and before the result note. Batch 2 (2 agents) ran at 22:45 UTC with the note, 25 seconds after the deploy of v0.1.33.

## A. The 7 logged usage searches

"Answer" = the answer to the question as the agent's final report gives it. "Reads" = `getFact` calls by that agent.

| # | Query | Results | Reads | Did headers or facts hold the answer? | What the files gave |
|---|---|---|---|---|---|
| 1 | `update worker duplicate submission existing fact` | 4 facts | 0 | No. Headers: "Update worker question Q4", "Update worker factId lookup", "Update worker merge trigger". The Q4 fact says "classifies each submission into an outcome", and no fact says when the outcome is duplicate. | Paths and lines (`src/updates/agent/judge.ts` `mapJudgment`, `submission.ts`, `summaries.ts`), the rule (supported and same, or negates and deleted), the written fields (`duplicateOf`, the summary text). A mechanism. |
| 2 | `getRequest split childIds` | 0 | 0 | No. The wiki has no fact on `childIds` (grep of live facts: 0). | The output shape, `docs/technical/submit.md:35`, `src/mcp/tools.ts:156,442,470`, `src/store/stats.ts:160-189`. Everything. |
| 3 | `search relevance floor default value` | 6 | 2 | Partly. "Search relevance floor" and "Consumer search full-text floor" gave the behavior and, in their justifications, the file. The value 0.31 is in no fact. | The value (`DEFAULT_RELEVANCE_FLOOR = 0.31`, `src/store/types/config.ts:52`), the schema and the fallback (`config/schema.ts:66`, `store/open.ts:79`), line numbers. |
| 4 | `service log files and retention` | 9 | 0 | In part. 3 facts hold the answer for 2 of 4 log files: "Errors log file retention" (10 files), "Full log file retention" (5 files), "Full log file rollover size" (10 MB). The headers name the topic; the numbers are in the contents. No fact on the worker logs or the calls log. | The file names, the worker and calls logs (50 files, 500 MB), the constants in `src/log/file.ts`, `docs/technical/deployment.md` lines. |
| 5 | `cleanup check schedule and repair limit per run` | 4 facts | 0 | Yes, for both parts. "Cleanup request cap" (20 per finder, 80 per run) and "Cleanup finder run intervals" (1, 20, 100, 200 writes) hold the numbers; the cap is in the header words. The agent wrote: "the wiki fact 'Cleanup request cap' was not read". | The trigger rule (after a poll with no queued row, compared with `meta.cleanup_seq`), `cleanup_full`, paths and lines. A mechanism. |
| 6 | `update worker stale lock file takeover` | 4 facts | 0 | Yes for "what counts as stale": "Update worker lock takeover" says the pid in the lock file is dead. | The mechanism: exclusive open `wx`, `EEXIST`, the pid parse, `pidAlive` through `process.kill(pid, 0)` with `EPERM` as alive, delete, `onTakeover`, one retry, `LockError`; an unparseable lock is never stale. A path. |
| 7 | `console timing script` | 8 | 0 | No. No fact on the script (the agent then submitted 3 facts' worth). | Everything: the script, its pages, the 1,000 ms bar, the report path. |

Counts for the 7: the headers or the facts held the whole answer in 1 (#5), part of it in 3 (#3, #4, #6), none of it in 3 (#1, #2, #7). `getFact` was called in 1 of 7 (2 calls, #3). All 7 went to the files afterward. What the files gave that no header or fact held: the path or line (7 of 7, as the question demanded), a value (#3), a mechanism (#1, #5, #6), the whole answer (#2, #7). The facts do hold paths, but in the justification, which only `getFact` returns: 201 of 217 live justifications name a file, and 22 of 217 contents do.

Search time was 13 to 36 ms (21 searches). 12 of 21 lists hit the cap of 10.

The other 14 logged searches (build agents):

| Count | Observation |
|---|---|
| 1 | linked read: "management endpoint call counters" (rank 3, "Management endpoint call stats"), read 2.9 s later. |
| 3 | followed by a submission with the same `priorQuery`: "rejected request reason panel console", "tool result note submit duty", and the usage agent's "console timing script". |
| 1 | the build agent's submission says: "The wiki search showed only the model_calls table facts and nothing on the cost signal" (query `tokenCost cost per write price table models.json`, 20:38:44). |
| 13 | no read linked, no transcript to judge. |

## B. Why 0 of 5 submitted in batch 1

| | Batch 1 (5 agents, no note) | Batch 2 (2 agents, note) |
|---|---|---|
| Loaded the `requestChange` schema | 0 of 5 (loaded: search 5, getFact 1, getRequest 1) | 1 of 2, in the call right after the search result with the note |
| Mentioned the duty in the final report | 1 of 5 (#3) | 2 of 2 |
| Submitted | 0 | 1 (#7, with `priorQuery` "console timing script" and "how I know") |
| Gap seen | #1, #2, #3, #4 (partly) | #7 |

What the agent wrote in #3, the one that found the gap: "The wiki facts agree on the behavior but do not state the 0.31 value, so I did not file a change." It read the duty as "a fact is wrong". The tool texts it saw matched that reading: `search` and `getFact` end with "If a fact disagrees with what you observe, call `requestChange`". The word "lacks" is only in the server instructions, and a subagent gets none ([lookup.md](../design/lookup.md), "When to search"). The 4 other agents of batch 1 wrote nothing about a submission. The empty search of #2 had no note either (the empty note did not exist).

In batch 2 the note arrived with the search result, 2 calls before the final report: "send what you observed that the wiki lacks or gets wrong with requestChange". #7 got no useful hit, loaded the tool and sent it. #6 (hit, answer matched the code) wrote "I did not submit a `requestChange`. The search results matched what the code shows." So the note made both agents decide. With 2 agents this is a count of 2, not a rate.

What differs: (1) the word "lacks" reached the agent; (2) the tool name was in the text at the moment the agent had the evidence; (3) the schema of `requestChange` still had to be loaded, and only the agent that was told to loaded it.

## C. The assumptions of the design

| Assumption | Today's count | Verdict |
|---|---|---|
| 0 reads = not found | The 6 zero-read usage searches: 3 were misses (#1, #2, #7), 3 had the answer in whole or in part in the listed facts (#4, #5, #6) and were not opened. 1 search had 2 reads, with the answer partly there (#3): not "misled". The 2 reads of #3 are unlinked (no session before 21:17), so the console counts them in no distribution. As the page would compute it now: 20 of 21 searches with 0 reads, 1 with 1 read, so the reading would say "the results did not answer", and by transcript that is right for 3 of 6. | Contradicted for "0 reads = not found" (3 of 6). The search knows the real not-found case without a read: `result_count` 0, 1 of 21. 1 read and 3 or more reads: no data (0 labeled). |
| The searches per session measure the buy-in of the agents | 7 sessions, 13 sessioned searches (8 earlier searches have no session), 1.9 per session, 0 of 7 sessions without a search. The 7 usage agents map to 0 sessions (5 ran before sessions existed) and 1 session (the 2 of batch 2 share session `01M53E8N` with 1 build-agent search). 3 of 7 sessions started 6 to 11 s after a deploy (21:49:12, 21:52:48, 22:45:31); the others at the first call after an idle end. By transcript, 7 of 7 usage agents searched, 3 of them before any file search; 4 ran a repo Grep first (in the same turn as `ToolSearch`). | Contradicted as built: a session row opens on the first call that names the wiki (`src/mcp/sessions.ts`, fact "Management endpoint session rows"), so "sessions with no search" cannot catch a process that never called a tool, which the design assumes ([console.md](../design/console.md), "The test of the sessions"). Searches per session counts reconnects of the orchestrator process. Says nothing about buy-in. |
| A duplicate means the search missed a fact | 7 duplicates in the life of the wiki, 1 in the span of the search log (1 of 67 change requests of the span). That 1: `priorQuery` "tool result note submit duty"; its logged search listed the duplicate fact "WikiFact tools in subagents" at rank 9 of 10. Of the other 6: 3 have no `duplicate_of` or `priorQuery`, 2 have a `priorQuery` that is in no logged search (10-14, before the log), 1 has none. 128 requests carry a `priorQuery`; 8 match a logged query. | Contradicted by 1 of 1 testable duplicate: the search listed the fact, and the agent did not open it. 6 of 7 cannot be tested. |

The stage reading (not in the question, but on the same page): 67 change requests (leaves) in the span over 21 searches is 3.2, and the page would say "New: agents add more than they find". The 67 come from 15 submissions; 13 of the 15 were split, and 1 submission made 10 claims. Per submission, it is 0.71 per search ("Growing"). The 208 `cleanupRepair` requests of the span are not in the count.

## D. The headers

217 live facts. A header has 4.2 words on average (2 to 8); no header repeats. A content is 1 sentence (17.7 words on average, 38 at most). 72 of 217 headers (33%) start with 1 of 2 prefixes: "Operator console" (48) and "Update worker" (24).

| Example | Header | Specific enough to pick? |
|---|---|---|
| 1 | "Cleanup request cap", "Cleanup finder run intervals" (#5) | Yes. The subject and the quantity are in the header; the number is 1 read away, and for the cap it is in the header's meaning. The agent still read neither. |
| 2 | "Update worker question Q4", "Update worker question Q2", "Update worker question Q1 skipping" (#1) | No. 24 headers start "Update worker"; the question number carries no meaning to a reader who has not seen the worker. Q4 is the right fact for #1, and no header says "duplicate". |
| 3 | "Operator console Service health page checks", "…MCP endpoint panel", "…page failed requests table", "…Worker panel stats" | Partly. 4 headers of 1 page differ only in the last 2 to 3 words. The search "Service health page worker panel queueStats" returned all 4 and the fact on "failed requests table" at rank 4. The agent needs 1 read to choose. |

## E. Other observations

| # | Observation | Count |
|---|---|---|
| 1 | Every usage agent called `ToolSearch` before its first wiki call, to load `search`. 2 more loads followed: `getFact` (#3) and `requestChange` (#7). Batch 2 ran on tools marked `alwaysLoad` and still loaded `search` first. | 7 of 7 agents; 9 loads |
| 2 | `getFact` was never loaded by 6 of 7 agents, so those agents could not read a fact. Agent #4 wrote that the search "returned fact headers on log retention but not their content". | 6 of 7 |
| 3 | The queries are keyword strings of 3 to 11 words (6.2 on average). 8 of 21 hold a code identifier (`childIds`, `tokenCost`, `stageSeries`, `queueStats`, `levelBadge`). The only empty result is the one with an identifier alone (`getRequest split childIds`). | 0 of 21 are questions |
| 4 | The 7 sessions are connections of the one Claude Code process that ran the agents, not 7 agents. A new one opens at the first call after a deploy or after an idle end. | 3 of 7 start within 11 s of a deploy |
| 5 | A submission with 2 or more claims is split: 13 of 15 top-level submissions of the span. 13 of 67 leaves (19%) are rejected as "compound"; the usage agent's single submission split into 3 claims, all accepted. | 13 of 15; 13 of 67 |
| 6 | The agents did not take the order "wiki before files" from the tool: 4 of 7 ran a repo Grep first. 1 agent cited the instructions of the project (`CLAUDE.md`) for searching first. The global instructions name the wiki, so the "no mention of the wiki" setup was not clean. | 4 of 7; 1 of 7 cited |
| 7 | A `ToolSearch` result carried the auto-mode text "use Bash instead of Read, Edit, Write". #3 flagged it and ignored it. | 1 of 7 |

## Findings

1. **Gaps are the main miss, not ranking.** 3 of 7 usage searches found no fact on the subject (`duplicate`, `childIds`, `timing script`) and 1 more lacked the value (0.31); 0 of 7 searches needed 3 or more reads. Recommended change: none to the search; the wiki needs these facts, which the submit loop (finding 3) fills. Touches nothing; the requests below add `childIds` and the floor value.
2. **Agents do not open facts, and cannot.** 6 of 7 agents never loaded `getFact` (a deferred tool), and the 3 searches whose facts held the answer (#4, #5, #6) ended in the files. Recommended change: mark `getFact` `alwaysLoad` like `search`; touches `src/mcp/tools.ts` and [technical/lookup.md](../technical/lookup.md). Test it with the same 7 questions.
3. **The correction duty reads as "wrong", not "lacking".** The agent that saw the gap did not submit because "the facts agree"; the tool text says "disagrees"; the note, which says "lacks or gets wrong", made 2 of 2 agents decide. Recommended change: end the `search` and `getFact` texts with "lacks or gets wrong" (the note's words) and keep the note; touches `src/mcp/tools.ts`, [design/lookup.md](../design/lookup.md) "Correction duty", [design/submit.md](../design/submit.md) "Correction duty". The `requestChange` schema still needs a load: marked `alwaysLoad` since v0.1.33, and #7 loaded it.
4. **"0 reads = not found" fails.** 3 of 6 zero-read searches had the answer listed. Recommended change: show "no result" (`result_count` 0, 1 of 21) as its own count, and say of 0 reads "no fact opened", not "the results did not answer"; touches [design/console.md](../design/console.md) (row "The reads per search"), `src/console/signals.ts`, `src/console/interpretations.ts`.
5. **The sessions do not measure buy-in.** A session opens at the first call naming the wiki, 7 sessions are reconnects of 1 process (3 after a deploy), and the 7 usage agents map to 0 or 1 of them. Recommended change: correct "The test of the sessions" (a session opens at the first named call, so a no-search session is a rarity), and mark the "sessions" interpretation as untestable until a measure of agent runs exists; touches [design/console.md](../design/console.md).
6. **Change requests per search counts claims, not submissions.** 67 leaves from 15 submissions (13 split, 1 of 10 claims) give 3.2 ("New"); per submission it is 0.71 ("Growing"). Recommended change: the owner decides the unit; the research suggests submissions per search for "The stage", and leaves per write for the cost; touches [design/console.md](../design/console.md) "The signals", `src/store/signals.ts` (`IS_CHANGE_REQUEST`, `stageSeries`).
7. **The duplicate test can be mechanical.** The 1 duplicate with a logged search had the fact in the list (rank 9 of 10), and 6 of 7 cannot be tested because the log is young or `priorQuery` was empty. Recommended change: replace "a duplicate means the search missed" by a count of duplicates whose `priorQuery` search listed the fact, with its rank; touches [design/console.md](../design/console.md) (row "The duplicates"), `src/store/signals.ts`.
