# Worker throughput, 2026-10-19

The measurement phase of backlog item B-010 (a bulk mode for the update worker). The data is the dogfood store `wikifact` as of 2026-10-20 00:12 UTC (2026-10-19 17:12 in Los Angeles), read from a copy. No model call was made and no worker was started. All times are UTC. Los Angeles time is UTC minus 7 hours.

## Result

- The worker is bound by the model, not by the code. Non-model work (gather, embedding, search, lint, write) is 0.6% of the time of a submission (229 s of 39,862 s).
- At full duty the worker does 204 requests per hour (6 hours at 99% duty, range 140 to 230). The 1,728 children of splits that wait in the queue cost 28.0 s each, so 129 requests per hour, and 13.4 hours of worker time.
- The wall rate is 29 requests per hour. Over the 51.4 hours since the queue filled (2026-10-17 20:47 to 2026-10-20 00:12) the worker was busy 7.9 hours (15%). It was paused by the model rate limit for 18.3 hours (36%) and did not run for the other 25 hours (49%; the machine slept or the worker was down, the store does not say which).
- The rate limit is the binding cap, and it is a quota of the login (weekly and 5-hour session), not a burst limit. One worker already hit the weekly limit after 12.9 busy hours in the cycle. A second or fourth worker would reach the same limit sooner and raise the work done per week by 0.
- Every model call costs a fixed 3.7 to 3.9 s before the first output token (the intercept of duration against output tokens, for all 3 models). A submission makes 3.8 calls, so 14 s of its 32 s is this fixed part.
- Parallel requests on disjoint facts work only if siblings of a split are not queued next to each other. In queue order, a child shares a first dedupe search with the child before it in 55% of the cases, and children of 1 split are queued together. With the order spread across splits, 4 workers reach 2.6 times (grouping) or 3.9 times (optimistic, 3.7% re-runs), before the rate limit.

## Method and limits

- Window: the last 7 days of the store, 2026-10-13 00:12 to 2026-10-20 00:12 (3,114 requests). The store starts 2026-10-11.
- Time of a request is `finished_at - started_at` of the `change_requests` row. 70 old `submission` rows have no `started_at` and are left out.
- `model_calls` exists from 2026-10-16 20:22. The split of time by question uses the 2,041 submissions after that (3.2 days). Requests before it have a time and no calls.
- Outcome of a request is the outcome of its last `changes` row, or `none` when it wrote no row (a skipped `cleanupRepair`, a `lookupRepair` that needed nothing).
- Model durations are from the CLI transport (`claude -p`, local mode), so they include process start. The store has no number for the embedder alone.
- Gather sets for the conflict analysis are the candidate ids of the Q1 input in the call log (`worker-wikifact-calls.*.log`, 2026-10-14 to now, 1,128 requests), read in place. Write sets are `fact_versions` rows at the `seq` of the request, plus `duplicate_of`.
- The scripts (`a1.cjs` to `a12.cjs`, `lib.cjs`) stayed in a temporary folder outside the repo, because they read a private copy of the store. None is reusable as it stands.

## Time per request

Window, `done` requests. Seconds.

| Kind | Outcome | n | Mean | p50 | p95 |
|---|---|---|---|---|---|
| submission | accepted | 974 | 32.3 | 29.7 | 53.0 |
| submission | duplicate | 134 | 25.1 | 24.2 | 37.8 |
| submission | rejected, compound | 146 | 6.5 | 6.2 | 9.1 |
| submission | rejected, contradicted | 6 | 32.9 | 26.1 | 65.3 |
| submission | rejected, unsupported | 7 | 23.1 | 23.3 | 27.7 |
| submission | split | 939 | 7.0 | 6.5 | 8.8 |
| submission | all | 2,206 | 19.3 | 19.6 | 41.1 |
| cleanupRepair | accepted (a repair) | 120 | 6.6 | 4.4 | 17.0 |
| cleanupRepair | none (no change, or stale) | 771 | 4.4 | 3.8 | 7.0 |
| cleanupRepair | all | 891 | 4.7 | 3.8 | 7.6 |
| lookupRepair | accepted | 3 | 8.3 | 7.1 | 11.0 |
| lookupRepair | none | 12 | 0.0 | 0.0 | 0.0 |
| operatorEdit | none | 2 | 0.07 | 0.07 | 0.08 |

