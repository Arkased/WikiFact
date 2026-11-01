# The first live runs of the duplicate fact finder, 2026-10-21

The duplicate fact finder of the cleanup ([cleanup.md](../design/cleanup.md#duplicate-fact)) ran 2 times on the `wikifact` wiki on 2026-10-21, from the Jobs page, with v0.1.67. It checked 40 pairs and merged 9. 4 of the 9 merges were wrong: each deleted a true fact. The cause is Q1, which reads headers only, and a merge step that has no guard against sibling scopes (#31).

## Method

1. Start the cleanup with `POST /console/w/wikifact/jobs/cleanup`, 2 times (04:59 and 05:09 UTC).
2. Read the `cleanup_repair` and `change` lines of the worker log for each request of the finder.
3. Read the fact versions that each merge wrote, from the live database, read-only.

## Result

| Run | Pairs | Merged | No change (Q1 found no match) |
| --- | --- | --- | --- |
| 1 (04:59 to 05:02) | 20 (the cap) | 5 | 15 |
| 2 (05:09 to 05:11) | 20 (the cap) | 4 | 16 |

The 9 merges:

| Seq | Kept fact | Deleted fact | Judgment |
| --- | --- | --- | --- |
| 4545 | VEC_CANDIDATES recall at 100k facts (100 gives 0.84) | VEC_CANDIDATES 200 recall at 100k facts (200 gives 0.96) | Wrong. 2 measurements. The value for 200 is lost. |
| 4546 | Update agent tool deleted facts | Tool agent form deleted facts | Correct. The same claim. |
| 4547 | SCHEMA_VERSION at schema 7 ("became 7") | SCHEMA_VERSION at schema 9 ("is 9") | Acceptable. "Is 9" was stale: the code has 14. "Became 7" is history and stays true. |
| 4548 | npm run deploy deployment folder | npm run deploy created folders | Correct. The same content. |
| 4549 | Console rename name length (400 at the preview) | Worker rename name length (the worker rejects with `unsupported`) | Wrong. 2 layers with 2 behaviors. The worker behavior is lost. |
| 4571 | Console chart y axis top | Console chart Y axis | Correct, with a loss: the detail "3 labels: 0, a middle value and a top" is not in the kept content. |
| 4572 | Overview empty state no searches ("No searches yet") | Overview empty state no searches in span ("No searches in this span") | Wrong. 2 empty states. The second is lost. |
| 4573 | mapJudgment compound rejection (the behavior now) | mapJudgment former compound failure (the behavior before commit ec4f3d2) | Wrong. The old behavior is lost. |
| 4574 | Update agent tool limit argument | Tool agent form limit | Correct. The same claim. |

Total: 4 correct, 1 acceptable, 4 wrong.

The 31 pairs with no change were mostly sibling facts, which is correct. 1 of them is a partial overlap: "wikifact requeue command" and "wikifact requeue listing".

## Cause

Q1 reads the claim and the headers of the candidates, and its prompt says that a difference of value does not matter. In each wrong merge, the header of the older fact is broader than the header of the newer fact, and Q1 judged them as 1 scope. The merge step then kept 1 content. Q2, the first question that reads both contents, can answer only "kept" or "other". On the path of 1 request at a time, Q4 has the answer `unrelated` for this error (F24). The merge step has no such answer.

## Decision

Q2 gets a third answer, `unrelated`. An unrelated fact leaves the merge and stays live ([Step 3. Merge](../technical/updates.md#step-3-merge), #31). The 4 lost facts are submitted again through `requestChange`, where Q4 can answer `unrelated`.

## Repair of the lost facts

The 4 submissions of 2026-10-21 05:17 to 05:20 UTC on the path of 1 request at a time:

| Lost fact | Result |
| --- | --- |
| VEC_CANDIDATES 200 recall at 100k facts | Split into 2 claims. The recall claim is a new fact (seq 4583). The latency claim is a duplicate of "VEC_CANDIDATES latency at 100k facts". |
| Overview empty state no searches in span | Split into 2 claims. The deleted fact is revived (seq 4585). The other claim is a duplicate of "Overview empty state no searches". |
| Worker rename name length | A new fact, "operatorEdit rename word limit rejection" (seq 4582). |
| mapJudgment former compound failure | Split into 2 claims. The deleted fact is revived (seq 4590). The other claim is a new fact, "Pre-B-011 mapJudgment compound failure" (seq 4591). |

Q1 matched none of them to the wrong sibling, or Q4 answered `unrelated`. No live fact was overwritten.
