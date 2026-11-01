# Test of both paths at 100 requests with the real models, after the batch rebuild (2026-10-22)

Issue #32. The batch path at 100 requests is 2.0 times faster than the path of 1 request at a time, and it costs 1.23 times more. It does not meet the bar of the high volume mode: faster, cheaper, and at least as good. The run also shows a defect: 16 children of 6 split requests never ran on the batch path. The defect is in the resume of the test, not in the batch path (section "Defect").

## Method

Command: `npm run bulk-test -- --db .cache/bulk-wiki/real/bulk.sqlite --requests 100`, on v0.1.79. The source is the test wiki that `npm run bulk-wiki` builds (`fakes/bulk-seed-facts.ts`, `fakes/bulk-submissions.ts`): 100 queued submissions, the 2 compound claims of #32 first. The models are the real ones (`stub` false). Batch size 100, concurrency 4. The run started on 2026-10-22 at 06:02:49 UTC. It stopped in the batch path and was resumed with `--resume` ([the stop](#the-stop-and-the-resume)). Result files: `.cache/bulk-run-32.json` (after the resume) and `.cache/bulk-run-32.before-resume.json`; log: `.cache/bulk-run-32.log`.

The two working copies (`bulk-sequential.sqlite`, `bulk-batch.sqlite`) did not exist when this note was written. The harness removes them when a run ends. So the rows could not be read. Every fact below comes from the result file, the file from before the resume, the log and the source wiki `bulk.sqlite` (opened read-only, for the text of the submissions). The reject reasons of most requests are not in the result file, and the duplicate targets are not in it either.

The source differs from the earlier notes (a backup of the live wiki, 1,747 queued submissions). The numbers of the notes of 2026-10-20 and 2026-10-21 are not comparable one to one with these.

## Time, calls, tokens and dollars

| | Sequential | Batch | Batch / sequential |
| --- | --- | --- | --- |
| Wall time of the steps | 3,375.0 s | 1,673.2 s | 0.50 |
| Model calls | 433 | 591 | 1.37 |
| Tokens in | 866 | 1,182 | 1.36 |
| Tokens out | 154,221 | 195,458 | 1.27 |
| Cache read | 829,543 | 1,350,789 | 1.63 |
| Cache write | 1,495,753 | 1,576,028 | 1.05 |
| Cost | $6.4188 | $7.8965 | 1.23 |

Per request (100 requests):

| | Sequential | Batch |
| --- | --- | --- |
| Time | 33.75 s | 16.73 s |
| Calls | 4.33 | 5.91 |
| Tokens in / out | 8.7 / 1,542 | 11.8 / 1,955 |
| Cache read / write | 8,295 / 14,958 | 13,508 / 15,760 |
| Cost | $0.0642 | $0.0790 |

The two paths did not do the same work. The sequential path ran 100 requests and 42 children (142 steps). The batch path ran 100 requests and 29 children (129 steps); 16 children did not run. For each step that ran:

| | Sequential | Batch | Batch / sequential |
| --- | --- | --- | --- |
| Time | 23.77 s | 12.97 s | 0.55 |
| Calls | 3.05 | 4.58 | 1.50 |
| Cost | $0.0452 | $0.0612 | 1.35 |