Children of splits (618, since 2026-10-16 20:00): mean 28.0, p50 27.8, p95 48.9. Their outcomes: 451 accepted (32.7 s), 74 duplicate (24.1 s), 86 compound rejects (7.0 s), 7 other. The 1,728 queued children will cost about 48,400 s.

Failures are rare: 5 `failed` rows (all by 2026-10-17 05:25: 2 lint, 3 invalid Q4 output), and 9 more requests passed after 1 or 2 retries. 30 of 2,041 submissions (1.5%) repeat a question.

## Where the time of a submission goes

Per question, window since 2026-10-16 20:22. `out` is the mean output tokens.

| Question | Model and effort | Calls | Mean s | p50 | p95 | out |
|---|---|---|---|---|---|---|
| Q7 | sonnet-5-5 medium | 2,072 | 6.5 | 6.1 | 8.8 | 498 |
| Q1 | opus-5-5 medium | 1,052 | 7.5 | 6.8 | 11.7 | 399 |
| Q4 | opus-5-5 high | 1,039 | 10.4 | 9.5 | 17.2 | 646 |
| Q5 | haiku-5-5 low | 888 | 7.6 | 6.9 | 11.2 | 932 |
| Q2 | haiku-5-5 low | 70 | 6.4 | 5.5 | 8.0 | 538 |
| Q3 | haiku-5-5 low | 60 | 5.7 | 5.1 | 8.2 | 617 |
| Q11 | opus-5-5 low | 352 | 4.7 | 3.9 | 7.7 | 124 |
| Q14 | opus-5-5 medium | 3 | 17.3 | | | 1,641 |

Q6, Q8, Q9, Q10: 19 calls in all, 6 to 8 s each.

The split of the 4 common shapes, in seconds and in share of the request:

| Shape (n) | Total | Q7 | Q1 | Q4 | Q5 | Q2+Q3 | Not model |
|---|---|---|---|---|---|---|---|
| accepted: Q7 Q1 Q4 Q5 (812) | 31.7 | 6.1 (19%) | 7.3 (23%) | 10.1 (32%) | 7.6 (24%) | | 0.6 (2%) |
| duplicate: Q7 Q1 Q4 (120) | 24.2 | 5.6 (23%) | 7.2 (30%) | 11.0 (45%) | | | 0.5 (2%) |
| accepted with a merge: Q7 Q1 Q2 Q3 Q4 Q5 (35) | 51.9 | 6.4 (12%) | 9.9 (19%) | 12.7 (25%) | 8.5 (16%) | 12.3 (23%) | 2.1 (4%) |
| split or compound reject: Q7 (1,017) | 7.0 | 7.0 (99%) | | | | | 0.0 |

Over all 2,041 submissions (39,862 s): Q7 33.8%, Q4 26.7%, Q1 19.6%, Q5 17.0%, Q2 and Q3 1.9%, Q6, Q8 and Q9 0.3%, not model 0.6%. Q7 is the largest share because it runs on every request, children included.

The "not model" part (0.6 s for an accepted request, p95 1.0 s) holds the embedding, the dedupe search, the lint and the write together. The store cannot split it further. At 2%, no lever on it is worth building.

Fixed cost per call. A line of duration against output tokens gives these intercepts:

| Model | Intercept s | s per 1,000 output tokens | Calls |
|---|---|---|---|
| sonnet-5-5 | 3.74 | 5.6 | 2,072 |
| opus-5-5 | 3.89 | 9.6 | 2,446 |
| haiku-5-5 | 3.77 | 4.1 | 1,037 |

