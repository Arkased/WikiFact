# Test of both paths at 1 and 5 requests (2026-10-21)

Issue #30. The batch path is 3 to 4 times cheaper at 1 and 5 requests, but it does not judge as well. It accepted 2 claims with more than 1 claim in them, in 2 of 2 runs. The path of 1 request at a time rejected both as compound. So the debounce does not come, and `min` stays 10.

## Method

Command: `npm run bulk-test -- --db <copy> --requests N`, on v0.1.67, with the same source as the [test at 100 requests](bulk-test-2026-10-21.md): a backup of the `wikifact` wiki with 1,747 queued submissions. Batch size 100, concurrency 4. The second run at 5 kept the working copies (`--keep-copies`), so that the reject reasons could be read.

Result files in `eval/bulk/results/`:

| Run | File |
| --- | --- |
| 1 request | `2026-10-21T05-11-30.576Z.json` |
| 5 requests, run 1 | `2026-10-21T05-13-27.382Z.json` |
| 5 requests, run 2 | `2026-10-21T05-19-56.338Z.json` |

## Time and cost

| Run | Sequential time | Batch time | Sequential cost | Batch cost | Sequential calls | Batch calls |
| --- | --- | --- | --- | --- | --- | --- |
| 1 request | 38.0 s | 46.5 s | $0.183 | $0.048 | 4 | 7 |
| 5 requests, run 1 | 107.6 s | 76.9 s | $0.405 | $0.083 | 12 | 8 |
| 5 requests, run 2 | 126.3 s | 62.4 s | $0.198 | $0.059 | 12 | 7 |

The cost of a path changes by a factor of 2 between 2 runs of the same 5 requests, from the prompt cache. The batch path is cheaper in each run. At 1 request it is slower, because a split adds a second batch.

## Judgment

The 5 requests are the first 5 queued submissions of the source.

| Request | Sequential | Batch |
| --- | --- | --- |
| "A fact version is observed when ...; the first version is observed when its justification is not blank." | Accepted as 1 fact in each of 3 runs (a new fact 2 times, an update of the live fact 1 time). | Split into 2 claims in each of 3 runs. In 2 runs, 1 child was judged a duplicate of a live fact. |
| "The console flags a read when the share ... is over 0.5 (NO_READ_SHARE), ... over 0.3 (MANY_READS_SHARE), or ... over 0.3 (NO_SEARCH_SHARE)." | Rejected as compound by Q4, in 2 runs. | Accepted, in 2 runs. |
| "WikiFact is written in TypeScript on Node.js 22 with better-sqlite3." | Rejected as compound by Q4, in 2 runs. | Accepted, in 2 runs. |
| "A dependent that still holds ... gets a new version without that reference, and no model writes it." | Rejected as compound by Q7. | Rejected as compound by Q7B. |
| "A dependent that does not hold goes to a draft question ..., and the rewrite has an empty justification ..." | Rejected as compound by Q7. | Rejected as compound by Q7B. |

- The split of the first request is better on the batch path: the request holds 2 rules.
- The second and third requests hold 3 thresholds and 3 parts of a stack. Each part can be wrong alone, which is the test of a compound claim. Q7 and Q7B both let them pass. On the path of 1 request at a time, Q4 rejects them with the reason `compound`. The batch path has no such second check: Q5B, Q15 and Q8 do not judge whether a claim is compound.
- A fact with 2 claims is 1 of the 2 costly failures of the pipeline ([design/updates.md](../design/updates.md)). So the batch path does not judge at least as well at these sizes.

## Result

The condition for the worker debounce fails. Nothing changes: the worker starts at once, and `min` stays 10. The missing compound check of the batch path also applies to the batches of 10 or more that run today. Issue #32 tracks it. After its fix, the test at 1 and 5 can run again.