- The batch path ended its first step (100 requests) in 1,132.3 s with 392 calls and $5.1076. The second step (29 children) took 540.9 s and 199 calls and $2.7889. The usage of the second step includes the calls of an attempt that the stop cut off ([the stop](#the-stop-and-the-resume)). The wall time does not include that attempt. So the cost of the batch path holds waste that its time does not.
- The 11 change lines of the cut attempt add up to 78 tokens in, 11,258 out, 100,345 cache read and 100,246 cache write. This is a lower bound: the calls of the 4 children that were in flight left no line.
- The calls by question, sequential against batch: Q1 114 against 231, Q4 114 against 119, Q5 55 against 63, Q7 142 against 156, Q2 6 against 17, Q3 2 against 5. Of the 158 extra calls, 117 are Q1 calls.
- If the 16 children had run at the rate of the second step ($0.096 for each child, waste included), the batch path would cost about $1.5 more, a ratio of about 1.47. This is an estimate. It was not measured.

Under the rule of the high volume threshold:

| Part of the bar | Result at 100 requests |
| --- | --- |
| Faster | Yes. 2.0 times, and 1.8 times for each step that ran. |
| Cheaper, with the cost of the checks included | No. The batch path costs 23% more (35% more for each step). |
| At least as good | Not shown. 16 children did not run, the claim check gave another verdict on 5 requests, and the batch path left 0 real duplicate pairs against 1. |

So the threshold of 100 requests is not met. The cost gap of the earlier notes (27 times cheaper on 2026-10-21) is gone: the batch path now runs the questions of the full pipeline for each request, with 591 calls against 8 on 2026-10-21 (another source, see Method).

## Compound claims of #32

| Claim | Sequential | Batch |
| --- | --- | --- |
| 1. "The console flags a read when the share of searches with 0 reads is over 0.5 (NO_READ_SHARE), ... 3 or more reads is over 0.3 (MANY_READS_SHARE), or ... sessions with no search is over 0.3 (NO_SEARCH_SHARE)." (`...W4G897`) | Accepted as 1 fact, "Read flags", with the 3 thresholds in it. This is the failure that #32 names. The submission check (Q7) let it pass as 1 claim. | Split into 3 children by Q7 (one call of 7.1 s). The 3 children never ran: their status is `running` in the result file. |
| 2. "WikiFact is written in TypeScript on Node.js 22 with better-sqlite3." (`...MQMJ`) | Rejected. The result file holds no reason. | Rejected, after a stale write and a second run alone on the live wiki. The result file holds no reason. |

- Both ends are allowed by the test data (`split` or `rejected` as compound). The sequential end of claim 1 is not.
- For claim 2 the log has `scope_overmatch` lines on both paths. The gathering and the relation check came before the reject. So Q7 did not end it at step 1, and a later question rejected it. The question that decided is not in the files.

## The 14 requests with another outcome

Marker `[CC]`: the claim check (Q7, the split or compound decision) decided. #21 needs these.

| Request | Sequential | Batch | Cause |
| --- | --- | --- | --- |
| `...W4G897` (claim 1) | accepted | split, 3 children `none` | `[CC]` Q7 gave another verdict on the same text. Then group A. |
| `...EGPJ4T` listWikis, Q12, clean-temp | split: duplicate, rejected, duplicate | split, 3 children `none` | Group A. Both split it. The sequential child 2 was rejected by Q7 as still compound: "Model (sonnet) and effort level (low) are two independent settings of Q12, so one could be wrong while the other holds" `[CC]`. |
| `...YC85AN` incremental, dotenv | split: duplicate, duplicate | split, 2 children `none` | Group A. |
| `...F0R33A` future.md, research, Windows | split: duplicate, duplicate, rejected | split, 3 children `none` | Group A. |
| `...XVH6D6` index file | split: accepted, accepted | split, 2 children `none` | Group A. |
| `...XVH6DD` index file, typecheck cache, archiveWiki | split: duplicate, accepted, duplicate | split, 3 children `none` | Group A. |
| `...H93PA2` ESLint keeps no cache | split: duplicate, accepted | accepted | `[CC]` The sequential Q7 split it (a call of 8.1 s). The batch Q7 passed it as 1 claim; a later merge change (seq 94) joined it with a live fact. |
| `...GQ45AD` ESLint cache would miss an error | duplicate | split: accepted, duplicate | `[CC]` The batch Q7 split it (6.2 s). The sequential path did not split it and judged it a duplicate. |
| `...AMBNHH` Q4 opus with high effort | split: accepted, accepted | accepted (1 fact) | `[CC]` Model and effort are 2 attributes. The sequential Q7 split it. The batch Q7 passed it. |
| `...AMBNHM` Q12 sonnet with low effort | accepted (1 fact) | split: accepted, accepted | `[CC]` The same shape as the row above, and the verdicts are the other way round. |
| `...YC85AG` check does not call clean-temp | accepted | duplicate | Group C. The sequential Q4 saw the fact `...K2XB` ("clean-temp is never run by npm run check") and still accepted: the pair "Clean-temp command" and "Check and clean-temp" is the sequential duplicate pair at distance 0.046. The batch run was stale, ran again alone on the live wiki that held the fact, and judged a duplicate. The batch path is right. |
| `...XVH6D4` check writes the pid | duplicate | accepted | Group C. The batch path ran this request and the request that holds the same claim (`...F0R336`) in the same batch. The first run accepted it. A later merge change (seq 93) joined the two. The outcome label differs; the end state is 1 fact. |
| `...R74G1H` caches live in .cache | split: duplicate, accepted | split: accepted, accepted | Group C. The child "Typecheck cache" was a duplicate on the sequential path because the children of `...XVH6DD` had made that fact. On the batch path those children did not run, so this child made the fact. Both paths hold the fact once. |
| `...AKTJKD` log line, unarchiveWiki, package-lock | split: duplicate x3 | split: accepted, accepted, duplicate | Group C. The children ran in the same batch as the children of `...VHNZ1W` and `...GQ45AF`, which state the same two claims. The sequential path saw the earlier facts. The pair finder found no leftover pair for them. |

Groups of causes:

| Group | Cause | Requests |
| --- | --- | --- |
| A | Children of the batch path did not run (defect) | 6: W4G897, EGPJ4T, YC85AN, F0R33A, XVH6D6, XVH6DD |
| B | The claim check gave another verdict on the same text `[CC]` | 5: W4G897, H93PA2, GQ45AD, AMBNHH, AMBNHM |
| C | The duplicate judgment depends on the order of the requests (a batch runs requests side by side) | 4: YC85AG, XVH6D4, R74G1H, AKTJKD |

The request W4G897 is in A and B. 14 requests: 5 only in A, 1 in A and B, 4 only in B, 4 in C.

- The claim check is not stable. On the 2 "model and effort" claims (AMBNHH, AMBNHM) the two paths gave opposite verdicts, 2 of 2. On the 5 requests of group B, the sequential path split 2 and the batch path split 3. The sequential path accepted claim 1 of #32 as one fact.
- The result file keeps a reject reason for 1 of the 14 (the child above). The files do not show the duplicate target of any of them, except the two found in the log lines (`...K2XB` for YC85AG; the merge lines for XVH6D4 and H93PA2).
- The other counts of the result file: 35 headers that both paths hold (16 with the same content), 20 facts only on the sequential path and 14 only on the batch path. Most of these are the same claim in other words, for example "Env file loader" and "Env file loading".

## Duplicates

The orchestrator read the 2 facts of each pair that Q1 found. The pair finder checked 55 facts (131 candidate pairs) on the sequential path and 50 facts (119 candidate pairs) on the batch path.

| Path | Pairs | Real duplicates | Partial overlaps | Not duplicates |
| --- | --- | --- | --- | --- |
| Sequential | 11 | 1 | 2 | 8 |
| Batch | 12 | 0 | 2 | 10 |

- Sequential, the real duplicate: "Clean-temp command" ("never run by npm run check") and "Check and clean-temp" ("does not run the clean-temp command"), distance 0.046. It is the request YC85AG above. Partial overlaps: "Search result cap" with "Config search cap" (the default cap, and the key that sets it), and "Worker count" with "Second worker" (one worker for each database, and what a second worker does).
- Batch, no real duplicate. Partial overlaps: "Search result cap" with "Config search cap" (the same pair), and "ESLint cache" with "Lint cache" (why the lint step has no cache, and that it has none).
- The other pairs hold 2 attributes of 1 subject: the two halves of a split (for example "Index file" and "Index file logic", "createWiki idempotent annotation" and "createWiki annotation") or neighbors in a topic ("Console call rule" and "Console path").
- The two children of AMBNHM show the same fact, "Q12 runs on sonnet in the question tests." The result file shows no effort part in it. The rows are gone, so it is not known whether this is 1 fact or 2.

The batch path leaves no more real duplicates than the sequential path (0 against 1), as at 100 requests on 2026-10-21. This part of the bar holds.

## Defect

The state: 16 children of 6 split requests have the status `running` and no outcome in the result file, after the harness marked the batch path as complete (steps 2, both batches `done`). The harness counts them as `child none`.

| Parent | Children (status `running`) | Event in the log |
| --- | --- | --- |
| `01M5H38X4DJAGCXFBSD5W4G897` | `01M5H6GB54WMAW0M89S4GRWEXX`, `...EXY`, `...EXZ` | 3 change lines in the cut attempt (seq 105, 106, 109) |
| `01M5H38X4GWRP63GCME0EGPJ4T` | `01M5H6GXNFBMYP68SRV517Y2QM`, `...2QN`, `...2QP` | 2 change lines (107, 108) and 1 stale line |
| `01M5H38X4H8V6XCTYE1WYC85AN` | `01M5H6JA3GBTMZNJPVZRQCR4E3`, `...R4E4` | 2 change lines (110, 111) |
| `01M5H38X4JWRSXMBWY5HF0R33A` | `01M5H6M90B6JSG9KHKZQY29WG9`, `...29WGA`, `...29WGB` | 3 change lines (112 to 114) |
| `01M5H38X4KMZTWMG51Z4XVH6D6` | `01M5H6MYJD6ZV4A6WR4BRR54BJ`, `...54BK` | 1 change line (115) for `...54BJ`; none for `...54BK` |
| `01M5H38X4KMZTWMG51Z4XVH6DD` | `01M5H6NSJ792DXFRXDSAVJ2T03`, `...2T04`, `...2T05` | none |

What the files show:

1. The first step of the batch path (100 requests) ended with `batch_done`. It queued 45 children.
2. The second step took 16 children in queue order, which are the 16 children above (the 16 oldest). It ran them: 11 change lines and 1 stale line in the log. The run stopped then. The 4 last children were in flight.
3. The resume started the batch step again. Its first action was `batch_dropped` ("a crash left the staging set of a batch", staged 11). The drop empties the staging tables. The 16 requests stayed `running`.
4. The step ran again with the 29 children that were still `queued`, and `batch_done` came with size 29. No batch took the 16 `running` rows, because a batch takes `queued` rows only. The harness stopped when no batch was left.

The cause, from the code: `dropLeftStaging` (`src/updates/batch/step.ts`) says that the requests of a dropped set "were put back to the queue when the worker started". That is `resetRunning` (`src/store/queue.ts`), which `src/updates/worker.ts` calls at its start. The harness of the bulk test does not start a worker and calls `resetRunning` nowhere (`eval/bulk/` has no call). So after a stop in the middle of a batch, a resume leaves the requests of that batch `running` for ever.

Is it a defect of the batch path? In production, a worker restart puts the rows back, so this run does not show a defect there. It is a defect of the resume of the bulk test (`eval/bulk/`). A second fault is that the test reports the path as `complete` with 16 requests in a state that no step can leave. Effect on this note: the batch path did 129 steps and not 145, which moves the cost and the outcomes (groups A and C above). The fix is the reset of `running` rows in `--resume`, and a check that fails a path that ends with a `running` row. No code was changed for this note.

## The stop and the resume

- The sequential path ended at 3,375.0 s, so at about 06:59:04 UTC. The batch path started at 06:59:09.7 UTC (`startedAtMs` 1792652349684). Its first step took 1,132.3 s, so it ended at 07:18:02 UTC.
- The file from before the resume says: `complete` false, the sequential path complete, the batch path not complete, `steps` 1, `batches` one entry (`done`, size 100), 100 requests with an outcome, and 45 children `queued`. `attemptErrors` is empty.
- The log has no rate limit line and no error line. After the first `batch_done` it has the 12 lines of the cut attempt (11 changes and 1 stale), and then the `batch_dropped` line of the resume. The log lines carry no time, so the exact time of the stop is not in the files; it was after 07:18:02 UTC and before the next promotion.
- The resume (about 17:50 UTC) took the sample size, the batch size and the concurrency from the file, skipped the sequential path and continued the batch path from its last step: the second step, with the counters, the time (1,132.3 s kept, plus 540.9 s) and the start of the usage window of the first run. The final wall time of the batch path, 1,673.2 s, is the sum of the two steps. The gap between the stop and the resume is not in it.
- The cut attempt cost calls that stayed in the usage (the usage window starts at the start of the path) but not in the wall time ([Time, calls, tokens and dollars](#time-calls-tokens-and-dollars)).

## Result

1. At 100 requests the batch path is 2.0 times faster and 1.23 times more costly. The bar is faster and cheaper, and it is not met. `highVolume.min` stays 10, the smallest size measured. The owner decides whether a size is worth a new test.
2. The judgment of the batch path is not shown to be as good: 16 children did not run (a defect of the resume of the test), and the claim check gave another verdict on 5 of 14 requests, in both directions. The sequential path accepted compound claim 1 of #32 as one fact. #21 needs the 5 requests of group B and the child rejected by Q7.
3. The batch path left no real duplicate. The sequential path left 1.
4. Next: fix the resume of the bulk test (reset `running` rows, fail a path that ends with one), then run again. A run with the 16 children gives the true ratio of cost (an estimate of 1.47 in this note).
