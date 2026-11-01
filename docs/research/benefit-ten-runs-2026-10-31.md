# The benefit test with 10 runs, October 31, 2026

Research note for issue #120. 1 run of the benefit test at the commit `cfc338d9`, with 10 runs of each case and arm. The spec is in [design/evaluation.md](../design/evaluation.md#the-benefit-test) and [technical/evaluation.md](../technical/evaluation.md#the-benefit-test), sections "The benefit test". The earlier runs are in [benefit-preloaded-run-2026-10-27.md](benefit-preloaded-run-2026-10-27.md).

## The settings

| Item | Value |
|---|---|
| Result file | `eval/benefit-results/2026-10-31T05-24-47.705Z.json` |
| Cases proof | `eval/benefit-results/cases-2026-10-31T05-20-27.682Z.json`, at the commit `7683e9ae`: `ok: true`, 0 of 24 questions with a missing proof file, 8 of 8 tasks `ok` |
| Commit | `cfc338d9b2a121305af1f89769ec4673dba61361` |
| Agent | `claude -p --model claude-sonnet-5-5` |
| Judge | `claude-opus-5-5 (medium)` (`meta.judgeModel`) |
| Arguments | `--concurrency 2 --env local --wiki wikifact`, `--runs 10`, arm `both`, kind `all`, group `all`, cases `eval/benefit.json` |
| Cases | 32: 24 questions, 8 tasks |
| Time | `startedAt` 05:24:47 UTC, `updatedAt` 08:45:33 UTC (3 h 21 min) |

**The preload.** `meta.preload` holds `mostRounds: 3`. 3 rounds ran. The worker accepted 1 change in round 1, 2 in round 2 and 0 in round 3. `stoppedBy` is `"no change"`. Thus the preload copy was at rest before the measured runs (the run of 2026-10-27 stopped at the round limit, with 2 changes in its last round).

**The stop.** `meta` holds no `stoppedBy`. The run did not stop at a rate limit or a failed login.

**The rows.** The file holds 640 rows: 32 cases, 2 arms, 10 runs. Each row holds `copy: "preloaded"`. 0 rows hold an `error`, and the summary gives `errors: 0` for both arms in every cell.

## The numbers

The numbers come from the stored `summary` of the file. "Right" is the share of runs where all checks pass (terms and judge for a question; hidden tests, type check and judge for a task). The interval of a share is the 95% Wilson interval. The interval of the difference of the shares is the 95% Newcombe interval, in percentage points. The interval of the dollar difference is the 95% Welch interval. "Counts" is `yes` when the interval does not hold 0. The difference is "with" minus "without".

