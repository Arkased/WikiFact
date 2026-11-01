# The first run of the benefit test, October 20, 2026

Research note. The run: `eval/benefit-results/2026-10-20T01-31-21.347Z.json`, 192 runs (24 questions and 8 tasks, 2 arms, 3 runs), the dogfood wiki as it was on October 20 and the checkout of the fill commit `a826ed1`. Model of the agents `claude-sonnet-5-5`; judge the `standard` model of Q14. The spec is in [technical/evaluation.md](../technical/evaluation.md#the-benefit-test).

## Method and its limit

The design says that when the terms check and the judge disagree, the label is reviewed first ([design/evaluation.md](../design/evaluation.md#the-benefit-test)). 22 of the 144 question rows disagree. For each I read the label and its proof lines, the terms, the reason that the judge wrote, and the tool calls of the run.

**The limit:** the first run did not store the text of the answers (the row schema had no field for it). The review is therefore of the judge's reason against the label, not of the answer. The corrected numbers below are not a new judge pass: they apply my verdict on each row to the stored verdict. A second judge pass over the answers is possible only after a new run; from now on the row holds `answer`.

## The 22 rows

| Case | Rows | Terms | Judge | Verdict on the label | Corrected |
|---|---|---|---|---|---|
| `q-held-explain-simple` | with, runs 1 to 3 | ok | partial | Label too long for a simple question. The judge asked for the EPERM rule and the exit on a live pid; the question asks only how a stale lock is recognized. Label cut to the dead-pid rule. | correct (3) |
| `q-held-explain-complex` | without, run 2 | missing | correct | Terms wrong. They were the key names `cleanup_seq` and `cleanup_every`; the answer had the content. Terms are now `doubl` and `halv`. | terms ok (1) |
| `q-held-explain-complex` | with, runs 1 to 3 | ok | partial | Label right (`cleanup-run.ts` lines 102 to 115). The answers left out the run cut by the cap (3 of 3) and the absent `cleanup_seq` (2 of 3). | partial stays (3) |
| `q-held-behavior-simple` | with, runs 1 to 3 | missing | correct | Terms wrong. "queued" is a status word; the answers said "back in the queue". Terms are now `failed`. | terms ok (3) |
| `q-held-behavior-complex` | without runs 1 and 3, with run 2 | ok | partial | Label right (`worker.ts` 130, `worker-status.ts` 14, 20). The answers left out the 5 minute and 1 hour values, the heartbeat, or that the worker takes no request during the pause. | partial stays (3) |
| `q-held-rationale-simple` | without, run 2 | ok | partial | Label too long. The judge asked for the example of the first wiki; the question asks why. Label cut to the reason. | correct (1) |
| `q-held-rationale-complex` | with, run 3 | ok | partial | The question was not held. The wiki has "Deployed kind model credential" (login terms bar use by another service) but its "Local kind model credential" says only "either the login or an API key", with no reason, and the old label asked for the reason. The agent said so. The question now asks which credentials the local kind can use. Rows of the old wording keep their stored verdicts. | partial stays (1); case changed |
| `q-gap-rationale-complex` | with run 1, without run 2 | missing | correct | Terms wrong. `account` is one word of the label; the answers said "load" or "capacity". Terms are now `halv`. | terms ok (2) |
| `q-stale-explain-complex` | with, runs 1 and 2 | ok | partial | Label wrong. `runCorrections` builds the result of each task before it drains the queue (`run.ts` 139 to 143, then the drain at 144, the count at 148). The answers had the code order. Label corrected. | correct (2) |
| `q-stale-rationale-complex` | with, runs 1 to 3 | ok | partial | Label right (`seed.ts` 89, `updates.md` 554). The answers gave a likely purpose and missed F17 (rank feedback); run 3 says it did not look F17 up. | partial stays (3) |

12 of the 22 rows change their verdict, 10 stay. In `eval/benefit.json` 7 cases changed: 3 labels, 3 sets of terms and 1 question.

## The numbers, as stored and as corrected

Share of runs right (all checks pass), arm with against arm without. Dollars are unchanged by the review.

| Cell | Stored | Corrected | Mean dollars per run |
|---|---|---|---|
| All 192 runs | 74% / 91% | 83% / 94% | 0.068 / 0.064 |
| Questions | 72% / 90% | 85% / 94% | 0.049 / 0.042 |
| Tasks | 79% / 92% | 79% / 92% | 0.123 / 0.130 |
| Questions, held | 54% / 75% | 79% / 83% | 0.038 / 0.046 |
| Questions, gap | 83% / 96% | 88% / 100% | 0.060 / 0.045 |
| Questions, stale | 79% / 100% | 88% / 100% | 0.051 / 0.034 |
| Tasks, held | 89% / 100% | 89% / 100% | 0.126 / 0.132 |
| Tasks, stale | 50% / 67% | 50% / 67% | 0.117 / 0.125 |

The review closes most of the gap on the held questions (54% against 75% became 79% against 83%), and the arm with the wiki costs 17% less per held question ($0.038 against $0.046). It does not close the gap on the other cells: on the gap questions, the stale questions and all tasks, the arm without the wiki is right as often or more often, and costs the same or less. The difference between the arms in the held questions (1 run of 24) is inside the range of a run; the cells hold 24 runs or fewer, and the tasks 18 or fewer. These are not rates.

## What the agents did with the wiki

From the tool calls of the 24 held and the 24 stale runs of the arm with the wiki.

- **Held questions: 20 of 24 runs read no file.** They took the answer from the wiki alone: `search`, then 1 to 3 `getFact`. 16 of those 20 are right (80%). The 4 runs that went to the files are right in 3. In the locate questions, 5 of 6 runs used the search result alone.
- **Where the wiki answer stopped them short.** The 5 held runs that are not right are all complex questions: `q-held-explain-complex` (3 runs, which opened 2 or 3 facts and stopped), `q-held-behavior-complex` (1 run, 2 facts and 1 Grep) and `q-held-rationale-complex` (1 run, 2 facts). The wiki holds 1 claim in each fact, so a complex question needs the facts to be joined, and the agent stopped after the facts it had opened. For `q-held-explain-complex` the missed claims are in facts that exist: "Cleanup finder due rule" holds the cap-cut case and "Update worker cleanup seq absent" the absent key. By the judge's reasons, the misses are omissions: no answer repeated a wrong claim. The runs stopped on an answer that was partial. The arm without the wiki read 1 to 7 files for the same questions and is not right in 4 of 24 (2 of them complex).
- **A fact that is half of the answer.** "Local kind model credential" has no reason, and the agent of `q-held-rationale-complex` run 3 did not invent one. This is a gap inside a held question, and the fix is a fact.
- **Stale questions: none of the 24 runs trusted the wrong fact.** All 24 searched, 23 opened the fact, and all read a file (`Grep` or `Read`) before the answer; 23 of 24 then sent a `requestChange` (the correction duty). The 3 runs that are not right are `q-stale-rationale-complex`: their answers did not repeat the wrong fact (new facts with the same history), they missed F17.
- **The correction duty took the answer in 3 gap runs.** In `q-gap-behavior-complex` run 1 and `q-gap-rationale-complex` runs 2 and 3 the final text is about the change request that the agent queued, and the judge found no answer ("It only says the question was answered elsewhere and a wiki change was queued"). All 3 are wrong, and this is a failure of the arm with the wiki that a file read does not cause. These 3 runs are 3 of the 3 rows that separate the gap group (88%) from 100%.
- **Cost.** The arm with the wiki reads more input tokens in the questions (48.3k against 29.5k) and takes 5.2 turns against 3.8; it saves file reads (1.5 against 2.8 per run) but the tool definitions and the results cost more than the reads save, except in the held questions (32.2k against 30.5k, $0.038 against $0.046).

## What the note supports

- The held bar for questions (right as often, lower dollars) is not met on the corrected numbers: 79% against 83% right, with the dollars lower ($0.038 against $0.046). The difference is 1 run in 24; the run is too small to say whether the bar holds.
- The two causes in the arm with the wiki that the data show are the stop after a partial wiki answer (complex questions) and the final text of a run that ends with a `requestChange`. Neither is in the files of the run: both are in the tool calls and the judge's reasons.
- Open: a second run of the same file, with the answers stored, tests the corrected labels and gives the answers for a second review.
