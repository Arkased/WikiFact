# How agents used the wiki, October 29, 2026

Research note of #2. The second usage test, after the fill. Read-only on the code and on a copy of the live store. Times are UTC.

## Result

- 0 of 5 agents searched the wiki. All 5 answered from Grep, Glob and Read only. In the first test, 7 of 7 agents searched first ([agent-usage-2026-10-16.md](agent-usage-2026-10-16.md)).
- So the counts of reads and change requests are 0 of 5, and the share of questions with no fact cannot be measured from this test.
- The tool and the instructions reached the agents. The `search` tool loads with its full text (`anthropic/alwaysLoad`), and a subagent gets the server instructions of the MCP server. The words that say when to search did not change after 2026-10-16.
- The split test of #98 found the cause. With 1 line in the project instructions that names the wiki, 5 of 5 agents searched first. But 0 of 5 sent a change request, and 2 of them saw a gap.
- The hook test of #98 put the same line in the context of each subagent at its start, from a `SubagentStart` hook. 4 of 5 agents searched first, with no mention of the wiki in the prompt. 0 of 5 opened a fact, and 0 of 5 sent a change request.

## Method

1. The orchestrator started 5 general-purpose subagents (model Sonnet) at 02:43, each with 1 repo question and no mention of the wiki. Each prompt asked for the file and line of each claim and for a list of the tool calls.
2. 1 agent was also asked whether it saw the full text of the `search` tool at the start.
3. A separate agent read a copy of the live store for the window 02:43 to 03:05, and the history of `src/mcp/tools.ts` and `src/mcp/instructions.ts`.

## The 5 agents

| # | Question | Tool calls by the report of the agent | `search` |
|---|---|---|---|
| 1 | When does the worker run the duplicate-fact cleanup, and what does 1 run do? | Grep 4, Read 2 | 0 |
| 2 | What does `npm run ship -- patch` do, and what stops it? | Grep 2, Read 2 | 0 |
| 3 | What does the worker do on a rate limit, and when does it resume? | Grep 2, Read 1 | 0 |
| 4 | How does the ingest handle a long file, and what does it count when a call fails? | Grep 1, Read 1 | 0 |
| 5 | How does the worker decide between a new fact, an edit and a rejection? | Grep 4, Glob 1, Read 3 | 0 |

Agent 1 wrote: "At the start I saw the full description and parameters of `mcp__wikifact__search`. It appeared in my initial function list with its schema (`wiki` and `query`). It was not deferred. I did not call it."

The store agrees with the reports. In the window it holds 4 searches, 9 reads and 11 change requests. All of them are from the 2 research agents of this session or from the worker. None is on a topic of the 5 questions.

## Comparison with the first test

| | 2026-10-16 (7 agents) | 2026-10-29 (5 agents) |
|---|---|---|
| Agents that searched | 7 of 7 | 0 of 5 |
| Agents that opened a fact | 1 of 7 | 0 of 5 |
| Agents that sent a change request | 1 of 7 (0 of 5 in batch 1) | 0 of 5 |
| Questions with no fact that answers them | 3 of 7 | not measured |
| `search` deferred at the start | yes (batch 1) | no, full text loaded |
| Server instructions in the subagent | no | yes |
| Claude Code version | 2.1.301 | 2.1.312 |

## Candidate causes

1. **The setup of the first test.** The first note says that the global instructions of that day named the wiki, and 1 agent cited `CLAUDE.md` as its reason to search first. Today neither `CLAUDE.md` names the wiki. The global file of 2026-10-16 is not in git, so its text cannot be checked. No evidence against it was found.
2. **The delivery of the tool.** On 2026-10-16, `search` was deferred, and each agent loaded it with ToolSearch first. The load was an explicit step toward the tool. Today the tool is loaded, and no step points to it. Against: batch 2 of 2026-10-16 already ran with `alwaysLoad` and still searched first.
3. **The version of Claude Code (a guess).** The version changed from 2.1.301 to 2.1.312. No evidence for or against it was found.
4. **The questions.** The questions were narrow and named code terms, and each asked for the file and line of each claim. That points to Grep. But the questions of the first test also asked for file references, and 4 of those 7 agents also ran a Grep before the search.

## The split test of #98

The test ran at 02:58 with the same 5 questions. Each prompt started with 3 lines labeled as section 1 of the project `CLAUDE.md`. 1 of the 3 lines said: "Search the WikiFact wiki (the MCP tool `search`, wiki `wikifact`) before you read the files on a subject." The task text did not name the wiki.

The line went into the prompt, not into the file. A first try put it in the file, but a subagent gets the `CLAUDE.md` of the session start: agent 1 quoted section 1 without the new line. A headless `claude -p` session, which reads the file again, failed with "OAuth session expired and could not be refreshed" from the shell of the session.

| # | Question | `search` | `getFact` | Gap that the agent saw | `requestChange` |
|---|---|---|---|---|---|
| 1 | Cleanup trigger | 1 | 1 | Yes: "It had no trigger or procedure" | 0 |
| 2 | Ship steps | 1 | 1 | No | 0 |
| 3 | Rate limit | 1 | 2 | No. It cited a fact on the old doubled wait, "33 to 41 minutes after the stated reset", as current. | 0 |
| 4 | Ingest of a long file | 1 | 0 | Yes: "The wiki search missed the ingest docs" | 0 |
| 5 | Judgment of a submission | 1 | 0 | Not stated | 0 |

