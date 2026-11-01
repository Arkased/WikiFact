# The benefit test on a preloaded wiki, October 27, 2026

Research note. 2 runs of the benefit test at the commit `f0a1325`, with the same settings: `WIKIFACT_TRANSPORT=cli`, model `claude-sonnet-5-5`, judge `claude-sonnet-5-5 (medium)`, `--concurrency 2 --runs 3 --env local --wiki wikifact --repo .`. Neither run stopped at a rate limit. The spec is in [technical/evaluation.md](../technical/evaluation.md#the-benefit-test). The first run is in [benefit-first-run-2026-10-20.md](benefit-first-run-2026-10-20.md).

| Run | Result file | Arguments | Runs |
|---|---|---|---|
| A | `eval/benefit-results/2026-10-27T05-34-29.412Z.json` | default preload | 32 cases (24 questions, 8 tasks), 192 runs |
| B | `eval/benefit-results/2026-10-27T06-53-22.813Z.json` | `--preload-rounds 0 --kind question` | 24 questions, 144 runs |

The verified cases file is `eval/benefit-results/cases-2026-10-27T05-30-16.826Z.json`. Both runs store the text of every answer. This note does not review the labels again. It reports the stored verdicts.

## What the preload did in run A

The preload ran 3 rounds. The worker accepted 1, 5 and 2 changes in them. It stopped at the round limit, not at a round with 0 accepted changes. So the wiki still changed in round 3, and the copy of A is not at rest. The held and stale questions (96 runs) read the preloaded copy. The gap questions and the tasks read the copy as it was filled. Run B read the filled copy for all 144 runs.

## The numbers

Share of runs right, arm with the wiki / arm without. Dollars are the mean of 1 run. A cell of questions holds 24 runs per arm. A cell of tasks holds 24 runs per arm, or 18 (held) or 6 (stale).

| Cell | A, with preload | B, no preload | First run, corrected |
|---|---|---|---|
| All questions | 85% / 93%, $0.055 / $0.049 | 79% / 86%, $0.056 / $0.047 | 85% / 94%, $0.049 / $0.042 |
| Held questions | 75% / 79%, $0.054 / $0.059 | 71% / 63%, $0.058 / $0.057 | 79% / 83%, $0.038 / $0.046 |
| Stale questions | 88% / 100%, $0.052 / $0.038 | 79% / 100%, $0.055 / $0.037 | 88% / 100%, $0.051 / $0.034 |
| Gap questions | 92% / 100%, $0.059 / $0.049 | 88% / 96%, $0.056 / $0.048 | 88% / 100%, $0.060 / $0.045 |
| All tasks | 96% / 88%, $0.099 / $0.141 | not run | 79% / 92%, $0.123 / $0.130 |
| Held tasks | 100% / 100%, $0.100 / $0.146 | not run | 89% / 100%, $0.126 / $0.132 |
| Stale tasks | 83% / 50%, $0.098 / $0.127 | not run | 50% / 67%, $0.117 / $0.125 |
| All runs | 88% / 92%, $0.066 / $0.072 | 79% / 86%, $0.056 / $0.047 | 83% / 94%, $0.068 / $0.064 |

**The first run is a weak comparison.** It ran at another commit (`a826ed1`), with the `standard` judge and the case file before the review of its 22 disagreements. Its numbers are the corrected ones of that note. The mean dollars of a question are higher in 2026-10-27 (held: $0.054 against $0.038 in the arm with the wiki). I did not find the cause in the files.

By complexity, questions only, arm with / arm without:

| Questions | A | B |
|---|---|---|
| Simple (36 per arm) | 89% / 92% | 89% / 89% |
| Complex (36 per arm) | 81% / 94% | 69% / 83% |

By type, in A: locate 94% / 100%, explain 83% / 89%, rationale 89% / 100%, behavior 72% / 83%. In B: locate 89% / 94%, explain 83% / 78%, rationale 83% / 100%, behavior 61% / 72%. The cells hold 18 runs per arm.

## The bars

The bars are in [design/evaluation.md](../design/evaluation.md#the-benefit-test), "The bar". The runner stores them as `heldBars`.

| Bar | A | B |
|---|---|---|
| Held questions: share right as high or higher, and lower dollars | Not met. 75% against 79% (1 run of 24 fewer). Dollars are lower: $0.054 against $0.059. | Not met. The share is higher (71% against 63%), but the dollars are higher: $0.058 against $0.057. |
| Tasks in a right area (held tasks): as many done or more, at a lower cost | Met. 100% against 100% (18 of 18 in both arms). Dollars $0.100 against $0.146, 31% lower. | Not run. |

The first run met neither bar on the corrected numbers.

## Findings

1. **The preload does not show a gain.** The arm with the wiki moves by 1 to 2 runs of 24 between B and A: held 17 to 18 right, stale 19 to 21, gap 21 to 22. The gap cell has no preload in either run and still moves by 1 run. A move of 1 to 2 runs is not a proven gain.
2. **The noise of a cell is about 4 runs.** The arm without the wiki has no wiki and no preload, and its held cell differs by 4 runs between A and B: 19 of 24 (79%) and 15 of 24 (63%). The cases that move are `q-held-behavior-complex` (3 of 3 in A, 1 of 3 in B) and `q-held-explain-complex` (1 of 3 and 0 of 3). A difference of 4 runs or less in a cell of 24 is no difference.
3. **On the questions, the arm with the wiki is not ahead.** It is right as often or less often in every question cell of A and B, except 2 cells of B: held (71% against 63%, inside the noise of finding 2) and explain (83% against 78%, 1 run of 18). It costs more in 7 of the 8 cells of questions. In the other cell (held, A) it costs $0.005 less. It takes 5.3 turns against 3.6 in A, and 5.5 against 3.4 in B. Complex questions are the weak point: 81% against 94% in A, 69% against 83% in B.
4. **Only the tasks favor the wiki.** In A the tasks cost $0.099 against $0.141, which is 30% less, and both arms are done in 24 of 24 tasks, but more are right: 23 of 24 (96%) against 21 of 24 (88%). The held tasks are 18 of 18 in both arms, so their gain is only the dollars ($0.100 against $0.146). The stale tasks are 5 of 6 against 3 of 6. All 3 failures of the arm without the wiki are `t-stale-feature-errno-cause`; the arm with the wiki fails 1 of those 3 runs. 6 runs are too few to call it a result. The tasks ran once, in A, so the noise of the tasks is not measured.
5. **The wrong fact does not catch the agent. The correction duty does.** The same cases fail in A and B in the arm with the wiki: `q-stale-rationale-complex` (1 of 3 in A, 0 of 3 in B), `q-stale-explain-complex` (2 of 3, 1 of 3) and `q-held-behavior-complex` (0 of 3 in both). The arm without the wiki gets `q-stale-*` 3 of 3 in both runs. In the stale cases, 4 failed runs (A: `q-stale-explain-complex` run 2, `q-stale-rationale-complex` run 2; B: `q-stale-explain-complex` run 1, `q-stale-rationale-complex` run 1) are "wrong" because the final text speaks of the correction that the agent queued, and the judge finds no answer. This is the failure of the first run in the gap cases (see its note, "The correction duty took the answer"). 25 of 72 runs of the arm with the wiki in A, and 28 of 72 in B, end with a `requestChange`.
6. **Complex held behavior is a partial answer, not a wrong one.** `q-held-behavior-complex` is 0 of 3 in the arm with the wiki in A and in B. The 6 judge reasons say "partial": the answers leave out the 2 minute margin, or the reset of the fallback pause after a success, and some add claims that the label does not hold (`consecutiveFailures`, `pauseReason`). The arm reads 3 or 4 facts and then the files (`Grep`, `Read`) in all 6 runs, so the wiki did not stop it short as in the first run. `q-held-behavior-simple` is 1 of 3 with and 0 of 3 without, in both runs: 10 of its 12 rows fail, and each failed row is "partial" with the terms right. The label is worth a review before the next run.
7. **The judge and the terms disagree on 14 rows of 144 in A and 22 in B.** All but 2 are "terms right, judge partial". The 2 other rows are in B, with the terms wrong and the judge "correct": `q-held-locate-simple` (with, run 1) and `q-gap-explain-simple` (without, run 1). The design says that the label is reviewed first on a disagreement. This note did not review them.

## What the note supports

- The preload is not shown to help. With a noise of about 4 runs per cell, the runs here cannot detect a gain of 1 to 2 runs.
- The held bar for questions is not met in A or in B. The bar for held tasks is met in A.
- The case for the wiki rests on the tasks: about 30% lower dollars per task, with the same share done (100%) and a higher share right (96% against 88%). That result is 1 run of 24 tasks.

## Open

- A third run of the same file, or more repeats, would set the noise. The noise sets how large a gain must be to count.
- The correction duty (finding 5) lowers the arm with the wiki in the stale cases. A fix there is a change to the prompt or to the duty, and the owner decides it.
- The preload did not reach rest in 3 rounds (round 3 accepted 2 changes). A run with more rounds tests whether a mature wiki is a different case.