The fastest call took 2.9 s (p1: 3.4 s). The intercept holds process start, prompt load and time to the first token. [future.md](../future.md) put the start at about 1 s. So 1 s to 3.8 s of each call is the saving of a transport with no process start; the store cannot tell where in that range it lies.

Tokens of a submission (mean, 2,042): 5 in, 1,480 out, 4,357 cache read, 25,110 cache write. Q4 and Q5 write 22,900 cache tokens per call and read 2,300 to 2,900, so each call pays for a new cache. Q7 and Q1 write 1,400 to 1,900.

## Which outcomes cost what, and when each is decided

Window, 2,206 submissions.

| Outcome | Requests | Share | Seconds | Share of time | Decided at |
|---|---|---|---|---|---|
| accepted | 974 | 44.2% | 31,425 | 73.6% | step 8, the write |
| split | 939 | 42.6% | 6,576 | 15.4% | step 1, Q7, the first call (7.0 s, 22% of an accepted request) |
| duplicate | 134 | 6.1% | 3,361 | 7.9% | step 4, Q4, the third call (24.2 s; only Q5 is saved, 7.6 s) |
| rejected, compound | 146 | 6.6% | 948 | 2.2% | step 1, Q7 |
| rejected, contradicted | 6 | 0.3% | 198 | 0.5% | step 4, Q4 (26 to 33 s) |
| rejected, unsupported | 7 | 0.3% | 162 | 0.4% | step 4, Q4 (3 of 3 after 2026-10-16) |

56% of the requests write no fact and use 26% of the time. The splits are cheap (7 s) but they make the children: 2.5 per split, 2,376 children from 939 splits. 15% of children (103 of 674) end as compound rejects at their own Q7, 7 s each. A child costs 28.0 s on average, 22% of it for the second Q7.

Skipping Q7 for children would save 6.1 s on 85% of them, and would send the 15% that are still compound through the full path. The first wiki measured that path at 3 attempts, 6 drafts and 3 minutes ([technical/updates.md](../technical/updates.md), F22). 86 compound children at 3 minutes cost 15,500 s, against 4,000 s saved. Not worth it.

## Parallel requests

A request conflicts with an earlier one when the earlier one wrote a fact that the later one read or wrote. Three tests, all from the stored rows:

- Write-write (WW): both wrote the same fact.
- Read-write (RW): one wrote a fact that is in the other's gather set (the 20 candidates of the first dedupe search, as Q1 saw them). The optimistic mode (run in parallel, re-run the later request alone on a conflict) needs WW or RW.
- Gather overlap (GG): the 2 gather sets share a fact. The grouping mode (run in parallel only requests that share nothing) needs GG, WW or RW.

Mean gather set: 13.5 facts. 1,118 of 2,200 submissions read the wiki (the others ended at Q7); 1,105 wrote.

Share of requests that conflict with at least 1 of the previous W-1 requests, in processed order since 2026-10-14 (2,200 submissions, 43% of them splits that read nothing):

| Window W | WW | RW (either way) | Optimistic (WW, RW) | Grouping (adds GG) | Windows with at least 1 conflicting pair, optimistic | Same, grouping |
|---|---|---|---|---|---|---|
| 2 | 1.1% | 12.4% | 12.4% | 23.9% | 11.2% | 23.1% |
| 4 | 1.4% | 18.0% | 18.0% | 37.2% | 34.2% | 55.5% |
| 10 | 1.8% | 23.5% | 23.5% | 46.9% | 66.8% | 91.8% |
| 50 | 2.9% | 34.8% | 34.8% | 50.8% | 100% | 100% |

Pairs of a window that conflict, of all pairs: W = 10: 5.2% optimistic, 18.9% grouping. W = 50: 2.2% and 16.4%.

The queue order is the cause. Children of 1 split are queued together and are claims about 1 subject:

