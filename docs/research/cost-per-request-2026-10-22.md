# Cost per request, tokens and dollars, 2026-10-22

Issue #16. The study of the requirements "Known cost", "Cache use" and "Queue keeps up" ([throughput note of 2026-10-19](throughput-2026-10-19.md), issue #15). Data: a copy of the store of the wiki `wikifact` taken at 2026-10-22 19:11 UTC with the SQLite backup API (the 4-line `better-sqlite3` `backup` call of the old `scripts/backup-db-copy.cjs`, which is no longer in the tree). `model_calls` holds 7,242 rows from 2026-10-16 20:22. No model call was made; every number comes from stored rows, the code at v0.1.81 and the result files of the question tests. All times are UTC.

## Result

- A split child costs $0.116 and 96.3k raw tokens now (56.0k weighted), against $0.120 and 52.6k raw (65.7k weighted) on 2026-10-19. The dollars did not fall (-3%), the weighted tokens fell 15%, and the raw tokens rose 83% because a cache read now counts as a token. For the same outcome the cost rose: an accepted child costs $0.147 now against $0.137 (+7%), a duplicate child $0.154 against $0.143.
- The one lever of the throughput note that is built, the cached prefix (v0.1.70), works: the share of Q4 calls that read the wiki block from the cache went from 1.1% to 86.5% (Q5: 0.8% to 87.3%), and a Q4 call costs $0.079 against $0.106 although its prompt grew 72% (26.0k to 44.8k tokens, because the wiki block grew from 288 to 501 entries). Without the cache a Q4 call would cost about $0.19 today. The saving is eaten by two things: the reconciliation of a batch adds about 1 Q1 call to each child ($0.025 per accepted child, +17%), and the Q2 question moved from Haiku to Sonnet.
- Q4 is 60% of the dollars of a child (Opus, high effort; $0.070 of $0.116) and the wiki block is about 33k of its 44.8k tokens. Q4 does not use it (its prompt says nothing of it). Q5 is 30% of the weighted tokens and needs the list.
- Of the 10 levers of the throughput note, 1 is built (L2A, the cached prefix, in a wider form), 1 in part (P, across requests in the batch, not inside a request), and 8 are not (L1, L2B, L3, L4, L5, L6, M, and K, which the note does not recommend). Two things came after the note that it did not name: the group questions Q7B, Q5B and Q15 (built, then removed in v0.1.73 for quality), and the batch reconciliation (a new cost).
- Top 3 levers not built, per child (base $0.116, 96.3k raw, 56.0k weighted tokens, 40.5 s of calls):
  1. L1, Q4, Q2 and Q3 without the wiki block: -$0.028 (-24%), -37k raw tokens (-39%), -10.2k weighted (-18%), no change of time, no quality risk that a test can see. One scope for all three numbers: the Q4, Q2 and Q3 calls of the 117 children of E2 (0.93, 0.15 and 0.05 calls per child), 33k tokens of list per call (see "Method and limits").
  2. L6, Q4 on Sonnet medium: -$0.035 (-30%), no change of tokens, -2 s of time, -1.5 points of Q4 accuracy in the question set (96.6% against 98.1%). With L1 together: -$0.051 (-44%) (L1 saves half as much on a Sonnet Q4 call: $0.012 for Q4 plus $0.005 for Q2 and Q3, on top of the $0.035).
  3. One Q1 for all pairs of the same newer fact in the reconciliation: -$0.005 to -$0.008 (-4 to -7%), -2k to -3k raw tokens, and 4 to 6 s less of a serial tail in each batch. An estimate; the number of pairs per newer fact is not in the rows.
- With the three, a child costs $0.057 to $0.060 (0.1161 - 0.051 - (0.005 to 0.008)) and 56.1k to 57.1k raw tokens (96.3k - 37.2k - (2k to 3k)), and weighs 43.3k to 44.3k (56.0k - 10.2k - 0 - (1.5k to 2.5k)). The target of the throughput note (27k weighted per child) is not reached by them. No sum of the levers of the table reaches it: all of them but M, P and the Q4 pick of Haiku give 33.6k at best, and with M about 29.9k at best (see "The target" below).

## Method and limits

