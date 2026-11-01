# Hard negatives in Q1 and Q4, 2026-10-29

The first measurement of the sets of Q1 and Q4 with the kinds of hard negative (#103). Each configuration is the `standard` pick of `config/presets.json`, 3 runs, no staging (`--full`), over the CLI transport. Every interval is the 95% Wilson interval over all answers of the 3 runs (cases times 3).

```
npm run eval:questions -- Q1 --model claude-opus-5-5 --effort medium --runs 3 --full
npm run eval:questions -- Q4 --model claude-sonnet-5-5 --effort high --runs 3 --full
```

The result files: Q1 `eval/questions/results/2026-10-29T20-45-20.020Z.json`, Q4 `eval/questions/results/2026-10-29T20-45-20.495Z.json`. The first runs of this day also wrote files, but nobody committed them (the folder is not ignored, so the files stayed untracked in an agent worktree that was removed); the runs were repeated and the files are kept. The tables below are the numbers of these two files.

## Cases of each kind

| Set | negation | changedValue | supersession | scopeDifference |
| --- | -------- | ------------ | ------------ | --------------- |
| Q1  | 5 (0 old, 5 new) | 5 (0 old, 5 new) | 5 (0 old, 5 new) | 17 (17 old, 0 new) |
| Q4  | 7 (4 old, 3 new) | 7 (4 old, 3 new) | 7 (4 old, 3 new) | 13 (13 old, 0 new) |

The new cases are built from facts of the dogfood wiki `wikifact` (the update worker retry and requeue, the tag cleanup cap and finder count, the log retention, the Anthropic SDK retry count, the search cap, the eval pass bar).

## Q1, claude-opus-5-5 at medium

Mean 95.1% [91.7-97.2]; runs 95.1%, 95.1%, 95.1%; 0 errors, 0 unstable.

| Score | Cases | Mean | 95% interval | Missed |
| --- | --- | --- | --- | --- |
| designed | 52 | 100.0% | [97.6-100.0] | none |
| real use | 30 | 86.7% | [78.1-92.2] | q1-40, q1-41, q1-45, q1-64 |
| negation | 5 | 100.0% | [79.6-100.0] | none |
| changedValue | 5 | 100.0% | [79.6-100.0] | none |
| supersession | 5 | 100.0% | [79.6-100.0] | none |
| scopeDifference | 17 | 94.1% | [84.1-98.0] | q1-45 |

Every new case passed in every run. The 4 misses are old real-use cases (the model matched a fact where the label says none).

## Q4, claude-sonnet-5-5 at high

The label of q4-80 was reviewed after an earlier run of the set (the model answered the relation `different`, the label said `negates`). The Q4 prompt reserves `negates` for a claim that gives no new content for its subject. The justification of q4-80 names a new value (`maxRetries 0`), so its label became `different` and the note says "unclear". The label of q4-81 stays `negates` (the claim is a pure denial), also noted "unclear", because its justification describes the behavior. This run, with those labels:

Mean 97.3% [94.6-98.7]; runs 97.7%, 96.6%, 97.7%; 0 errors, 4 unstable (q4-10, q4-48, q4-63, q4-67).

| Score | Cases | Mean | 95% interval | Missed |
| --- | --- | --- | --- | --- |
| designed | 58 | 98.3% | [95.1-99.4] | q4-81 |
| real use | 30 | 95.6% | [89.1-98.3] | q4-48, q4-63, q4-67 |
| negation | 7 | 85.7% | [65.4-95.0] | q4-81 |
| changedValue | 7 | 100.0% | [84.5-100.0] | none |
| supersession | 7 | 100.0% | [84.5-100.0] | none |
| scopeDifference | 13 | 100.0% | [91.0-100.0] | none |

The only miss on a new case is q4-81, reviewed above; its label stays. q4-48, q4-63 and q4-67 are old real-use cases. No label changed in this rerun.

## Reading

- No kind is below the pass bar of 90% on its point estimate, but the intervals are wide: with 5 to 7 cases and 3 runs, an interval spans 15 to 20 points. A kind with 5 cases cannot show a drop of a few points.
- The one weak spot is the boundary of `negates` against `different` in Q4: a denial whose justification describes what happens now. Whether such a claim "gives new content" is a judgment of the label, so the case q4-81 stays marked "unclear".
- In Q1 the headers-only rule makes the three value kinds easy: the model matches the one scope in all 15 runs of each kind.