| Adjacent pairs | n | Grouping conflict | Optimistic conflict |
|---|---|---|---|
| Same parent (siblings) | 393 | 286 (72.8%) | 216 (55.0%) |
| Other | 1,806 | 239 (13.2%) | 57 (3.2%) |

The remaining queue is all children. For them (484 children from 2026-10-17 20:40, mean 27.3 s), in queue order and with the order spread at random across parents:

| Window W | In order: optimistic | In order: grouping | Spread: optimistic | Spread: grouping |
|---|---|---|---|---|
| 10 | 51.3% | 82.8% | 11.2% | 77.6% |
| 50 | 64.6% | 86.1% | 40.6% | 85.7% |

Speedup. A simulation on the real durations of the 484 children: list scheduling, lookahead 10, a request may start when a worker is free and no earlier conflicting request is unfinished (grouping), or starts in order and is re-run alone after the conflicting commit (optimistic, a re-run costs the whole request again). The cost of a conflict is 1 whole request (28 s) in the optimistic mode, or a wait in the grouping mode.

| Workers | Mode | In order: speedup | In order: re-runs | Spread: speedup | Spread: re-runs |
|---|---|---|---|---|---|
| 2 | grouping | 1.61 | none | 1.97 | none |
| 2 | optimistic | 1.51 | 28.1% | 1.99 | 0.8% |
| 4 | grouping | 1.68 | none | 2.61 | none |
| 4 | optimistic | 2.67 | 43.0% | 3.86 | 3.7% |

On all 1,500 submissions since 2026-10-17 20:40 (half splits, which never conflict): 2 workers 1.79 (grouping) and 1.66 (optimistic, 11.9% re-runs); 4 workers 2.21 and 3.00 (19.2% re-runs).

Limits of the proxy:

- It sees only conflicts that a stored id shows. Two requests with no shared candidate that each write a new fact about the same scope (a twin, F1) are not counted. The grouping mode catches them only if they share a candidate. The wiki has no check for this today either, but "every change sees every change before it" is the rule that prevents it.
- The re-run rate in the spread order is an estimate: the write sets are those of the real order.
- The simulation holds each worker busy for the whole of a request and adds no cost for a second embedder or SQLite writer.

## Rate limit

From `worker-wikifact.*.log` (the `rate_limit_pause` lines; the errors log repeats them).

| Measure | Value |
|---|---|
| Pause lines | 33 |
| Episodes (a run of pauses on 1 limit) | 5 |
| Time paused | 18.3 hours of 168 (10.9%), 35.5% of the 51.4 hours since the queue filled |
| By kind | 11 lines of the 5-hour session limit (2 episodes, 4.5 hours), 22 of the weekly limit (3 episodes, 13.8 hours) |
| Weekly limit | hit 2026-10-18 19:18, reset 2026-10-19 23:00 (Monday 16:00 in Los Angeles): 27.7 hours closed |
| Pause lengths | 5, 10, 20, 40, then 60 minutes, doubling per call |
| Late resume | 4 of 5 episodes ended 33 to 41 minutes after the reset that the message names (the fifth, 2026-10-19 03:48, was cut by the worker not running) |

Work done before a limit: the 2 session limits came after 2.65 and 2.92 busy hours (about 590 requests, 1,300 calls, 0.78 million output tokens, 11 to 14 million cache-write tokens each). The weekly limit came after 12.9 busy hours in the cycle of 2026-10-12 23:00 to 2026-10-19 23:00 (3,092 requests, 5,478 calls). The same login serves the owner's own sessions, which the store does not show, so these are upper bounds of the share of the worker.

A rate limit caps every parallel mode: the quota is tokens, not time. 4 workers use the quota 4 times as fast. A transport with an API key has no such cap, and is billed.

Other restarts: 45 `worker_start` lines in the window (57 in all), 56 `lock_takeover` lines in all. A restart returns the running request to `queued`, so it loses up to 1 request (19 s on average).