- Window: the rows since 2026-10-20 00:12 UTC, the copy time of the throughput note (2.8 days, v0.1.52 to v0.1.80; the three days of the task begin 2026-10-19 19:11 and the store has no row between 2026-10-18 and 2026-10-20 00:12). The rows before it (2026-10-16 to 2026-10-18, v0.1.40 to v0.1.51) are the data of the throughput note; I call them E0 and recomputed them with the same query as the new rows, so the comparison needs no other source. They reproduce that note (child 52.6k raw, 65.7k weighted, 28.0 s; the note has 51.4k, 64.2k, 27.9 s).
- Three eras by the version in force (the tag time of `git tag`; a deploy follows within minutes):

| Era | Rows | Versions | What is special |
|---|---|---|---|
| E0 | 2026-10-16 20:22 to 2026-10-20 00:12 | v0.1.40 to v0.1.51 | The data of the throughput note. Wiki block in the user message, never cached. |
| E1 | 2026-10-20 00:12 to 2026-10-22 00:31 | v0.1.52 to v0.1.69 | Group questions Q7B, Q5B, Q15 drain 1,954 requests (2026-10-21 01:00 to 06:00); few per-request rows. Not comparable. |
| E2 | 2026-10-22 17:44 to 19:11 | v0.1.79, v0.1.80 (deployed 19:01) | The cached prefix (v0.1.70) and the batch of the full pipeline in parallel with a reconciliation (v0.1.73). 167 submission requests: 117 children, 50 top-level. |

- The versions v0.1.70 to v0.1.78 left no row in `model_calls` between the end of E1 and the start of E2. I made a new copy of the store with the SQLite backup API (the `better-sqlite3` `backup` call; 7,409 rows to 2026-10-22 19:27:48) and counted the rows from 2026-10-22 00:31 (the tag time of v0.1.70) to 17:44 (the start of E2): 0. The last row before E2 is at 2026-10-21 05:43:30 (the end of the group-question drain, in E1); the next row is the first row of E2 at 2026-10-22 17:44:57. Nothing is left out of E2. (v0.1.79 was tagged at 2026-10-22 07:07; the worker made no call until the afternoon.)
- E2 is one afternoon of dogfood traffic: the samples are small (117 children, 50 top-level requests, 126 Q4 calls). The accepted share (64% of children) and the mix differ from E0 (73%). I compare by outcome where it matters.
- Dollars follow `config/prices.json`, as the console cost signal does (`tokenCost` in `src/store/signals.ts`): input and cache write at the input price, cache read at 0.1 times, output at the output price, per model (Haiku 0.1/0.5, Sonnet 2/10, Opus 4/20 USD per million). The table has no write premium. With the API premium of 1.25 on a cache write, a child costs $0.134 now against $0.144 (E0) and a top-level request $0.077 against $0.060; the ratios of the levers change by a few points.
- Weighted tokens = in + 5 * out + 0.1 * cache read + 1.25 * cache write, as in the throughput note. The weights of the login are still unknown.
- A request is a `change_requests` row with `model_calls` rows, classed by `parent_id` (child or top-level) and the outcome of its last `changes` row. The era of a request is the era of its first call. Seconds are the sum of `duration_ms` of the calls; the batch runs several requests at once, so they are not wall time per request.
- Rows I could not use: the 1,954 requests of the group-question drain in E1 have no rows of their own (the group calls are logged under one request of the group). The cost of that drain is the sum of all calls in the span.
- The calls of the reconciliation (Q1, Q2, Q3 after the Q4/Q5 of the request) are attributed to the request of the newer fact of the pair by `reconcileBatch`. I identify them as the Q1, Q2 and Q3 calls of an accepted request that come after its last Q4, Q5, Q8 or Q9 call (7 to 8 minutes later in the samples). This is an inference from `src/updates/batch/reconcile.ts` and the timing; the rows have no field for it (`batch_id` is not in the table any more).
- The cause of the 14 cache misses of Q4 within 5 minutes of the previous call is not in the rows: 4 start within 10 s of the previous call (a parallel start), 10 do not. The wiki block changed between them, probably, but I could not show it.
- Wiki block size: 501 live entries, 86,944 characters in `renderCtx` form. By the stored prefix of a Q4 hit (36.5k cache read less about 3.8k of CLI, system prompt and schema) the list is about 33k tokens. Q2 and Q3 also use `renderCtx`, and their hits read 35.7k and 35.6k, so the list is about 33k in them too.
- The L1 cut (rank 1) is computed from the rows of the 117 children of E2 (582 calls; submission requests with a `parent_id`, 2026-10-22 17:44 to 19:11:55). For each Q4, Q2 and Q3 call the 33k tokens of the list leave the prompt: a call that read the cache (cache read above 10k) loses 33k raw and 3.3k weighted (0.1 each), a call that wrote it loses 33k raw and 41.3k weighted (1.25 each); dollars at the model's input price, 0.1 times for a read. Child calls that read the cache: Q4 98 of 109 (89.9%; 86.5% over the 126 calls of all requests), Q2 10 of 17, Q3 4 of 6. Per child: Q4 30.7k raw, 6.6k weighted, $0.0235; Q2 4.8k, 2.75k, $0.0045; Q3 1.7k, 0.8k, $0.0001; together 37.2k raw, 10.2k weighted, $0.028. The earlier figures (-31k raw, -8.8k weighted) counted Q4 only (with a rate of 86.5% for the dollars). The rest of the prompt (about 3k to 5k) is assumed to be cached as before.