| Cell | Runs per arm | Right, with | Right, without | Difference (points) | Counts | Dollars, with | Dollars, without | Dollar difference | Counts |
|---|---|---|---|---|---|---|---|---|---|
| All | 320 | 84.4% (80.0 to 87.9) | 88.1% (84.1 to 91.2) | -3.7 (-9.1 to +1.6) | no | $0.0713 | $0.0702 | +$0.0012 (-$0.0066 to +$0.0089) | no |
| Kind: question | 240 | 81.3% (75.8 to 85.7) | 87.5% (82.7 to 91.1) | -6.3 (-12.8 to +0.3) | no | $0.0489 | $0.0417 | +$0.0073 (+$0.0045 to +$0.0100) | **yes** |
| Kind: task | 80 | 93.8% (86.2 to 97.3) | 90.0% (81.5 to 94.8) | +3.7 (-5.2 to +13.0) | no | $0.1385 | $0.1557 | -$0.0172 (-$0.0287 to -$0.0057) | **yes** |
| Group: held | 140 | 82.9% (75.8 to 88.2) | 80.0% (72.6 to 85.8) | +2.9 (-6.3 to +12.0) | no | $0.0871 | $0.0938 | -$0.0067 (-$0.0203 to +$0.0069) | no |
| Group: gap | 80 | 83.8% (74.2 to 90.3) | 97.5% (91.3 to 99.3) | -13.7 (-23.5 to -4.8) | **yes** | $0.0547 | $0.0436 | +$0.0111 (+$0.0061 to +$0.0161) | **yes** |
| Group: stale | 100 | 87.0% (79.0 to 92.2) | 92.0% (85.0 to 95.9) | -5.0 (-13.9 to +3.7) | no | $0.0625 | $0.0583 | +$0.0042 (-$0.0083 to +$0.0168) | no |
| Questions, held | 80 | 70.0% (59.2 to 78.9) | 65.0% (54.1 to 74.5) | +5.0 (-9.4 to +19.1) | no | $0.0454 | $0.0482 | -$0.0027 (-$0.0074 to +$0.0020) | no |
| Questions, gap | 80 | 83.8% (74.2 to 90.3) | 97.5% (91.3 to 99.3) | -13.7 (-23.5 to -4.8) | **yes** | $0.0547 | $0.0436 | +$0.0111 (+$0.0061 to +$0.0161) | **yes** |
| Questions, stale | 80 | 90.0% (81.5 to 94.8) | 100.0% (95.4 to 100.0) | -10.0 (-18.5 to -3.3) | **yes** | $0.0466 | $0.0332 | +$0.0135 (+$0.0097 to +$0.0172) | **yes** |
| Tasks, held | 60 | 100.0% (94.0 to 100.0) | 100.0% (94.0 to 100.0) | 0.0 (-6.0 to +6.0) | no | $0.1427 | $0.1548 | -$0.0121 (-$0.0262 to +$0.0020) | no |
| Tasks, stale | 20 | 75.0% (53.1 to 88.8) | 60.0% (38.7 to 78.1) | +15.0 (-13.4 to +40.4) | no | $0.1260 | $0.1587 | -$0.0327 (-$0.0500 to -$0.0154) | **yes** |
| Type: locate | 60 | 100.0% (94.0 to 100.0) | 100.0% (94.0 to 100.0) | 0.0 (-6.0 to +6.0) | no | $0.0407 | $0.0325 | +$0.0082 (+$0.0054 to +$0.0111) | **yes** |
| Type: explain | 60 | 78.3% (66.4 to 86.9) | 85.0% (73.9 to 91.9) | -6.7 (-20.5 to +7.4) | no | $0.0561 | $0.0415 | +$0.0146 (+$0.0092 to +$0.0201) | **yes** |
| Type: rationale | 60 | 86.7% (75.8 to 93.1) | 83.3% (72.0 to 90.7) | +3.3 (-9.8 to +16.4) | no | $0.0522 | $0.0479 | +$0.0043 (-$0.0019 to +$0.0106) | no |
| Type: behavior | 60 | 60.0% (47.4 to 71.4) | 81.7% (70.1 to 89.4) | -21.7 (-36.5 to -5.4) | **yes** | $0.0466 | $0.0447 | +$0.0019 (-$0.0035 to +$0.0074) | no |
| Complexity: simple | 120 | 92.5% (86.4 to 96.0) | 91.7% (85.3 to 95.4) | +0.8 (-6.4 to +8.1) | no | $0.0457 | $0.0394 | +$0.0063 (+$0.0025 to +$0.0101) | **yes** |
| Complexity: complex | 120 | 70.0% (61.3 to 77.5) | 83.3% (75.7 to 88.9) | -13.3 (-23.7 to -2.6) | **yes** | $0.0522 | $0.0439 | +$0.0083 (+$0.0044 to +$0.0121) | **yes** |
| Task type: bugfix | 40 | 100.0% (91.2 to 100.0) | 100.0% (91.2 to 100.0) | 0.0 (-8.8 to +8.8) | no | $0.1289 | $0.1513 | -$0.0224 (-$0.0409 to -$0.0039) | **yes** |
| Task type: feature | 20 | 75.0% (53.1 to 88.8) | 60.0% (38.7 to 78.1) | +15.0 (-13.4 to +40.4) | no | $0.1608 | $0.1615 | -$0.0008 (-$0.0141 to +$0.0126) | no |
| Task type: codeAndDoc | 20 | 100.0% (83.9 to 100.0) | 100.0% (83.9 to 100.0) | 0.0 (-16.1 to +16.1) | no | $0.1355 | $0.1588 | -$0.0234 (-$0.0448 to -$0.0019) | **yes** |

The group "gap" holds only questions, so its 2 rows are the same. The cells of type and complexity hold only questions. All tasks are done in both arms (share done 100%), so each difference of the share done is 0, and no interval of it excludes 0.

