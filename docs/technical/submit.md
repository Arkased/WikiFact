# Submit a change

Technical layer. The requirements are in [../requirements/submit.md](../requirements/submit.md). The design is in [../design/submit.md](../design/submit.md).

## `requestChange`

```ts
// input
{
  change: string;         // not empty
  targets?: string[];     // fact ids
  justification: string;  // not empty; prose, no fact ids
  searchId?: string;      // the `searchId` that `search` returned for the search this change follows: the one that did not return the fact, or that listed the fact this change corrects
}

// output
{
  requestId: string;
  status: "queued";
  position: number;           // the number of queued requests, this one included; a running request is not counted
  estimatedSeconds?: number;  // round(position * mean processing time of the last done requests); absent until a done request has both times
  warning?: string;           // see below
}
```

The call stores `searchId` on the request row (`change_requests.search_id`, schema 10; NULL when absent). A `searchId` that is no search of this wiki is a tool error. A child of a split gets the `search_id` of its parent. The console links a request to that search and to no other ([Store API reads for the signals](console.md#store-api-reads-for-the-signals)). The prior query of the lookup repair is the `query` of that search; a stored `search_id` whose search is gone (not possible through the tool, which checks the id) makes the prior-query check do nothing and a `lookupRepair` skip with the reason "search is gone". The eval and replay harnesses and the test helpers get a `searchId` by a real search through the store (`searchAndLog` in [lookup.md](lookup.md#store-functions)), so a replay case keeps its query text. The field `priorQuery` and the column `prior_query` of earlier schemas are gone (the owner, October 17, 2026: the consumer repeats no text that the wiki has). The call also stores the session id of the call (`change_requests.session_id`, schema 8), which counts the processes and links nothing.

The call returns at once (requirement "One call"). A string of spaces only counts as empty. A `targets` id that is no fact is a tool error (`targets: no fact with id "<id>"`), one read per id, so the submitter learns it at once instead of a dropped id at gather.

`warning` is set when the worker cannot process the request. `workerWarning` (`src/mcp/warning.ts`) checks the worker status in this order and names the first condition that holds, with its time: no worker has written a status on this database; the worker's last poll is older than `STALE_POLL_MS` (60 seconds); the operator paused the queue (the `queue_pause` key of `meta`, [Queue and worker](updates.md#queue-and-worker): "the operator paused the queue at <ISO time>: <note>; the request waits until the operator resumes the queue"); the worker's last model call failed on its credential (an expired token, a missing key); or the last model calls failed on another error `MAX_ATTEMPTS` times in a row. The text comes from the worker status of [Queue and worker](updates.md#queue-and-worker). The request is queued in every case, so a consumer can read `warning`, tell the user, and go on.


## getRequest

| Tool | Input | Output |
|---|---|---|
| `getRequest` | `wiki`, `requestId` | `{ requestId, status, outcome?, duplicateOf?, factIds?, childIds?, error?, attempts, finishedAt? }`, so a session can see whether a submission landed. `status`, `error`, `attempts` and `finishedAt` come from the `change_requests` row. `outcome` (`accepted`, `duplicate`, `rejected` or `split`), `duplicateOf` (the id of the fact that a duplicate matched) and `factIds` (the facts that the change wrote, new or new versions; absent when it wrote none) come from the `changes` row of a `done` request, and are absent while the request is not done. `childIds` (the ids of the requests that a split made, in claim order) comes from the `change_requests` rows whose `parent_id` is the request, and is present for the outcome `split` only. An unknown id is a tool error. On a wiki endpoint the tool exists without `wiki`. |

## Split of a compound submission

Q7 returns `claims` beside its verdict ([Step 1](updates.md#step-1-claim-check-and-gather)). The worker splits a submission when all of these hold: Q7 says `oneClaim` is false, `claims` holds 2 or more entries, the support is not `belief`, and the request has no `parent_id` (it is not itself a child). The split is one write transaction, the same one that writes the `changes` row of the parent: the row has the outcome `split` and no facts, and one `change_requests` row per claim is inserted with kind `submission`, status `queued`, `change` = the claim, and the `justification`, `targets`, `prior_query` of the parent and `parent_id` = the parent id. So a crash cannot leave a parent split with no children. A crash between this commit and the `done` write puts the parent back to `queued`, and the parent runs again: step 1 finds its `split` change row before the Q7 call, ends the request as `done` with the outcome `split` and its existing children, and writes and queues nothing, so the children are never made twice. The parent ends `done` with no `error`. A split costs no gather, no judgment and no embedding of facts; each child is a whole run of the pipeline.

A child never splits: a child that Q7 finds not to be one claim ends as `rejected` with the reason `compound`, as any compound submission did before the split. A split with a belief is not made; the request ends as `rejected` with the reason `unsupported`. A not-one-claim answer with fewer than 2 claims (a pronoun with no antecedent, half of a claim) ends as `rejected` with the reason `compound`.

## Tests

Design: [How the feature is measured](../design/submit.md#how-the-feature-is-measured). The command `npm run eval:all` runs this test with the others ([System evaluation](evaluation.md)).

| Test | Requirement | Method | Pass condition |
|---|---|---|---|
| Correction | Quality rises with use | `eval/corrections.ts` seeds 50 facts, 10 wrong. Runs an agent on 20 tasks that touch the wrong facts. Counts `requestChange` calls and accepted corrections. | Reported. Sets the weights in [Scores](lookup.md#scores) and the cap in [O7](README.md#open-settings). |