## Tokens and dollars of one call, per question

Submission requests only. Mean per call; the input is 2 tokens in every row, so the column is dropped. `cw` cache write, `cr` cache read, `out` output. Seconds are the call duration. Dollars by `config/prices.json`.

| Question | Model, effort | Era | Calls | cw | cr | out | Seconds | $ per call |
|---|---|---|---|---|---|---|---|---|
| Q7 | Sonnet medium | E0 | 2,072 | 1,422 | 1,338 | 498 | 6.5 | 0.0081 |
| Q7 | Sonnet medium | E2 | 189 | 1,907 | 1,484 | 412 | 7.8 | 0.0082 |
| Q1 | Opus medium | E0 | 1,052 | 1,879 | 1,036 | 399 | 7.5 | 0.0159 |
| Q1 | Opus medium | E2 | 262 | 2,262 | 1,018 | 331 | 7.1 | 0.0161 |
| Q4 | Opus high | E0 | 1,039 | 22,881 | 2,882 | 646 | 10.4 | 0.1056 |
| Q4 | Opus high | E2 | 126 | 13,087 | 31,680 | 716 | 11.0 | 0.0793 |
| Q5 | Haiku low | E0 | 890 | 22,943 | 2,309 | 932 | 7.7 | 0.0028 |
| Q5 | Haiku low | E2 | 102 | 12,687 | 31,479 | 946 | 8.5 | 0.0021 |
| Q2 | Haiku low (E0), Sonnet medium (E2) | E0 | 70 | 17,803 | 985 | 538 | 6.4 | 0.0021 |
| Q2 | | E2 | 21 | 17,876 | 20,526 | 236 | 8.0 | 0.0422 |
| Q3 | Haiku low | E0 | 60 | 17,722 | 1,615 | 617 | 5.7 | 0.0021 |
| Q3 | Haiku low | E2 | 8 | 20,574 | 18,153 | 722 | 8.5 | 0.0026 |

- The Q4 hit and miss in E2: a hit (109 calls) writes 8.2k and reads 36.5k tokens and costs $0.0615; a miss (17 calls) writes 44.1k and costs $0.1938, 3.2 times more. For Q5 a hit costs $0.0016 and a miss $0.0049.
- E1 (v0.1.52 to v0.1.69) is left out of the table: its per-request rows are few and mixed with the group calls. The group calls were: Q7B (Opus medium) 27 calls, 9.6k cw, 7.4k out, 64 s, $0.19 each; Q5B (Haiku low) 38 calls, $0.008 each; Q15 (Sonnet medium) 30 calls, 56k cw, 5.9k out, 50 s, $0.17 each.

## Calls, tokens and dollars of one request

Calls per request for each question (the number of calls of the question over all requests of the class, so a question that does not always run is below 1).

| Class, era | n | Q7 | Q1 | Q4 | Q5 | Q2 | Q3 | Calls |
|---|---|---|---|---|---|---|---|---|
| Child, E0 | 616 | 1.02 | 0.87 | 0.87 | 0.73 | 0.05 | 0.05 | 3.60 |
| Child, E2 | 117 | 1.19 | 1.86 | 0.93 | 0.77 | 0.15 | 0.05 | 4.97 |
| Top-level, E0 | 1,430 | 1.01 | 0.36 | 0.35 | 0.31 | 0.03 | 0.02 | 2.09 |
| Top-level, E2 | 50 | 1.00 | 0.88 | 0.34 | 0.24 | 0.08 | 0.04 | 2.58 |