**The bars** (`heldBars`). Questions: not met. The share right is 70.0% against 65.0% (+5.0, -9.4 to +19.1, no difference), and the dollars are $0.0454 against $0.0482 (-$0.0027, -$0.0074 to +$0.0020, no difference). Tasks: not met. The share right is 100% in both arms, and the dollars are $0.1427 against $0.1548 (-$0.0121, -$0.0262 to +$0.0020, no difference). The bar asks for lower dollars by a difference that counts, and neither kind has it.

## What the intervals support

1. **The wiki arm is right less often on 4 cells.** Gap questions: -13.7 points (-23.5 to -4.8). Stale questions: -10.0 points (-18.5 to -3.3). Behavior questions: -21.7 points (-36.5 to -5.4). Complex questions: -13.3 points (-23.7 to -2.6).
2. **The wiki arm is right more often on no cell.** No difference of the share right counts in favor of the wiki.
3. **All other differences of the share right are "no difference".** This includes all runs, all questions, all tasks, the held group, held questions, held and stale tasks, locate, explain, rationale, simple questions and the 3 task types. This note draws nothing from them.
4. **Questions cost more with the wiki: +$0.0073 per question (+$0.0045 to +$0.0100).** The higher cost counts on gap, stale, locate, explain, simple and complex questions.
5. **Tasks cost less with the wiki: -$0.0172 per task (-$0.0287 to -$0.0057).** The lower cost counts on stale tasks, bug fixes and code-and-doc tasks. On held tasks, the cost difference is "no difference". Thus the held bar for tasks is not met.
6. **The held bars are not met for questions or for tasks.**

## The causes of the differences against the wiki

The rows store the final text of the agent (`answer`), the judge reason and the list of tool calls. A row is a failure when a check fails. The wiki arm has 45 failed question runs in total. Each failed run is in 1 of these classes:

| Class | Rule | Runs |
|---|---|---|
| A. Duty text | The final text tells of a `requestChange` that the agent queued, and holds no answer or only a fragment of it. | 9 |
| B. Partial after facts only | The answer is partial. The run called the wiki tools and no file tool (`Read`, `Grep`, `Glob`). | 7 |
| C. Wrong fact repeated | The answer repeats the wrong fact of a stale case. | 0 |
| D. Other: partial after facts and files | The answer is partial. The run called the wiki tools and 1 or more file tools. | 29 |

Failed runs of the wiki arm per case, with the failed runs of the arm without the wiki for comparison:

| Case | Failed, with | Failed, without | A | B | C | D |
|---|---|---|---|---|---|---|
| `q-held-explain-complex` | 9 | 9 | 1 | 0 | 0 | 8 |
| `q-held-behavior-simple` | 6 | 0 | 0 | 5 | 0 | 1 |
| `q-held-behavior-complex` | 9 | 9 | 0 | 0 | 0 | 9 |
| `q-held-rationale-simple` | 0 | 10 | 0 | 0 | 0 | 0 |
| `q-gap-explain-complex` | 1 | 0 | 1 | 0 | 0 | 0 |
| `q-gap-rationale-simple` | 2 | 0 | 2 | 0 | 0 | 0 |
| `q-gap-rationale-complex` | 1 | 0 | 1 | 0 | 0 | 0 |
| `q-gap-behavior-complex` | 9 | 2 | 0 | 2 | 0 | 7 |
| `q-stale-explain-complex` | 3 | 0 | 2 | 0 | 0 | 1 |
| `q-stale-rationale-simple` | 1 | 0 | 1 | 0 | 0 | 0 |
| `q-stale-rationale-complex` | 4 | 0 | 1 | 0 | 0 | 3 |
| Total | 45 | 30 | 9 | 7 | 0 | 29 |

The 13 other question cases have 0 failed runs in both arms. `q-held-rationale-simple` is listed because the arm without the wiki fails it in 10 of 10 runs (7 runs with a judge verdict other than `correct`, 3 runs with the verdict `correct` and a term absent). The wiki arm is right in 10 of 10.

### Gap questions (-13.7 points: 13 failed runs with, 2 without)

