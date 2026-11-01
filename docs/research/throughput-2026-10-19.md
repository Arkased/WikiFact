# Throughput, tokens and time per request, 2026-10-19

Issue #15. The study of the requirement "Queue keeps up". Data: a copy of the dogfood store `wikifact` taken at 2026-10-20 00:12 UTC with the SQLite backup API (`scripts/backup-db-copy.cjs`), and the worker call logs `worker-wikifact-calls.1.log` to `.27.log`. `model_calls` holds 5,695 rows from 2026-10-16 20:22. All times are UTC.

The study scripts that this note names (`scripts/backup-db-copy.cjs`, `scripts/token-probe.ts`, `scripts/token-study.ts`, `scripts/throughput-model.cjs`, `scripts/q1-distance.ts`) were never merged, and their branch was deleted on 2026-10-29 (#109). The numbers of the note stay as the record.

## Result

- Today one worker clears 129 split children per hour of full duty (27.9 s each). The login lets it clear 67 per hour (a child costs 64.2k weighted tokens, and the session limit allows 21.4M in 5 hours). The tokens are the binding cap. The 1,740 queued submissions need 26 hours at the token cap, and 112M weighted tokens, which is 140% of the week in which the weekly limit hit (80M).
- The wiki block is the cause. Q4 and Q5 send the whole block (15.8k and 15.5k tokens of 26k) in the user message. Every token of a user message is written to the cache again at each call. 84.6% of all cache-write tokens are Q4 (45.7%) and Q5 (38.9%). Only 1.1% of Q4 calls read the list from the cache.
- Q4 does not read the wiki block at all (its prompt says nothing of it). Cutting it is one line and costs no quality that a test can see.
- The tokens and the time are two caps with different levers. The levers on tokens (wiki block, material) leave the time unchanged (27.9 to 26.9 s). The levers on time are the hidden thinking tokens (12.5 s of 31.2 s of an accepted child), the fixed 2.9 to 4.9 s of every call (15.7 s), and calls that wait for each other.
- Levers, one worker, split children, at full duty (details in "Levers"):

| Stack | Requests per hour, time cap | Weighted tokens per child | Requests per hour, token cap | Hours for 1,740 |
|---|---|---|---|---|
| Today (S0) | 129 | 64.2k | 67 | 26.1 |
| Wiki block and material (S1) | 134 | 26.7k | 160 | 13.0 |
| S1 + tested efforts for Q1 and Q7 + Q7 beside Q1 + Q4 beside Q5 (S2) | 256 | 26.6k | 161 | 10.8 |
| S2 + Q4 on Sonnet medium (S3) | 311 | 26.6k | 161 | 10.8 |
| S3 with the Q5 names only (S3B) | 311 | 24.5k | 174 | 10.0 |
| Q4 and Q5 in one call, the wiki block gone (SM6) | 318 | 15.4k | 279 | 6.2 |

- Two workers do not help while the tokens bind: S3 with 2 workers has a time cap of 613 per hour and the same 161 per hour of token cap.
- The "10 s outside the model calls" is not in the store. Over the requests that have `model_calls` rows, the calls sum to 11.91 h and the requests last 11.98 h (99.4%). The gap between 2 requests has a median of 0 ms and a mean of 0.29 s. The 18.3 s of the calls per submission is an average that holds 933 top-level splits (1 call, 7.0 s) and the requests before `model_calls` existed.
- No real model call was made. The login of this machine is expired: `claude -p` answered "Failed to authenticate: OAuth session expired and could not be refreshed" in 1.27 s. Every number below comes from the stored usage and durations. The probe script is ready (`scripts/token-probe.ts`) and the calls to run are in "Calls to run".

## Method and limits

- Tokens of the parts are estimates. The Anthropic count endpoint needs a key. I re-rendered 6,665 logged calls with the real specs (`scripts/token-study.ts`), measured the characters of the system prompt, the JSON schema, the wiki block and the rest of the material, and fitted the stored prompt size (`tokens_in + cache read + cache write`) on them: `tokens = 1,954 + 0.269 * system + 0.248 * schema + 0.437 * wiki block + 0.344 * rest` (characters). The fit reproduces the stored total of each question to within 5%.
- The 1,954 tokens are the additions of the CLI (the tool of the structured answer and a block in the first user message). I did not see their text. The 1.1k to 1.5k that are written at each call beyond the message are the best estimate of the block that the CLI adds.
- Weighted tokens = in + 5 * out + 0.1 * cache read + 1.25 * cache write. These are the API price ratios. The login's real weights are unknown. Raw tokens (in + out + read + write) are given where it matters.
- The caps are proxies. The session limit hit after 16.5M raw (21.0M weighted) tokens of the worker in 3.2 busy hours on 2026-10-17 and after 17.1M raw (21.7M weighted) in 3.0 hours on 2026-10-18. The weekly limit hit after 63.4M raw (80.0M weighted) tokens of the worker in the week from 2026-10-12 23:00. The owner's own sessions use the same login, so the true caps are at least these.
- The times come from `duration_ms` (the CLI process, so they include its start). Hidden output tokens are the stored output tokens minus the visible answer (JSON characters / 3.3). They are thinking and the wrapper of the structured-output call; the store does not split them.
- Child mix (622 done children): accepted 4-call 69.1%, accepted with a merge 3.2%, duplicate 12.7%, rejected as compound 15.0% (rows in `scripts/throughput-model.cjs`).

## Tokens of one call, per question

Means over all stored calls. Parts in tokens (estimate). `cw` is cache write, `cr` is cache read, `out` is output.

| Question | Model, effort | Calls | System | Schema | Wiki block | Material | CLI | cw | cr | out | Seconds |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Q7 | Sonnet medium | 2,114 | 646 | 72 | 0 | 100 | 1,954 | 1,427 | 1,338 | 497 | 6.5 |
| Q1 | Opus medium | 1,085 | 446 | 34 | 0 | 345 | 1,954 | 1,884 | 1,038 | 399 | 7.6 |
| Q4 | Opus high | 1,072 | 1,754 | 137 | 15,770 | 6,383 | 1,954 | 23,030 | 2,917 | 649 | 10.5 |
| Q5 | Haiku low | 910 | 1,225 | 161 | 15,530 | 6,429 | 1,954 | 23,071 | 2,305 | 930 | 7.7 |
| Q2 | Haiku low | 75 | 424 | 42 | 16,875 | 583 | 1,954 | 18,201 | 984 | 549 | 7.6 |
| Q3 | Haiku low | 65 | 731 | 161 | 16,826 | 668 | 1,954 | 18,192 | 1,612 | 620 | 6.6 |
| Q11 | Opus low | 352 | 417 | 42 | 0 | 411 | 1,954 | 1,520 | 1,022 | 124 | 4.7 |

Q6, Q8, Q9, Q10 and Q14 are 22 calls in all. Q6, Q9, Q10 and Q14 also carry the wiki block (cw 10k to 14k). Q8 does not (cw 2.4k).

Why the cache misses:

- A cache entry covers the tools, the system prompt and the messages up to a breakpoint. The cache read of each question grows with its system prompt and schema (Q1 1,038, Q4 2,917, Q5 2,305), so the tool and the system prompt are read from the cache. The user message is not: its whole text is written again at each call, because the part that comes before the claim (the wiki block) is inside the same text block, and the entry that the previous call wrote ends after its own claim.
- Between 2 Q4 calls the wiki block is identical in 920 of 1,166 pairs (79%). The hit of the wiki block is possible, but the list sits in the part that does not hit.
- 12 Q4 calls read more than 10k from the cache. Six of them are the retry of a Q4 call in the same request (the retry carries the first prompt as its prefix). That is the mechanism seen from the other side.
- Q4 and Q5 share nothing: the tools (schema) and the system prompt differ from the first token on.
- Of the 1,884 tokens that Q1 writes, 345 are its message. The other 1.5k are written at each call by the CLI. On Q7 it is 1.3k of 1.4k. These cannot be cut from the worker; the SDK transport does not have them.

The wiki block is 288 entries now, 12 on 2026-10-14. It grows with the wiki, so the cost of every Q4 and Q5 call grows with it. Names alone are 2.8k characters of the 33.5k (descriptions are 24.4k).

## Where the tokens of a request go

Split children and top-level submissions since 2026-10-16 (rows of `model_calls` joined to the last change of the request). Per request means.

| Request | n | cw | cr | out | Weighted | Seconds | Calls |
|---|---|---|---|---|---|---|---|
| Child, accepted | 430 | 52.1k | 7.4k | 2,182 | 76.7k | 31.2 | Q7 Q1 Q4 Q5 |
| Top, accepted | 398 | 46.5k | 7.4k | 2,454 | 71.1k | 31.2 | Q7 Q1 Q4 Q5 |
| Child, accepted with a merge | 20 | 96.8k | 9.3k | 3,979 | 142k | 56.8 | Q7 Q1 Q2 Q3 Q4 Q5 |
| Child, duplicate | 79 | 30.7k | 5.0k | 1,313 | 45.5k | 23.6 | Q7 Q1 Q4 |
| Top, duplicate | 51 | 24.0k | 5.0k | 1,503 | 38.0k | 25.1 | Q7 Q1 Q4 |
| Child, rejected as compound | 93 | 1.5k | 1.3k | 590 | 5.0k | 6.9 | Q7 |
| Top, split | 933 | 1.4k | 1.3k | 603 | 4.9k | 7.0 | Q7 |
| cleanupRepair | 352 | 1.5k | 1.0k | 119 to 175 | 2.6k | 4.6 to 4.8 | Q11 |

- A child costs 64.2k weighted tokens on average (51.4k raw): 43.3k cw, 6.2k cr, 1.9k out.
- An accepted request writes 88% of its cache tokens in Q4 and Q5. A duplicate ends before Q5 and writes 59% of an accepted one. A split or a compound reject costs 7% of an accepted one.
- A split makes 2.5 children (941 parents, 2,380 children). Its Q7 call costs 4.9k, and each child pays Q7 again.
- The queue now: 1,740 submissions and 16 lookupRepair. 1,694 of the submissions are children.

## Where the time of a request goes

Fit per question of `duration_ms` on output tokens: `ms = fixed + per-token * out` (the cache-write term is small: 0.03 s per 1k tokens for Q4).

| Question | Fixed s | ms per output token | Hidden output tokens | Hidden s | Visible answer tokens |
|---|---|---|---|---|---|
| Q7 | 2.89 | 5.6 | 403 | 2.3 | 94 |
| Q1 | 3.84 | 9.0 | 387 | 3.5 | 12 |
| Q4 | 4.11 | 8.7 | 364 | 3.2 | 285 |
| Q5 | 4.87 | 4.1 | 853 | 3.5 | 77 |
| Q11 | 3.81 | 3.6 | 85 | 0.3 | 39 |

- Of the 31.2 s of an accepted child: fixed 15.7 s (50%), hidden output 12.5 s (40%), visible output and the input 3.0 s (10%). The input size has almost no effect on the time. That is why the token levers do not move the time.
- The fixed part is the process start and the round trip to the first token. The failed probe call (no API answer) took 1.27 s, so the process start and the login check are at most 1.2 s of it. The rest, 1.7 to 3.7 s, is the API. A transport that keeps the process alive could save at most 1.2 s per call, 4.8 s per accepted child. It is not measured and the SDK needs a key.
- `--bare` skips the login: the CLI help says "Anthropic auth is strictly ANTHROPIC_API_KEY or apiKeyHelper (OAuth and keychain are never read)". It cannot be used on the login. `--exclude-dynamic-system-prompt-sections` is ignored with `--system-prompt`, which the worker passes.
- Time outside the calls: 0.6 s per multi-call request (embedding, search, lint, write; 229 s of 39,862 s in the [earlier note](worker-throughput-2026-10-19.md)). The gap between requests: median 0 ms.
- Thinking is on at every effort. Haiku at low writes 853 hidden tokens in Q5 for a 77-token answer. Opus at low on Q11 hides 85 tokens. The binary of the CLI names `CLAUDE_CODE_DISABLE_THINKING`, `MAX_THINKING_TOKENS` and `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING` (strings found in the file; their effect is not tested).

## Levers

Rates for split children, 1 worker, at full duty, with the model in `scripts/throughput-model.cjs`. "Time cap" is 3,600 / seconds per child. "Token cap" is 4.28M weighted tokens per hour (21.4M per 5 hours) / weighted tokens per child. The effective rate is the lower of the two. Each row alone, then stacks. Deltas per call are in the script.

| Lever | s/child | Time cap /h | Weighted tok/child | Token cap /h | Quality risk | Test that proves no loss |
|---|---|---|---|---|---|---|
| Today | 27.9 | 129 | 64.2k | 67 | | |
| L1 Q4, Q2 and Q3 without the wiki block | 27.5 | 131 | 46.1k | 93 | Low. Nothing in the Q4 prompt uses the list. Q3 needs the names it merges, which come from the facts. | Question test Q4 (79 cases), Q2, Q3, then replay. Bar: Q4 mean 97.5% or more, no run under 96%, the same cases as the last pooled run (97.9%). |
| L2A Q5 wiki block at the head of the system prompt (cached across calls) | 27.6 | 130 | 54.0k | 79 | Low: same text, other place. Hit rate 79% (the list is unchanged between 920 of 1,166 pairs). If cache reads count in full on the login, this lever saves nothing. | Question test Q5 (73 cases), replay. Check on 20 calls that `cache read` of Q5 is above 10k. |
| L2B Q5 gets all names and the descriptions of about 30 near entries (2.3k tokens, not 15.5k) | 27.6 | 130 | 52.2k | 82 | Medium. Q5 prompt says "read the description of each entry". An entry that is left out cannot be chosen. | Question test Q5 plus a recall check: every entry of the expected answer is in the subset (on the 73 cases and on 300 logged Q5 calls). |
| L3 Q4 and Q5 related facts: current version only, top 6 (now 12.9 facts with 2.83 versions; old versions are 10.8k of 17k characters) | 27.6 | 130 | 55.0k | 78 | Low to medium. Of 18 wrongRelated answers in the logs, 17 sit in the first 3 related facts and the last at index 5. Old versions of related facts hold evidence. Keep the full history of the existing fact. | Question test Q4 (the cases with wrongRelated), Q5, replay. Use top 8 if one case fails. |
| L4 Q1 on Opus low, Q7 on Sonnet low | 24.6 | 146 | 61.9k | 69 | Small. Question sets: Q1 Opus low 93.0% (medium 94.0%, min 92.5%), Q7 Sonnet low 93.4% (medium 94.6%, min 93.0%), against a bar of 90% with no run under 85%. The `standard` preset takes the best mean, so this changes the preset rule for these 2 questions (the owner's rule). The cut of hidden tokens (250 each) is an estimate. | `npm run questions` for Q1 and Q7, pooled, then 1 timed call each. |
| L5 Q5 with thinking off (env variable) | 26.1 | 138 | 62.0k | 69 | Untested. Q5 Haiku low is 95.9% with thinking. | Question test Q5 with the variable set. |
| L6 Q4 on Sonnet medium (now Opus high, 10.5 s; estimate 6.5 s = 2.9 s + 5.6 ms * 649) | 24.5 | 147 | 64.2k (cheaper in the login's weights if Opus counts more) | 67 | Small. Question set: Sonnet medium 97.0% (min 96.2%), Sonnet high 97.5%, Opus high 97.9% (min 97.5%), Opus medium 97.5%. The `standard` preset takes the best mean, so this is a preset exception. The time is an estimate. | `npm run questions -- Q4` pooled for Sonnet medium and high, then replay. |
| P Q7 beside Q1, Q4 beside Q5 | 16.8 | 214 | 69.1k | 62 | None by construction: the inputs are the same. The wasted calls: Q1 on the 15% of children that Q7 rejects, Q5 on the 13% duplicates. The 1% of Q4 answers that say `stale` (the `negate` input of Q5) rerun Q5. | Replay: the outcomes and the written facts equal the sequential run on the same requests. |
| M Q4 and Q5 in one call (Q4 returns the draft when it accepts), with P for Q7 and Q1 | 17.5 | 206 | 40.9k | 105 | High. A new prompt, a new schema, a new test set; Q4 on Opus would draft instead of Haiku. The narrow-question design is changed. Q5 on Opus medium scores 100% in the sets, so the draft is not the risk; the one prompt is. | A new set from the logged Q4 and Q5 pairs; the Q4 and Q5 tests on the merged output; replay. The owner decides the design change. |
| K children skip Q7 (compound children then run Q1 and Q4) | 24.1 | 149 | 65.3k | 66 | 93 of 654 children (14.2%) are rejected as compound by Q7 today, and none reaches Q4. They would cost Q1 and Q4 (18 s) instead of 7 s. It relies on Q4 rejecting a compound claim at the first attempt (the B-011 fix); I did not check that it is on the branch. 3 children are rejected as unsupported by Q7. Tokens rise by 1.1k. | Not recommended. P gives the same time with no change of the checks. |

Stacks:

| Stack | s/child | Time cap /h | Weighted tok/child | Raw tok/child | Token cap /h | Effective /h | Hours for 1,740 | Share of the week |
|---|---|---|---|---|---|---|---|---|
| S0 today | 27.9 | 129 | 64.2k | 51.4k | 67 | 67 | 26.1 | 140% |
| S1 = L1 + L2A + L3 | 26.9 | 134 | 26.7k | 29.6k | 160 | 134 | 13.0 | 58% |
| S1B = L1 + L2B + L3 | 26.9 | 134 | 24.9k | 20.0k | 172 | 134 | 13.0 | 54% |
| S2 = S1 + L4 + P | 14.1 | 256 | 26.6k | 32.3k | 161 | 161 | 10.8 | 58% |
| S2B = S2 with L2B | 14.1 | 256 | 24.5k | 21.1k | 174 | 174 | 10.0 | 53% |
| S3 = S2 + L6 | 11.6 | 311 | 26.6k | 32.3k | 161 | 161 | 10.8 | 58% |
| S3B = S3 with L2B | 11.6 | 311 | 24.5k | 21.1k | 174 | 174 | 10.0 | 53% |
| S4 = S3 + L5 (untested) | 10.7 | 338 | 24.0k | 31.8k | 178 | 178 | 9.8 | 52% |
| SM = L1 + L3 + L4 + M | 14.7 | 245 | 15.4k | 14.9k | 279 | 245 | 7.1 | 33% |
| SM6 = SM + L6 | 11.3 | 318 | 15.4k | 14.9k | 279 | 279 | 6.2 | 33% |
| S3 with 2 workers (grouping, 1.97 times) | 11.6 | 613 | 26.6k | 32.3k | 161 | 161 | 10.8 | 58% |

- "Share of the week" is 1,740 children over the 80M weighted tokens of the weekly proxy. Today the queue does not fit in one week.
- The raw tokens fall less than the weighted ones in S2 and S3 because L2A turns 12k of cache write into cache read. If the login counts a read like a write, L2B is the better lever (21.1k raw against 32.3k).
- The fixed 2.9 to 4.9 s per call and the 1.3k that the CLI adds to each call are not touched by any lever above. With the SDK (an API key) the 1.3k would go. With 4 calls per child they are 5.2k tokens of the 24.5k of S3B.

## Tests that did not support a lever

- An exact duplicate in code: of 145 duplicates, 1 has a change text equal to the text of the fact it duplicates, and 7 have a word overlap (Jaccard) of 0.8 or more. A check before Q4 would skip 0.7% to 5% of the Q4 calls.
- Q1 decided by the embedding distance: for 279 logged Q1 calls (60% with a match), I embedded the change and every version of every candidate as gather does. Matched candidates sit at a distance of 0.26 (median) to 0.40 (p99); candidates without a match sit at 0.12 to 0.35. Above a distance of 0.30 there are 62 calls and 24 of them have a match, so skipping Q1 there is wrong in 39% of the cases. The distance does not separate (`scripts/q1-distance.ts`).
- Q7 for children (row K above).
- `--bare` (no login).

## Targets for "Queue keeps up"

Proposed, for the requirement and the issue:

| Number | Today | Target | How the stack gets there |
|---|---|---|---|
| Weighted tokens per child | 64.2k | 27k or less | S1 (26.7k). Stretch 15k (SM). |
| Raw tokens per child | 51.4k | 33k or less | S2 (32.3k). |
| Requests per hour at full duty | 129 | 250 or more | S2 (256), S3 (311). |
| Requests per hour inside the rate limit | 67 | 160 or more | S2 (161). |
| Hours for a burst of 1,740 inside the rate limit | 26.1 | 11 or less (2 session windows) | S2 (10.8). |
| Hours for a burst of 1,800 | 27.0 | 11.2 or less | S2 (11.2 = 1,800 / 161). |
| Share of a week's tokens that a 1,800 burst uses | 144% | 60% or less | S2 (60%). |
| Wall rate over the 51 hours since the queue filled | 29 per hour | 100 per hour or more | Today 15% busy, 36% paused by the limit, 49% not running. S2 spends 805 requests per 5-hour window at the token cap, so a burst of 1,800 takes 2.2 windows and the worker should sleep to the reset time, not double its wait. |

- The target is stated in weighted tokens because the login's weights are unknown. Measure it again after the change from the weekly and session numbers in the store (a pause with "resets <time>" in the worker error log).
- The queue arrives faster than 161 per hour only in a burst of a fill. In steady state the arrivals are a few per hour, so the target is about the burst.

## Order to do it

1. L1 (Q4, Q2, Q3 without the wiki block). One line per spec. It takes 30% of the tokens (64.2k to 46.1k) and no time.
2. L3 (related facts) and L2A (Q5 list in the system prompt). Together with L1: 26.7k per child, 2.4 times fewer.
3. P (Q7 beside Q1, Q4 beside Q5) and L4 (efforts). 256 per hour at full duty, 1.99 times. P needs a replay equality test.
4. L6 (Q4 on Sonnet medium), after the Q4 test: 311 per hour.
5. M (Q4 and Q5 in one call) only if the owner wants 279 per hour inside the limit; it is a design change.

## Calls to run

None was run (expired login). When the login is back, in this order, each one call except where noted. A Q4 call costs about 26k tokens (23k written), a Q1 or Q7 call about 3k, the tiny call under 1k. The 8 calls together cost about 150k tokens, which is 0.9% of one session window:

1. `tiny`, `base`: a 1-word Haiku call, to read the usage of a call with no material. This gives the CLI's own additions and the process start. 1 call.
2. Q4 `base` twice within 1 minute: the cache read of the second call. Expected: 2.9k read, 23k written both times. 2 calls.
3. Q4 `nocat` (no wiki block): expected cw about 7k. 1 call.
4. Q4 `syscat` (wiki block in the system prompt) twice within 1 minute: expected cache read above 15k on the second call. 2 calls.
5. Q1 `base` and Q7 `base` with the effort set to low through a small change of `scripts/token-probe.ts`: hidden output tokens against 387 and 403. 2 calls.

`npx tsx scripts/token-probe.ts <calls-log> <question> <nth> <variant> [bare]` runs them with the arguments of `cliArgs` and prints the usage, the wall time and the answer.

## Open

- The weights of the login for cache read and write. One day of a worker run with L1 alone, against the session numbers, would show them.
- The 1.3k tokens that the CLI adds at each call: their text.
- The effect of the effort `low` on the hidden tokens of Q1 and Q7, and of the thinking switch on Q5.
- The question tests for L1, L2A, L3, L4 and L6 and the replay for P, as in the table.
- Whether Q4 rejects a compound claim at the first attempt on `build` (row K).