Of the 1.86 Q1 calls of a child in E2, 0.93 are reconciliation calls (115 calls in 43 of the 75 accepted children, plus Q2 and Q3 of the merges). In E0 the reconciliation did not exist.

Totals per request. Raw tokens = in + cw + cr + out.

| Request | Era | n | Calls | Raw tokens | Weighted | Seconds of calls | Dollars |
|---|---|---|---|---|---|---|---|
| Child, all | E0 | 616 | 3.60 | 52,612 | 65,727 | 28.0 | 0.1200 |
| Child, all | E2 | 117 | 4.97 | 96,338 | 55,985 | 40.5 | 0.1161 |
| Child, accepted | E0 | 451 | 4.18 | 64,317 | 80,300 | 32.8 | 0.1372 |
| Child, accepted | E2 | 75 | 6.40 | 128,030 | 74,300 | 51.2 | 0.1472 |
| Child, duplicate | E0 | 74 | 3.14 | 39,937 | | 23.7 | 0.1431 |
| Child, duplicate | E2 | 8 | 5.13 | 106,096 | | 41.8 | 0.1537 |
| Child, rejected as compound | E0 | 86 | 1.00 | 3,418 | | 7.0 | 0.0092 |
| Child, rejected as compound | E2 | 24 | 1.00 | 3,963 | | 9.8 | 0.0103 |
| Top-level, all (66% are splits) | E0 | 1,430 | 2.09 | 21,952 | 28,203 | 16.1 | 0.0507 |
| Top-level, all (66% are splits) | E2 | 50 | 2.58 | 38,048 | 34,094 | 22.3 | 0.0661 |
| Top-level, split | E0 | 932 | 1.00 | 3,379 | | 7.0 | 0.0092 |
| Top-level, split | E2 | 33 | 1.00 | 4,248 | | 9.5 | 0.0125 |
| Top-level, accepted (no split) | E0 | 438 | 4.22 | 59,436 | | 33.8 | 0.1288 |
| Top-level, accepted (no split) | E2 | 12 | 6.58 | 118,285 | | 55.0 | 0.1749 |

A submission with its children (the root and all its descendants):

| Root | Era | n | Children | Calls | Raw tokens | Seconds of calls | Dollars |
|---|---|---|---|---|---|---|---|
| Not split | E0 | 1,136 | 0 | 2.37 | 26,797 | 18.3 | 0.0615 |
| Not split | E2 | 17 | 0 | 5.65 | 103,660 | 47.1 | 0.1704 |
| Split | E0 | 295 | 2.34 | 9.26 | 132,764 | 84.0 | 0.3069 |
| Split | E2 | 33 | 3.55 | 18.64 | 345,811 | 152.9 | 0.4241 |