- 5 of 5 searched first, against 0 of 5 without the line. Candidate 1 is the cause: a line in the project instructions makes an agent search. The same sentence in the server instructions of the MCP server does not.
- 3 of 5 opened a fact.
- 0 of 5 sent a change request. 2 agents saw a gap and wrote that they saw it, and 1 agent repeated a fact that is no longer true.

## The hook test of #98

The test ran after the merge of the hook, with the same 5 questions, with no mention of the wiki and no instruction text in the prompt. The hook `.claude/scripts/wiki-context.ts` (`SessionStart` and `SubagentStart`) added 2 lines to the context of each subagent:

- "Search the `wikifact` wiki (the MCP tool `search`) before you read the files on a subject."
- "Before you finish your task, send what the wiki lacks or gets wrong with the `requestChange` tool: what you saw, and how you know."

Agent 1 quoted the 2 lines as text that a `SubagentStart` hook added. Each agent listed its tool calls in order.

| # | Question | Tool calls in order | Search first | `getFact` | Gap that the agent saw | `requestChange` |
|---|---|---|---|---|---|---|
| 1 | Cleanup trigger | search 1, Grep 2, Read 3 | Yes | 0 | No. It opened no fact to compare. | 0 |
| 2 | Ship steps | search 1, Grep 3, Read 2 | Yes | 0 | No. It opened no fact. | 0 |
| 3 | Rate limit | search 1, Grep 3, Read 1 | Yes | 0 | Not stated | 0 |
| 4 | Ingest of a long file | listWikis 1, search 1, Grep 1, Bash 2 | Yes | 0 | Yes: "The search returned nothing on ingest" | 0 |
| 5 | Judgment of a submission | listWikis 1, Grep 2, search 1, Read 1 | No: 2 Grep calls came first | 0 | No. It opened no fact. | 0 |

- 4 of 5 searched first. The bar of #98 is 4 of 5, so the hook passes. A line in the context of the agent makes it search, and a hook can put the line there with no rule text in a file.
- 0 of 5 opened a fact, against 3 of 5 in the split test. Each agent read the code after the headers of the results.
- 1 agent saw a gap, and 0 sent a change request. The bar of #99 is 2 agents that see a gap and submit, so the line of the duty in the hook does not pass. 2 agents wrote that they found nothing wrong because they opened no fact.

## The stop hook test of #99

The test ran after the merge of the `SubagentStop` hook `.claude/scripts/wiki-submit.ts`, with the same 5 questions and no mention of the wiki. The context hook of #98 was also on.

| # | Question | Search first | `getFact` | `requestChange` | Hook block in the transcript |
|---|---|---|---|---|---|
| 1 | Cleanup trigger | No: `listWikis` came first, then `search` before any file tool | 0 | 0 | Yes, after the report |
| 2 | Ship steps | Yes | 0 | 0 | Yes, after the report |
| 3 | Rate limit | Yes | 0 | 0 | Yes, after the report |
| 4 | Ingest of a long file | No: `listWikis` came first, then `search` before any file tool | 0 | 0 | Yes, after the report |
| 5 | Judgment of a submission | Yes | 1 | 1, before its report, with no hook block | No: it had sent a request |

- 5 of 5 searched the wiki before any file tool. 1 of 5 sent a change request, on its own.
- The hook blocked the stop of the other 4 agents, and the block text is the last line of each transcript (an attachment `hook_blocking_error` of `SubagentStop`). But each agent had already ended with its report tool `SubagentHandback`, so it ran no more turns: the block came too late to act on.
- When the hook runs by hand on the transcript of agent 2, it prints the block with the right reason. So the hook works, and the event is the fault: in this client, a background subagent hands back its report before `SubagentStop`.

## The report check test of #99

The test ran after the merge of the `PreToolUse` check on `SubagentHandback`, with the same 5 questions and no mention of the wiki. The context hook of #98 and the `SubagentStop` hook were also on.

| # | Question | Search first | `getFact` | Report call denied | `requestChange` | Gap that the agent sent |
|---|---|---|---|---|---|---|
| 1 | Cleanup trigger | Yes | 1 | Yes | 1, after the denial | The wiki had no fact on the cleanup trigger. |
| 2 | Ship steps | No: 1 Grep before the search | 1 | Yes | 1, after the denial | A fact said that the ship runs `npm run check`; it runs `npm run check -- --full`. |
| 3 | Rate limit | No: no search | 0 | No: no search | 0 | None |
| 4 | Ingest of a long file | Yes | 0 | No | 1, before the report | The wiki had no fact on the ingest of a long file. |
| 5 | Judgment of a submission | Yes, after `listWikis` | 0 | No | 1, before the report | The results gave no file or line for the judgment path. |

- 4 of 5 agents sent a change request, against 0 of 10 in the earlier tests. 4 agents saw a gap, and all 4 sent it. The bar of #99 is 2, so the check passes.
- 2 of the 4 requests came after the denial of the first report call. 2 came before the report, with no denial. The second report call of agents 1 and 2 passed, so the check denies 1 call only.
- 3 of 5 searched first, against 4 of 5 in the hook test of #98. 1 agent never searched, so no check applied to it.

## What is not covered

- 5 agents give a count, not a rate.
- The store has no column for the agent, so a search links to a test agent only by its time and its topic.
- The split test put the line in the prompt and not in `CLAUDE.md` itself. A run of `claude -p` with the line in the file is still to do.
