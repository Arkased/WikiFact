# Bulk architectures: measured runs, 2026-10-26

Issue #60, steps 3 to 5. The estimates and the labels are in the [earlier note](bulk-architectures-2026-10-22.md). Each path ran on its own copy of the real test wiki (`npm run bulk-wiki`), with the 100 queued submissions, the real models and concurrency 4. The result files are in `eval/bulk/results/`, and each file has the scores of the scorer of #81.

## Result

- **Use path C, 1 judgment for each group, with a batch size of 10 and a wait of 60 s.**
- **C at batch size 10 is the fastest path and judges as well as the benchmark.** It takes 7.6 s for each change request, against 17.3 to 17.5 s for the benchmark of 1 request at a time (2.3 times faster). It scores 104 right and 13 wrong, and the benchmark scores 100 to 104 right and 15 to 17 wrong.
- **No path is cheaper than the benchmark.** C at batch size 10 costs $0.0469 for each change request, against $0.0403 to $0.0448 for the benchmark (5% to 16% more). The cost and the speed are judged by cost and benefit, with no fixed exchange rate.
- **A smaller batch is faster and cheaper, and not less accurate.** From batch size 100 to 10, path C takes 8% fewer calls, 7% less money and 15% less time for each change request.
- **A, the fixed batch of today with the fixes for the conflicts inside a batch, is the worst.** It leaves 22 duplicate pairs and 59 new facts (41 to 46 expected).

## Architectures, batch size 100

A "change request" is a request that ran: the 100 submissions and the children of their splits (136 to 141). The benchmark ran 3 times, 1 time beside each architecture, on its own copy.

| Path | Time | Calls | Dollars | Time per change request | Calls per change request | Dollars per change request | Right / wrong | Duplicate pairs | New facts |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Benchmark, run beside A | 2,411 s | 426 | 5.56 | 17.5 s | 3.09 | 0.0403 | 101 / 16 | 8 | 48 |
| Benchmark, run beside B | 2,436 s | 432 | 6.32 | 17.3 s | 3.06 | 0.0448 | 104 / 15 | 7 | 48 |
| Benchmark, run beside C | 2,409 s | 425 | 5.66 | 17.5 s | 3.08 | 0.0410 | 100 / 17 | 10 | 50 |
| A, fixed batch | 1,597 s | 567 | 6.98 | 11.6 s | 4.11 | 0.0506 | 95 / 22 | 22 | 59 |
| B, groups first | 1,256 s | 515 | 7.09 | 9.1 s | 3.73 | 0.0513 | 100 / 17 | 10 | 50 |
| C, 1 judgment for each group | 1,231 s | 446 | 6.98 | 8.9 s | 3.23 | 0.0506 | 103 / 14 | 9 | 48 |

The right and wrong ends count the 117 labels that are not unclear. The duplicate pairs and the new facts are checks of the end state: the labels expect 0 duplicate pairs and 41 to 46 new facts. Every path leaves 7 or more duplicate pairs, so the later check that merges the duplicates of a batch stays necessary.

## Path C at 4 batch sizes

The runs at batch sizes 10, 25 and 50 ran with `--second-only` (no benchmark), all 3 at the same time.

| Batch size | Time | Calls | Dollars | Time per change request | Calls per change request | Dollars per change request | Right / wrong | Duplicate pairs | New facts |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 10 | 1,029 s | 403 | 6.38 | 7.6 s | 2.96 | 0.0469 | 104 / 13 | 11 | 49 |
| 25 | 1,049 s | 421 | 6.51 | 7.6 s | 3.05 | 0.0472 | 101 / 16 | 12 | 50 |
| 50 | 1,162 s | 446 | 6.64 | 8.4 s | 3.23 | 0.0481 | 101 / 16 | 10 (judging incomplete) | 51 |
| 100 | 1,231 s | 446 | 6.98 | 8.9 s | 3.23 | 0.0506 | 103 / 14 | 9 | 48 |

At batch size 50, the session limit of the Claude Code login stopped some calls of the duplicate judging, so its duplicate pairs are a lower bound. No run has attempt errors.

## The batch size and the wait

**Batch size 10.** It is the smallest size measured, and it is the fastest and the cheapest with the best score. A large batch gives no gain in accuracy: the groups at the cut of 0.215 are small (largest 1 to 3 at size 10), so most claims are judged alone or in a pair. Sizes under 10 are not measured.

**Wait 60 s.** A batch of 10 runs for about 103 s (1,029 s for 10 batches and their children rounds). A submission that comes while a batch runs waits for that batch in any case. The wait applies only when the worker is idle: the first submission then waits at most 60 s, and its batch ends about 160 s after the submission. This is less than the 3.5 minutes of work that is accepted for a queue of 9 requests. A longer wait fills more batches but gives no accuracy, because size 10 judges as well as size 100.

## What changed during the runs

- **The score of an equal pair (#81).** The labels put each child of a split after all 100 submissions. In a run in batches, a child can run before the later submission that its label names as its original. The child is then accepted as new and the submission ends as its duplicate. The wiki holds the same facts. The first scores counted both ends as wrong (86, 83 and 87 right at sizes 10, 25 and 50). The scorer now takes both orders as right, and `npm run bulk-test -- --rescore <file>` scored the files again.
- **A stale test wiki.** The first runs used a wiki built before a change of the submissions. Their results were deleted, and the bulk test now stops on a stale wiki (the meta key `bulk_test_wiki`).

## Method

- Wiki: `.cache/bulk-wiki/real/bulk.sqlite`, built with `npm run bulk-wiki` on 2026-10-26.
- Architectures: `npm run bulk-test -- --db .cache/bulk-wiki/real/bulk.sqlite --requests 100 --arch batch-fixed|groups|group-judge --group-cut 0.215 --work-dir .cache/bulk-work/<x>`. The 3 runs ran at the same time.
- Batch sizes: the same with `--arch group-judge --batch-size 10|25|50 --second-only`.
- Model calls: the CLI transport (`claude -p` with the Claude Code login). The dollars are the `model_calls` rows priced by `config/prices.json`.
- Results: `eval/bulk/results/2026-10-27T00-48-59.390Z.json` (A), `00-49-00.849Z` (B), `00-49-02.146Z` (C), `02-14-36.442Z` (C, 10), `02-14-38.221Z` (C, 25) and `02-14-40.084Z` (C, 50).