- **`q-gap-behavior-complex`: 9 of 13 failures.** All 9 answers are partial (B: 2, D: 7). All 9 judge reasons say that the answer leaves out the recovery step of the label: the limit rises by 1 after every 20 good calls, up to its start value. The wiki arm called `getFact` 39 times in 10 runs (3.9 per run). 7 of the 9 failed runs also called `Read` 1 time, and their answers cite `eval/lib/pool.ts`. They still left out the recovery. 5 of the 9 final texts say that the wiki facts match the code. The live wiki holds 5 facts on `AdaptivePool` (halving, attempts, pause, retry order, transient retry) and none on the recovery. The arm without the wiki called `Grep` 10 times and `Read` 10 times in 10 runs, and was right in 8.
- **Duty text: 4 of 13 failures** (`q-gap-rationale-simple` runs 4 and 10, `q-gap-rationale-complex` run 9, `q-gap-explain-complex` run 7). Each final text tells only of a queued `requestChange`, for example: "I've sent the wiki a change request recording this rationale, and the answer above is final." The judge gives `wrong` to all 4.

### Stale questions (-10.0 points: 8 failed runs with, 0 without)

- **Duty text: 4 of 8 failures** (`q-stale-rationale-complex` run 1, `q-stale-explain-complex` runs 2 and 10, `q-stale-rationale-simple` run 7). 3 get `wrong`. `q-stale-explain-complex` run 2 gets `partial`, because a fragment of the step order follows the duty text.
- **Partial after facts and files: 4 of 8 failures.** `q-stale-rationale-complex` runs 2, 8 and 9 give the read history and F17, but leave out the rank feedback loop of the label. `q-stale-explain-complex` run 1 gives the right order, but leaves out 3 steps.
- **Wrong fact repeated: 0.** In all 4 partial answers, the agent names the stale fact as wrong ("says the opposite", "has the worker and consumer steps the wrong way round") and queues a correction. The stale fact did not catch the agent.
- All 8 failures queued a `requestChange`. The wiki arm queued 1 or more in 57 of its 80 stale question runs.

### Behavior questions (-21.7 points: 24 failed runs with, 11 without)

- **`q-held-behavior-complex`: 9 failures in each arm.** The case adds 0 to the difference. The wiki arm gives `partial` in 9 runs: the answers leave out the 2 minute margin on the reset time, the case of a reset time that does not parse, or the reset of the fallback pause to 5 minutes after a success. All 9 runs read 3 to 4 facts and then the files (D). The arm without the wiki also fails 9 of 10. The note of 2026-10-27 (finding 6) found the same, and the label is still worth a review.
- **`q-held-behavior-simple`: 6 failures with, 0 without.** 5 of the 6 runs called only the wiki tools (B), and all 5 final texts say that the agent did not check the code or the source. The judge reasons name a point that is absent: the backoff of attempts × 10 seconds, the limit of 3 attempts, or the error text that the failed request keeps. Run 8 says that 2 facts disagree on the retry rule. The arm without the wiki called 4.7 file tools per run and was right in 10 of 10.
- **`q-gap-behavior-complex`: 9 failures with, 2 without.** See "Gap questions".
- The wiki arm fails 13 runs more than the arm without: 7 more in `q-gap-behavior-complex` and 6 more in `q-held-behavior-simple`. Classes of the 24: A 0, B 7, C 0, D 17.

### Complex questions (-13.3 points: 36 failed runs with, 20 without)

- 18 of the 36 failures are in `q-held-explain-complex` and `q-held-behavior-complex`. Each of these 2 cases fails 9 of 10 runs in both arms. They add 0 to the difference.
- The difference of 16 runs comes from `q-gap-behavior-complex` (9 against 2), `q-stale-rationale-complex` (4 against 0), `q-stale-explain-complex` (3 against 0), `q-gap-explain-complex` (1 against 0) and `q-gap-rationale-complex` (1 against 0).
- Classes of the 36: A 6, B 2, C 0, D 28.

### The duty text

The test stores the `result` of the stream as the answer. In 7 of the 9 duty texts, the agent points to an answer that the text does not hold: "The answer above is already complete", "with the assignment rules above", "The answer to your question is above", "the answer above is final", "The step order above", "I've answered the question" and "I answered the question". The judge reads only the stored text, so it finds no answer. The failure is the same as in the note of 2026-10-27 (finding 5). The wiki arm queued 1 or more `requestChange` in 78 of its 240 question runs. 15 of its 45 failed question runs queued one.

## The cost

Means per run, from the stored `summary`. "Input tokens" are the fresh input, the cache reads and the cache writes.