- The E2 roots cost more than the E0 roots by the mix (E0 has many early rejections; the E2 requests are the owner's own claims, mostly accepted) and by the reconciliation. Use the rows by outcome for a like-for-like reading: +7% for an accepted child.
- Where the dollars of a child go in E2 ($0.116): Q4 60% ($0.070), Q1 26% ($0.030, half of it the reconciliation), Q7 7%, Q2 5%, Q5 1%. In E0 ($0.120): Q4 80%, Q1 12%, Q7 6%, Q5 2%.
- Where the weighted tokens of a child go in E2 (56.0k): Q4 36% (20k), Q5 30% (17k), Q1 15% (8.6k), Q7 9%, Q2 7%. Q5 costs few dollars (Haiku at 0.1 USD per million) but many tokens.
- Requests that are not change requests: cleanupRepair and lookupRepair requests were $5.79 of the $22.68 of E2 (25.5%). A cleanupRepair request costs $0.0405 in E2 against $0.0095 in E0; Q14 (Opus medium, wiki block in its prefix) is $4.20 of it, 60 calls at $0.07. The cleanup is not a cost per change request; it follows the cleanup trigger. In E1 the same Q14 cost $19.17 in 120 calls ($0.16 each, 34k tokens written each) before the cache.
- The whole window, all kinds of request: $64.41 for 1,688 calls (E1 $41.73, E2 $22.68).

## The drain by group questions (E1), for reference

On 2026-10-21 01:00 to 06:00 the worker took 1,954 submissions through the group questions (v0.1.65 to v0.1.68). The calls of submissions in that span cost $13.22 in all (Q7B $5.06, Q15 $5.15, Q4 $2.23, rest $0.8): $0.0068 per request, 9 to 17 times less than a request of the 1-at-a-time path ($0.06 to $0.12). The owner then chose the full pipeline in parallel plus a reconciliation: at 5 requests the group path accepted 2 compound claims that Q4 rejects. "If we want to make it cheaper then that's a separate problem": this note is that problem.

## The levers of the throughput note

Rates are per split child. "Built" is shown by the code at v0.1.81 and by the rows.

| Lever | Built? | Evidence | What it saved (rows before and after) |
|---|---|---|---|
| L1 Q4, Q2, Q3 without the wiki block | No | `q4.ts`, `q2.ts`, `q3.ts` still set `wiki: renderCtx`; Q4 prompt is 44.8k tokens, about 33k the list. Q11 and Q12 use `renderSubject` (no list). | Nothing. |
| L2A wiki block in the cached prefix | Yes, wider: every question with a wiki block (v0.1.70; commits 6e0220b, 9e0cb82) | Rows of E2: Q4 cache read 31.7k per call. | Q4 hit rate 1.1% to 86.5%, Q5 0.8% to 87.3%. Q4 $0.1056 to $0.0793 (-25%) and Q5 $0.0028 to $0.0021 (-25%) although the prompts grew 72%; against no cache at today's size (about $0.19) it saves $0.114 per Q4 call (59%). Child weighted tokens 65.7k to 56.0k (-15%), dollars -3% after the reconciliation (+$0.025 per accepted child) and the move of Q2 to Sonnet. |
| L2B Q5 gets the names and 30 near descriptions | No | `q5.ts` uses `renderCtx`. | Nothing. |
| L3 related facts: current version, top 6 | No | `renderFact` prints every version; `gather.ts` changed only by a refactor since the note. | Nothing. |
| L4 Q1 on Opus low, Q7 on Sonnet low | No | `config/presets.json`: `standard` has Q1 Opus medium, Q7 Sonnet medium; rows of E2 show the same. | Nothing. |
| L5 thinking off for Q5 | No | No thinking switch in `src/updates/questions/`. | Nothing. |
| L6 Q4 on Sonnet medium | No | `standard` keeps Q4 on Opus high; E2 rows. | Nothing. |
| P Q7 beside Q1, Q4 beside Q5 | Not inside a request. Across requests, yes (the batch, v0.1.73). | The calls of one request run in sequence (Q7 17:49:03, Q1 :08, Q4 :19, Q5 :26). | The batch is 2.0 times faster at 100 requests ([bulk note](bulk-test-real-2026-10-22.md)) and costs 1.23 times more. No change of tokens per request. |
| M Q4 and Q5 in one call | No | Q4 and Q5 are separate specs. | Nothing. |
| K children skip Q7 | No (not recommended in the note) | | |
| Q4 rejects a compound claim at the first attempt (the open item of the note) | Yes, v0.1.52 (commit ec4f3d2) | | Not a saving. It is the premise of K. |

Built but not in the note:

- Group questions Q7B, Q5B, Q15 (v0.1.61 to v0.1.68; removed in v0.1.73): $0.0068 per request on the drain, 90% below the sequential path, removed for quality (see above).
- The system prompt in a file for the CLI transport (v0.1.70, commit 9e0cb82): it lets the wiki block fit the command line; no change of tokens.

Added cost since the note: the reconciliation of a batch (`reconcileBatch`, v0.1.73) runs the duplicate fact repair for each staged fact against its 3 nearest live facts, one Q1 per pair. In E2 it is 131 Q1, 8 Q2 and 5 Q3 calls for 87 accepted requests: $2.33 of $16.89 of the submission requests (14%), $0.027 per accepted request. It also runs one pair after the other (`await` in a loop): 1,002 s of calls in the sample, while the pipeline calls of the requests run in parallel.

## Levers not built, ranked

Base: a child in E2, $0.1161, 96.3k raw tokens, 56.0k weighted tokens, 40.5 s of calls, 4.97 calls. Q4 runs 0.93 times, Q5 0.77, Q1 1.86 and Q2 0.15 per child. Savings are estimates from the stored token mix at the prices of the table, except where marked. The rank is by dollars and tokens saved per child with the quality risk counted; time is the third column for #15.

| Rank | Lever | $ per child | Raw tokens | Weighted tokens | Time | Quality risk | Test that proves no loss (run in the build of the lever) |
|---|---|---|---|---|---|---|---|
| 1 | L1: Q4, Q2 and Q3 get the subject, not the wiki block (`renderSubject`) | -0.028 (-24%): Q4 -0.0235 (the list costs 0.19 of a full write on average at the child hit rate of 89.9%: 0.93 calls * 33k tokens * $4 per million * 0.191), Q2 -0.0045, Q3 -0.0001 | -37k (-39%): Q4 -30.7k, Q2 -4.8k, Q3 -1.7k | -10.2k (-18%): Q4 -6.6k, Q2 -2.75k, Q3 -0.8k | None; the input size has almost no effect on time | Low. The Q4 prompt does not use the wiki block. Q2 and Q3 take the names from the facts. | Question test Q4 on the 79 cases (the 30 cases with their own `ctx` carry the list in the old run; run them with the subject only), then Q2 and Q3. Bar: Q4 mean 97.5% or more, no run under 96% (last pooled run 98.1%, min 97.5%), 3 runs. Then the replay: same outcomes as the run with the list. |
| 2 | L6: Q4 on Sonnet medium (a `questions.Q4` entry; no code) | -0.035 (-30%): half of the Q4 dollars, same tokens | 0 | 0 | About -2 s per Q4 call (api p50 3.9 s against 5.9 s in the set) | Small. Question set, 6 runs: Sonnet medium 96.6% (min 94.9%), Opus high 98.1% (min 97.5%); both pass the bar of 90% and 85%. The `standard` preset takes the best mean for judgment, so this is a preset exception (the owner). Q4 guards the accept of a wrong claim. | `npm run questions -- Q4` pooled for Sonnet medium and high, then the replay with no critical miss (the note on the presets records 0 critical misses in 4 runs of a Sonnet table, 2 in 7 of the budget table). With L1 together: -0.051 (-44%). |
| 3 | R: one Q1 for the pairs of the same newer fact in the reconciliation, and the Q1 calls of the pairs run at the same time (the merges stay in order) | -0.005 to -0.008 (-4 to -7%); -0.008 to -0.012 per accepted child. Estimate: 131 Q1 calls for 87 accepted requests; one per newer fact is at least 87. | -2k to -3k | -1.5k to -2.5k | -4 to -6 s of serial tail per accepted request of a batch; more if the Q1 calls run in parallel | Low to medium. A pair of the same newer fact gets the same claim and nearly the same candidates; the answers should not differ. A merge decided on a changed pair would. | Count the pairs per newer fact in a batch run first (not in the rows). Then the replay: the merges and the written facts equal the per-pair run on the same batch; Q1 set unchanged. |
| 4 | L2B: Q5 gets all names and the descriptions of about 30 near entries | -0.0004 (Q5 is Haiku) | -20k (-21%) | -4.9k (-9%) | None | Medium. Q5 reads the description of each entry; an entry left out cannot be chosen. | Q5 set (73 cases) plus the recall check: every entry of the expected answer is in the subset, on the set and on 300 logged Q5 calls. |
| 5 | L4: Q1 on Opus low, Q7 on Sonnet low | -0.007 to -0.012 (-6 to -10%; the hidden token cut is an estimate, 130 to 250 tokens a call) | -0.5k | -0.8k | About -2.5 s per child | Small. Q1 Opus low 93.0% (min 92.5%) against 94.0%, Q7 Sonnet low 93.4% (min 93.0%) against 94.4%. | `npm run questions` for Q1 and Q7 pooled, then one timed call each to measure the real cut. |
| 6 | L3: related facts, current version, top 6 | -0.009 (about 2.5k tokens a Q4 call at $4 per million, 0.93 calls) | -4.6k | -3.5k | None | Low to medium. 17 of 18 wrong-related answers in the old logs sit in the first 3 related facts. | Question test Q4 on the cases with `wrongRelated`, Q5, replay. Top 8 if one case fails. |
| 7 | Warm-first for parallel calls (the requirement "Cache use") | -0.004 (4 of 17 Q4 misses start within 10 s of the previous call) | -1k | -0.5k | The other calls wait once per batch for the first call (about 10 s) | None by construction. | Rows of a batch run: share of calls with cache read above 10k (86.5% now). |
| 8 | M: Q4 and Q5 in one call | about 0 (Q5 is $0.0015 a child; the merged call would be priced as Q4) | -34k (-35%) | -17k (-30%) | -8 s (one call less) | High. New prompt, schema and set; the narrow-question design changes. | A new set from the logged Q4 and Q5 pairs, the Q4 and Q5 tests on the merged answer, replay. The owner decides. |
| 9 | P inside a request: Q7 beside Q1, Q4 beside Q5 | +0.003 (waste on the 20% compound and 7% duplicate children) | +1.5k | +1k | -16 s of 40 s of calls of a child | None by construction. | Replay: same outcomes and facts as the sequential run. |
| 10 | Q4 on Haiku low (the `budget` pick) | -0.068 (-59%) | 0 | 0 | -1 s | High. Q4 set: Haiku low 90.7% (min 89.9%) against 98.1%; the `budget` table had critical misses in 2 of 7 replay runs. | Not recommended before a replay of 6 runs with 0 critical misses. |

The savings are estimates from the stored rows; the question test and the replay of each lever run when the lever is built, because each test needs the changed prompt.

- Time and #15: the token levers (L1, L2B, L3) leave the time as it is, so they raise the rate only while the tokens bind (the cap of the login). L6, L4 and P cut time as well. R cuts the serial tail of a batch.
- The target. Sums from the table, per child, on the base of 56.0k weighted tokens:
  - Ranks 1 to 3 (L1, L6, R): 56.0k - 10.2k - 0 - (1.5k to 2.5k) = 43.3k to 44.3k weighted; $0.1161 - 0.051 - (0.005 to 0.008) = $0.057 to $0.060; 96.3k - 37.2k - (2k to 3k) = 56.1k to 57.1k raw.
  - Adding L2B (-4.9k) and L3 (-3.5k): 43.3k to 44.3k - 4.9k - 3.5k = 34.9k to 35.9k weighted.
  - Adding L4 (-0.8k) and warm-first (-0.5k) as well (every lever but M, P and the Q4 pick of Haiku, R at its best): 56.0k - 10.2k - 2.5k - 4.9k - 3.5k - 0.8k - 0.5k = 33.6k.
  - Adding M: the table rows are not additive here. M takes away the whole Q5 call (-17k), so L2B (inside that call) adds nothing, and the merged call needs the wiki block for the Q5 part, so L1 keeps only its cut on Q2 and Q3 (-2.75k and -0.8k) and loses the cut on Q4 (-6.6k). L3 cuts Q4 and Q5, and its raw cut is about half on Q4 (2.3k of 4.6k), so with M it keeps about half of its weighted cut (-1.75k of -3.5k). Best case: 56.0k - 17.0k - 3.55k - 2.5k - 1.75k - 0.8k - 0.5k = about 29.9k.
  - The answer for 27k: no combination of the levers of the table reaches it; the best, with M and all others, is about 29.9k, and without M 33.6k. It needs a cut that the table does not hold, of about 2.9k or more beyond the best case: the clean candidate is the merged call of M with the near-entry subset of L2B in place of the full list, which would keep the L1 cut on Q4. That candidate is not measured.
- The wiki block grows with the wiki (288 entries on 2026-10-19, 501 now, 33k tokens). Every question with the block in its prefix pays a write when the block changes and a read at each call. L1 stops Q4 from paying for it.

## Open

- Whether the hidden thinking tokens fall at `low` effort (L4) and with thinking off (L5): the throughput note's open item, still not measured. No login problem now, but no call was made here.
- The pairs per newer fact in a batch (rank 3). A batch run on a copy of the store, with the log lines of the reconciliation, shows it.
- The cause of the Q4 misses within 5 minutes of a write (10 of 14): compare the hash of the wiki block of two consecutive calls in the call log.
- The weights of the login for a cache read and a cache write; the dollars and the weighted tokens differ by 15% on this alone.
- The Anthropic transport (an API key) is not measured: the cache numbers here are the CLI transport.