## Levers

Baseline: 129 requests per hour for the queued children (28.0 s each), Gains are at full duty and before the rate limit.

| Lever | Expected gain, requests per hour | Cost and risk | Requirement it changes |
|---|---|---|---|
| Transport with an API key and no process start (SDK) | 146 to 232 (saves 1 to 3.8 s on each of 3.3 calls); no weekly or session cap; cache reads in place of 22,900 cache-write tokens per Q4 or Q5 call | Billed per token; the price is not computed here. The docs already say a deployed worker needs a key. Where the saving falls in 1 to 3.8 s is unmeasured: 1 timed call on each transport would tell. | None. The CLI transport stays for local runs. |
| Q1 started beside Q7 (the gather and Q1 need only the change text) | 158 (+23%): saves min(Q7, Q1) = 6.1 s on the 85% of children that pass Q7 | A Q1 call is wasted on every compound child (15%) and on every split (42.6% of top-level requests): about 7.3 s of tokens each. No wiki state is read that Q7 could change. | None. |
| Cheaper Q4 (Opus high, 10.4 s, to Haiku or Sonnet at a lower effort, about 6.5 s) | 146 (+13%); fewer cache-write tokens on the largest model | Accuracy: Q4 is the judgment, so the bar of the Q4 test set and the replay must hold ([Test plan](../technical/questions.md#test-plan)). Run the eval before any change. | Q4 model and effort (O6), if the bar passes. |
| Spread siblings in the queue order (no parallelism yet) | 0 alone. It is the step that lets parallel modes reach 2.0 and 2.6 to 3.9 times (rows below) | The order of arrival no longer holds inside the group of requests of 1 split. "Every change sees every change before it" holds for the group of siblings only if they are not run together. | "One at a time": the order of requests of different parents changes. |
| 2 workers, optimistic, siblings spread | 257 (1.99 times; 0.8% re-runs of 28 s) | Needs a second lock-holder, a version check at write time, a retry path. The twin risk (above) is not covered. Capped by the quota: 2 workers reach the weekly limit in half the time. | "One at a time" and the design rule "every change sees every change before it" |
| 4 workers, optimistic, siblings spread | 498 (3.86 times; 3.7% re-runs) | The same, plus 4 times the quota rate. Without the spread order: 2.67 times with 43% re-runs, which is not worth the risk. | The same |
| 2 or 4 workers, grouping on the gather set, siblings spread | 255 (1.97 times) and 338 (2.61 times) | No re-run and no twin risk for requests that share a candidate. The gather runs before the request is placed (about 0.6 s). Same quota cap. | The same |
| Pause until the reset time in the message ("resets 4pm"), not by doubling to 60 minutes | 0 in speed; +33 to 41 minutes of running time per episode (4 episodes in 3 days: +2.4 hours, 5% of the wall time) | Low. Parse one phrase; keep the doubling as the fallback. | None. |
| Skip Q7 for children of a split | 158 on paper (+23%) | Net loss: the 15% that are still compound cost 3 attempts each (see "Which outcomes cost what"). | Would change "A child is never split". Not recommended. |

Two things the lever table cannot show:

- The weekly quota is the limit that decides the size of the queue that can be drained in a week. On the subscription login, the levers that cut tokens (cheaper Q4, a cached prefix, fewer cleanup calls) raise the work per week; the levers that cut time (parallel workers) do not.
- The wall rate (29 per hour) is 7 times smaller than the full-duty rate (204). The two causes are the pauses of the limit and a worker that is not running. A faster worker does not move either.

## Open

- One timed call on the CLI and the same call on the SDK, to place the saving of the first lever in its range of 1 to 3.8 s per call.
- The dynamic cleanup intervals and the cap have not run on a long queue (B-003). The first empty queue will show the real size of the cleanup of this backlog.
- The twin risk of parallel requests has no count. A replay case with 2 siblings of 1 scope run together would measure it.
