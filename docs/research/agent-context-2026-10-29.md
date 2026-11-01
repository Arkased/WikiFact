# Token cost of the agent sessions, second measurement, October 29, 2026

Research note of #52. The second measurement, after the first one of 2026-10-22. It covers the 7 days since v0.1.80 (2026-10-22 12:01 -0700, 19:01 UTC). Times are UTC. Costs are at the API list prices, per call.

## Result

- The average context of a build-agent call fell from 131,000 tokens to 81,500 tokens (-38%). The re-run of the script on the baseline window gives 127,800 tokens, so the fall is -36% on a like-for-like basis.
- The read cost of the main session fell from $185 in 18.8 days to $13.2 in 7.0 days. That is $9.8 per day against $1.9 per day (-81%). The script re-run on the baseline window gives $335 ($17.8 per day), so on a like-for-like basis the fall is -89%. See Limits: the read cost is not the baseline method.
- The main context fell from a median of 196,000 and a p90 of 590,000 tokens to a median of 108,600 and a p90 of 176,700 tokens.
- The total cost fell from $75 per day to $43 per day (-43%). $302 in 7.0 days against $1,408 in 18.8 days.
- Build agents make fewer calls: a median of 17 calls per agent against 23 (31 in the re-run), and a p90 of 66 against 77 (84 in the re-run).
- The cost per build-agent call is $0.030 against $0.036 in the re-run window. The context gain is partly offset by the model change (see Limits).
- The 3 changes (1-line check output, doc sections in the prompts, the hook on code reads) are in place in the whole window. The data cannot split the gain among them.

## Method

1. The script `measure.mjs` is in the scratch folder of the session. It is not in the repo.
2. It reads every `*.jsonl` under the project folder `~/.claude/projects/C--Users-dev-Documents-Projects-WikiFact`: the main sessions and the `subagents/` folders. No worktree project folder exists. The 226 folders of the evals (`...Temp-wikifact-corrections-*`, `...wikifact-exp-*`) are not this project and are left out.
3. It takes the `usage` of each assistant message and dedupes by message id. When an id repeats (streaming), it keeps the record with the most output tokens.
4. It keeps the calls with a timestamp from 2026-10-22 19:01:29 to 2026-10-29 18:54 (6.995 days).
5. Prices, in dollars per 1M tokens (input / output / cache read). Cache write is 1.25 times the input price for 5 minutes and 2 times for 1 hour, by the `cache_creation` split of the record.

   | Model | Input | Output | Cache read |
   |---|---|---|---|
   | claude-opus-5-5 | 4.00 | 20.00 | 0.20 |
   | claude-sonnet-5-5 | 2.00 | 10.00 | 0.20 |
   | claude-fable-5-1 | 10.00 | 50.00 | 0.25 |
   | claude-sonnet-5 | 2.00 | 10.00 | 0.20 |
   | claude-haiku-5-5 | 0.10 | 0.50 | 0.01 |

   The source is the `claude-api` skill (cached 2026-10-06). The cache-read price of Opus 5.5 and Sonnet 5.5 is the one that the skill states. The cache-read price of Fable is the one that the skill states for Fable 5.1. For Sonnet 5 and Haiku 5.5 the cache read is 0.1 times the input price, an assumption.
6. Build agent: a call of a subagent file (under `subagents/`) with a Sonnet model. One agent is one subagent file.
7. Context of a call: `input_tokens` + `cache_read_input_tokens` + `cache_creation_input_tokens`. The main context is the same value over the calls of the main session files.
8. Read cost of the main session. A tool result of Read, Grep or Bash with `grep`, `rg` or `sed -n` is sized as characters / 4. It is paid once as a cache write (the average write price of the main session in the window), then as a cache read on each later call of that session until the context of a call falls under half of the call before (taken as a compaction). The read price is the one of the model of the call.
9. The baseline window was run again with the same script (2026-10-04 00:00 to 2026-10-22 19:01) to check the script against the published baseline.

## Tables

The check of the script on the baseline window:

| Metric | Published baseline | Script, same window |
|---|---|---|
| Total cost | $1,408 | $1,433 |
| Cache read | $763 | $775 |
| Cache write | $482 | $493 |
| Output | $161 | $165 |
| Build-agent calls | 14,500 | 15,054 |
| Average build context | 131,000 | 127,800 |
| Calls per agent, median / p90 | 23 / 77 | 31 / 84 |
| Main context, median / p90 | 196,000 / 590,000 | 188,600 / 585,300 |
| Main read cost | $185 | $335 |

Total cost by token type:

| | Baseline (script, 18.8 days) | Now (7.0 days) |
|---|---|---|
| Total | $1,433 | $302 |
| Cache read | $775 (54%) | $132 (44%) |
| Cache write | $493 (34%) | $102 (34%) |
| Output | $165 (12%) | $67 (22%) |
| Input (uncached) | $0.7 | $0.04 |
| Per day | $76 | $43 |

Build agents (Sonnet subagents):

| | Baseline (published) | Baseline (script) | Now |
|---|---|---|---|
| Agents | n/a | 364 | 173 |
| Calls | 14,500 | 15,054 | 5,428 |
| Calls per day | 771 | 801 | 776 |
| Average context per call | 131,000 | 127,800 | 81,500 |
| Cost | $460 | $547 | $163 |
| Cost per day | $24 | $29 | $23 |
| Cost per call | $0.032 | $0.036 | $0.030 |
| Calls per agent, median | 23 | 31 | 17 |
| Calls per agent, p90 | 77 | 84 | 66 |

Main session:

| | Baseline (published) | Baseline (script) | Now |
|---|---|---|---|
| Calls (main files) | n/a | 5,935 | 1,690 |
| Context, median | 196,000 | 188,600 | 108,600 |
| Context, p90 | 590,000 | 585,300 | 176,700 |
| Read-tool results | n/a | 2,567 | 432 |
| Read-tool result tokens | n/a | 7.28 M | 0.69 M |
| Read-tool result tokens per day | n/a | 387,000 | 99,000 |
| Read cost | $185 | $335 | $13.2 |
| Read cost per day | $9.8 | $17.8 | $1.9 |

Read-tool result tokens now, by tool: Read 472,000 (68%), Bash `grep` or `sed -n` 211,000 (30%), Grep 10,000 (1%). Of the $13.2, $5.5 is the cache write and $7.7 the cache reads.

Cost by model now:

| Model | Calls | Cost |
|---|---|---|
| claude-opus-5-5 (main and Opus subagents) | 2,807 | $139 |
| claude-sonnet-5-5 (build agents) | 5,428 | $163 |

In the baseline window, `claude-fable-5-1` made 2,714 calls, which cost $519 at the prices above. It is absent now.

## Limits

- The read cost is not the baseline method. The script finds $335 on the baseline window, and the baseline says $185. The cause is not known: the baseline may size the results by the real token count, or count the read part only. The two numbers of the same script (335 and 13.2) are the fair pair. The ratio -89% holds for the script only.
- The size of a result is characters / 4. This is an estimate. A real count would shift the cost by some tens of percent, in the same direction in both windows.
- Compaction is detected by a fall of the context under half of the call before. A context fall from another cause resets the pool too, and a compaction that is smaller than half is missed.
- The script does not match the published baseline on the build agents: 15,054 calls against 14,500, a median of 31 against 23, $547 against $460. The context, the total and the cost by token type match within 3%. The cause may be a different rule for what is one agent or a build agent.
- The window is 7 days against 18.8 days. Sums are normalized by day. Medians and p90 are not sums and need no normalization, but a short window has fewer agents (173 against 364) and a wider spread. The window includes the session that wrote this note.
- The mix of models changed. Fable made 2,714 calls in the baseline window and none now, and the Opus 5.5 price ($4 / $20) is below the Opus 4.6 to 5 price ($5 / $25). Part of the fall of the main-session cost is the model, not the 3 changes. The context numbers, the call counts and the read tokens do not depend on the price.
- The build-agent cost per call fell less (-17%) than the context (-36%). The note does not split the cause.
- A fall in work is not excluded. 1,690 main calls in 7 days is 241 per day against 316 per day in the baseline window. A different mix of tasks may explain a part of the fall.
- The data cannot split the gain among the 3 changes. They were in place at the same time.