| Cell | Input tokens, with | Input tokens, without | Turns, with | Turns, without | Wiki calls, with | File reads, with | File reads, without |
|---|---|---|---|---|---|---|---|
| All | 78,073 | 64,244 | 7.12 | 5.76 | 2.43 | 2.67 | 3.53 |
| Questions | 46,853 | 29,743 | 5.59 | 3.92 | 2.71 | 1.88 | 2.92 |
| Tasks | 171,736 | 167,745 | 11.71 | 11.26 | 1.61 | 5.03 | 5.38 |
| Questions, held | 43,665 | 32,325 | 5.44 | 4.39 | 2.96 | 1.48 | 3.39 |
| Questions, gap | 53,114 | 32,583 | 5.90 | 4.25 | 2.67 | 2.23 | 3.25 |
| Questions, stale | 43,779 | 24,321 | 5.42 | 3.13 | 2.49 | 1.94 | 2.13 |
| Tasks, held | 176,834 | 165,047 | 11.70 | 11.27 | 1.55 | 4.90 | 5.17 |
| Tasks, stale | 156,442 | 175,840 | 11.75 | 11.25 | 1.80 | 5.40 | 6.00 |
| Type: locate | 38,305 | 23,542 | 4.85 | 3.33 | 1.83 | 2.02 | 2.33 |
| Type: explain | 55,964 | 31,361 | 6.17 | 4.22 | 2.73 | 2.43 | 3.22 |
| Type: rationale | 52,078 | 33,756 | 5.68 | 4.28 | 3.25 | 1.43 | 3.28 |
| Type: behavior | 41,063 | 30,313 | 5.65 | 3.85 | 3.02 | 1.63 | 2.85 |
| Complexity: simple | 43,948 | 27,620 | 5.08 | 3.50 | 2.49 | 1.59 | 2.50 |
| Complexity: complex | 49,758 | 31,866 | 6.09 | 4.34 | 2.92 | 2.17 | 3.34 |
| Task type: bugfix | 158,208 | 161,847 | 11.30 | 11.03 | 1.85 | 4.75 | 5.00 |
| Task type: feature | 196,183 | 179,437 | 13.10 | 13.00 | 1.10 | 5.55 | 5.95 |
| Task type: codeAndDoc | 174,344 | 167,849 | 11.15 | 10.00 | 1.65 | 5.05 | 5.55 |

**Where the wiki arm costs more: questions.** A question with the wiki uses 46,853 input tokens against 29,743 (+58%), and 5.59 turns against 3.92 (+1.67). It makes 2.71 wiki calls and 1.04 fewer file reads per run. The wiki calls add turns, and each turn reads the context again. On the question rows, the cache reads are 38,525 against 21,943 per run. The arm with the wiki costs less on 5 of the 24 question cases: `q-held-rationale-simple` ($0.0309 against $0.0520), `q-held-rationale-complex`, `q-held-behavior-simple` ($0.0434 against $0.0708), `q-held-behavior-complex` and `q-gap-rationale-complex`. These are per-case means with no interval.

**Where the wiki arm costs less: tasks.** A task with the wiki costs $0.1385 against $0.1557, but it uses 171,736 input tokens against 167,745 (+2%) and 11.71 turns against 11.26. Thus the lower cost does not come from fewer input tokens or fewer turns. It comes from the mix of the tokens. On the task rows, the cache writes are 20,402 against 24,963 per run (-4,561), and the cache reads are 151,319 against 142,768 (+8,551). A cache write costs more per token than a cache read. The output tokens are 2,647 against 2,717. The stale tasks are the exception on input tokens: 156,442 against 175,840 (-11%), at $0.1260 against $0.1587.

## Open

- The duty text (class A) is 9 of the 45 failed question runs of the wiki arm, and 8 of the 21 failures of the gap and stale questions. A fix is a change to the prompt, to the duty or to what the test stores as the answer. The owner decides it.
- The facts on `AdaptivePool` have no recovery step, and the agent trusts them over the file it reads. 9 of 10 runs of `q-gap-behavior-complex` fail on this one point.
- `q-held-explain-complex` and `q-held-behavior-complex` fail 9 of 10 runs in both arms, and `q-held-rationale-simple` fails 10 of 10 runs of the arm without the wiki. Their labels are worth a review before the next run.
