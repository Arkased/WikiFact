# Process submissions

Technical layer. The requirements are in [../requirements/updates.md](../requirements/updates.md). The design is in [../design/updates.md](../design/updates.md).

## Store API reads for the update agent

The update agent reads through the Store API, not through the consumer tools, and none of its reads records a retrieval. Its reads differ from the consumer tools in these ways:

| Function | Difference |
|---|---|
| `search` | `includeHistory: true`. Returns `agentSearchCap` results, default 20, each with `factId`, `factVersionId`, `seq`, `isDeleted`. No relevance floor ([Retrieval pipeline](lookup.md#retrieval-pipeline), step 7): gather wants the near misses, because a candidate that the floor would drop is what Q1 and Q4 are there to judge. |
| `getFact` | Returns `factVersions: FactVersion[]`, newest first. |
| `getDependents` | Input `{ factId }`. Output: the ids, sorted, of the live facts whose current fact version references `factId`. The caller loads the material. |
| `cleanupCandidates` | Input: the limits of [Cleanup](cleanup.md). Output: the candidates of each finder of [Cleanup](cleanup.md), in finder order, at most the cap for each finder, without the candidates that `cleanup_verdicts` still covers, and the finders that their cap cut. Code only, no model call. |


## Queue and worker

- `requestChange` inserts a `change_requests` row with status `queued` and kind `submission`. The pipeline itself inserts rows of kind `lookupRepair` (step 9 of [Pipeline](updates.md#pipeline)). A `lookupRepair` row runs step 1, Q10, and steps 6, 8 and 9 (step 9 of [Pipeline](updates.md#pipeline)). The operator console inserts rows of kind `operatorEdit` ([The operatorEdit request](console.md#the-operatoredit-request)): the `change` column holds a JSON document that names a reindex or a cleanup run, and `justification` is NULL. A cleanup run runs the finder of [Cleanup](cleanup.md) at once. The worker runs an `operatorEdit` row in queue order with no model question: it builds the change set in code, or ends it as `rejected` with the reason `unsupported` and the validation message when the document is not one it can do. A reindex job runs `reindex` and writes no `changes` row. The cleanup inserts rows of kind `cleanupRepair` ([Cleanup](cleanup.md)): the `change` column holds a JSON document with the finder `duplicateFact` and the 2 fact ids of the candidate, and `justification` is NULL. The worker runs it in queue order with at most one question, Q1 (then Q2 and Q3 of the merge), as [Cleanup](cleanup.md) says; a document of another finder ends it as `rejected` with the reason `unsupported`, with no write.
- The worker takes the first `queued` row in queue order, sets it to `running`, runs the pipeline, commits the result ([Write transaction](updates.md#write-transaction)), and sets the row to `done`. It handles one request at a time, so every change sees every change before it. The queue order is by kind, then by arrival (`received_at`, then rowid): the `operatorEdit` rows, then the `submission` and `lookupRepair` rows, then the `cleanupRepair` rows ([Free for submissions](../design/cleanup.md#free-for-submissions)). The cleanup step between 2 requests runs the queued cleanup repairs apart from this order ([Cleanup](cleanup.md)), so a submission waits for the repairs of at most 1 run of a check. A cleanup repair loads its candidate again and skips a stale one, so it may run after later submissions. `requestChange` returns the place of the new row in this order: the queued operator edits and submissions before it and itself, with no cleanup repair. The `done` write is separate from the commit, because step 9 runs between them on the committed state. A crash between the commit and the `done` write repeats the request. The repeat finds its own fact, writes one confirm row, and runs step 9 again. That is the accepted cost. A repeat of a split request finds its `split` change row in step 1, writes nothing and queues no new child ([Split of a compound submission](submit.md#split-of-a-compound-submission)).
- On an API or model error, the worker increments `attempts` and sets the row back to `queued`. After 3 attempts the row becomes `failed`, with the error text. After a failed attempt the worker waits `attempts * 10` seconds before it polls again, so an API outage does not burn the 3 attempts in seconds. A model call that fails with a rate limit (`CallFailureKind.RateLimit`, [Model call failures](updates.md#model-call-failures)) is no attempt: the row goes back to `queued` with `attempts` unchanged (`releaseRequest`), and the worker pauses instead of waiting `attempts * 10` seconds. A fault in the submission itself is not an attempt failure: a submission that Q7 rejects at step 1 ([Pipeline](updates.md#pipeline)) ends the request as `done` with the outcome `rejected`, the reason `compound` or `unsupported`, and Q7's reason as the row's `error`, on the first attempt. A compound submission that Q7 splits ends as `done` with the outcome `split`, and the claims are queued as child `submission` rows with a `parent_id` ([Split of a compound submission](submit.md#split-of-a-compound-submission)); each child is taken in queue order like any row. A draft that fails the code lint twice (step 6) is an attempt failure. A failure that no new model answer can change is not retried: when the pipeline throws an `InvariantError` (a fact with no version, a dependent with no material: a fault of the store or of the code, never of a model answer), `runOnce` ends the row as `failed` at its first attempt (`failRequest`, `attempts` plus 1, the error text kept) and logs `attempt_failed` at level `error`. An invalid answer, a failed lint, a timeout and a refusal stay attempt failures, because the next attempt asks the model again. A check of a model answer in the pipeline (a question that returned no draft, an accepted judgment with no target) throws a plain `Error` through `mustFromModel` of `src/must.ts`, so it stays an attempt failure.
- A failure inside step 9, after the commit, is logged and the request finishes as `done`. A repeat would write a second confirm row. The repair is lost for that request.
- On restart, rows in `running` go back to `queued`. A run that did not commit left no trace in the wiki. A run that committed a merge ([Step 3. Merge](updates.md#step-3-merge)) and then stopped left a repaired wiki, and the re-run skips the merge.
- The lock file holds the pid of the worker. A lock whose process is gone is removed and taken again. A live pid blocks the second worker.
- The worker status lives in the `meta` table under one key, `worker_status`, as JSON: `{ pid, startedAt, lastPollAt, lastCall: { ok, kind?, message?, at }, consecutiveFailures }`. The worker writes it at start, after every poll, and after every model call. `kind` is `credential` for a 401 or a login error of the CLI, `rate_limit` for a 429, else `other`. A successful call resets `consecutiveFailures`; a rate-limited call records `lastCall` but does not raise it. While the worker pauses the status also holds `state: "paused"`, `pausedUntil` (ms since the epoch) and `pauseReason: "rate limit"`; the worker removes the three fields when the pause ends (a running worker has no `state`). The heartbeat keeps `lastPollAt` fresh during the pause, so a paused worker is alive. A batch whose promotion failed sets `lastBatchError: { message, at }` (the message cut to 300 characters); it is its own event, no model call, so `lastCall` and `consecutiveFailures` stay. A batch that ends clears it (also when every request of it failed an attempt), and so does the end of the 1-at-a-time run that follows a dropped batch (the last step taken, or an idle poll). The MCP server reads it for the `warning` of `requestChange` ([requestChange](submit.md#requestchange)) and does not write it.
- The operator pause of the queue ([The pause of the queue](../design/console.md#the-pause-of-the-queue)) lives in the `meta` table under the key `queue_pause`, as JSON: `{ at, note }` (`at` in ms since the epoch, `note` the reason of the operator, 1 to 500 characters). No key means that the queue runs. Only the console writes the key (`setQueuePause`, `clearQueuePause` in `src/store/`); the worker and the MCP server read it (`readQueuePause`). The worker reads the key at the top of each loop, before `runOnce`. With the key, the worker calls no `runOnce`, runs no cleanup trigger, writes the status with `state: "paused"`, `pauseReason: "operator"` and `pausedSince` (the `at` of the key) and no `pausedUntil`, and sleeps the poll interval. The status keeps `lastPollAt` fresh, so a paused worker is alive. Without the key, a worker whose status says `pauseReason: "operator"` removes the pause fields, as at the end of a rate limit pause. A request that runs when the key appears finishes first. A rate limit pause that runs when the key appears ends on its timer, and then the operator pause holds. The worker logs `queue_pause` (level `info`, with the note) at the first loop that sees the key, and `queue_resume` (level `info`) at the first loop that sees no key after a pause.

## Model call rows

Design: [Known cost](../design/updates.md#known-cost). The table is `model_calls` ([Tables](storage.md#tables)).

- The worker writes 1 `model_calls` row for each model call. The question caller (`src/updates/questions/call.ts`) writes it through the store, right after the call returns.
- The worker command opens a connection of its own for these rows and passes it to `createQuestions` as `store`; the evals pass none and write no row.
- The row is in its own small transaction. It is not in the write transaction of [Write transaction](updates.md#write-transaction), because a failed attempt costs tokens too, and a rolled back write would lose them. A call that fails after the transport returned its usage also writes its row.
- A call for a child of a split that exists only in the staging set of a batch ([High volume mode](#high-volume-mode)) writes its row under the live parent of the child: `request_id` is the `parent_id` of the child in `stg_change_requests`. `model_calls.request_id` refers to the live `change_requests`, and the staged child is not there. So the cost of a staged child counts on its parent, and a dropped batch keeps the rows of the calls that it paid for. A child that runs after the promotion is live, and its calls write rows under its own id.
- The row holds the request id, the question name, the model, the effort, the 4 token counts (`input`, `output`, `cacheRead` and `cacheWrite` of the usage that the transport returns, in `tokens_in`, `tokens_out`, `tokens_cache_read` and `tokens_cache_write`), the duration of the call in ms and the time.
- A call that fails before the transport returns a usage writes no row.
- `modelCallTotals(store, sinceAt)` sums the rows from a time on, by model and question (the calls and the 4 token counts); the test of both paths ([High volume mode](#high-volume-mode)) reads it.
- The console sums the 4 counts as 1 number for each request. The split by kind is for the request page only ([Cost](../design/console.md#cost)).
- The `change` log line keeps its `tokens` field ([Logging](deployment.md#logging)).
- The table grows with each model call. It has no bound. The bound is a future feature, as for the search log ([Cost](lookup.md#cost)).

## Pipeline

Each question is one model call with a fixed prompt, only the material for that question, and structured output through `output_config.format`. No question has a tool. Every question answers from the material that the code assembled, so the same material gives the same answer, and the replay test can pin it down. When the replay test shows that gather missed a fact that Q4 needed, widen gather with `agentSearchCap` in `wikifact.json`. The model and the effort for each question come from `wikifact.json` ([O6](README.md#open-settings)).

The 10 questions, in pipeline order. Each belongs to one step, with its own prompt, input and output. No question serves 2 steps.

| Question | Asks | Kind | Step |
|---|---|---|---|
| Q1 | Which candidates share the claim's scope. | Classification | 2 |
| Q2 | Of 2 live facts in one scope, which content stands. | Judgment, strong model | 3 |
| Q3 | Write the merged version. | Drafting | 3 |
| Q4 | Is the claim supported, and how does it relate to the existing fact in its scope. | Judgment, strong model | 4 |
| Q5 | Write the claim's fact version. | Drafting | 5 |
| Q6 | Write a related fact without the part the claim showed wrong. | Drafting | 5 |
| Q7 | Is this submission one claim that a reader can act on alone, and what kind of support is its justification. | Classification | 1 |
| Q8 | Does this dependent still hold. | Classification | 7 |
| Q9 | Write the dependent under the changed facts. | Drafting | 7 |
| Q10 | Write what makes the prior query return the fact. | Drafting | 9, in the repair request |

Every question takes a second argument, `ctx: { subject }`, from `Gathered`, so the input types below stay as they are. Every drafting question gets the fact style from [Fact](../design/data-model.md#fact) and the `subject` from `ctx` in its prompt. It returns `drafts: FactDraft[]` without `factId` or `justification`, and no other field. Every drafting question returns exactly 1, and another count fails the call. It never decides whether to write, and it never writes a justification. The step sets the justification, because the submission is the only evidence that enters the wiki, and a model's rewording replaces evidence with inference. A drafting question also takes an optional `lintFailure: string`, the reason from step 6 on a retry.

The pipeline is a chain of 9 steps. Each step takes the output of the step before it. Step 3 runs only when step 2 finds 2 or more live facts in the scope, and commits at once. Step 9 runs after the commit and may queue a second request. The input to step 1 is the request:

```ts
type Request = { id: string; change: string; targets: string[]; justification: string; searchId?: string };  // `searchId`: the search this change follows (schema 10); its `query` is the prior query of the lookup repair
```

### Step 1. Claim check and gather

A check that depends on no other step runs first, before any expensive step. The submission check is the first model call of a submission: Q7 reads the `change` and the `justification` and answers 3 things that need no context from the wiki: whether the change is one claim that a reader can act on alone, what kind of support the justification gives, and, for a change of 2 claims or more, the list of the claims, each written to stand alone. The answer gives its `reason` before `oneClaim`, so that the verdict follows from the reason ([One claim, No beliefs](../design/submit.md#one-claim-no-beliefs)). A compound submission with 2 claims or more and a support that is not a belief is split here ([Split of a compound submission](submit.md#split-of-a-compound-submission)): the request ends as `done` with the change outcome `split`, and one child submission per claim is queued with the parent's justification, targets and prior query. A child is never split: a child that is still compound ends here as `rejected` with the reject reason `compound`. A change that is not one claim and holds fewer than 2 claims ends here as `rejected` with the reason `compound`. A justification that is a belief or an inference ends here as `rejected` with the reason `unsupported`, whatever the claims. Hearsay is a `report` and continues: Q4 weighs it against the wiki. In both rejections Q7's reason is the request's `error`, and nothing else runs. The consumer reads the reason through `getRequest` and resubmits. A split needs no resubmit. A `lookupRepair` request has no claim and skips the check. Q4 keeps the judgments that need the wiki: whether an observation supports this claim against the existing fact, and whether a fact with a stronger justification contradicts it. The first wiki showed the cost of a late check: a compound submission ran gather, Q1, Q4 and Q5 and 2 lint retries, 3 times over, before it failed.

Q7 input:

```ts
{ change: string; justification: string }
```

Q7 output:

```ts
{
  reason: string;                                     // first, so that the verdict follows from it
  oneClaim: boolean;                                  // false: 2 claims, or a claim no reader can act on alone
  claims: string[];                                   // oneClaim false because of 2 claims or more: each claim, written to stand alone; else empty
  support: "observation" | "report" | "belief";       // first-hand and repeatable; second-hand; inference or opinion
}
```

`belief` rejects. `observation` and `report` continue, and Q4 weighs them against the existing fact. `claims` holds the claims of a compound change, each with its subject, its condition and its value, so that a reader can act on it alone; it is empty when `oneClaim` is true and when the change cannot be acted on for another reason. The worker splits on `claims` with 2 entries or more.

The code collects everything the model questions will need, so that no question has to look anything up. A change request names a claim in free text, and the wiki may already hold a fact about the same thing, a fact that disagrees, or a deleted fact that said the same thing. Gather finds all 3 kinds, with their full version history, so Q1 can match the scope and Q4 can judge the claim against the past.

Gather builds 2 lists of facts from 2 sources:

1. **Targets.** The submitter may name fact ids. Each fact id loads that fact. An id that does not exist is dropped, with a log line (`droppedTarget`).
2. **Candidates.** The agent `search` with history ([Store API reads for the update agent](updates.md#store-api-reads-for-the-update-agent)) runs on the `change` text and returns `agentSearchCap` fact versions. The claim is the only text that says what the request is about, so this search finds the facts the claim could touch: the fact in the same scope, facts that disagree, and facts a new version will rest on. FTS5 catches exact names and numbers, and the vector half catches the same thing in other words. The hits collapse to one entry per fact. The code then computes the cosine distance between the embedded `change` text and the nearest version of each fact, and orders the list nearest first. The distance orders the list and nothing else. No model reads it.

Every fact loads with every version, newest first. The agent text, `changeReasoning` and `summary`, is removed (evidence rule):

```ts
type FactMaterial = {
  factId: string;
  isDeleted: boolean;
  versions: Array<{
    seq: number;
    header: string;
    content: string;
    justification: string;
    references: string[];
    isDeleted: boolean;
    created: number;
  }>;
};
```

Gather also loads the subject sentence of the wiki. Every question gets the subject sentence alone in its `<wiki>` block, which is the cached block (#61).

Input: `Request`. Output:

```ts
type Gathered = {
  subject: string;                              // from wikifact.json
  targetFacts: FactMaterial[];                  // targets that are fact ids
  candidates: Array<{ fact: FactMaterial; distance: number }>;   // nearest first
};
```

### Step 2. Scope match

Q1 answers one question: which of the candidates are about the same thing as the claim? A fact's header is its scope, and one scope holds one fact ([Fact](../design/data-model.md#fact)). So a claim in the same scope as a live fact is a correction or a duplicate of that fact, never a new fact. Q1 reads the `change` text and the header of each candidate, and returns the ids of the candidates whose scope is the claim's scope. It does not read content, and it does not decide whether the claim is right.

Q1 input. The candidates are `Gathered.candidates`, nearest first, with `Gathered.targetFacts` added at the front, so a fact the submitter named by id is matched even when the search missed it:

```ts
{ change: string; candidates: Array<{ factId: string; header: string }> }
```

Q1 output:

```ts
{ matches: string[] }         // the ids of the candidates whose scope is the claim's scope
```

When gather finds no facts, Q1 is not called. A Q1 id that is not in the candidate list is dropped with a log line.

The count of live facts among the matches decides what comes next. Zero means the claim is new. One means the claim corrects or repeats that fact. Two or more means the wiki holds duplicates (F1), and step 3 merges them before step 4 judges the claim.

Input: `Request`, `Gathered`. Output:

```ts
type Scope = {
  matches: FactMaterial[];      // the Q1 ids, live and deleted
};
```

### Step 3. Merge

This step runs only when `matches` holds 2 or more live facts. The wiki holds 2 or more live facts in one scope, which the data model forbids: one scope, one fact. Q1 missed the match when the second one was written (F1). The claim cannot be judged against 2 facts, so the merge comes first.

The duplicates were written at different times from different submissions, so they often disagree. "Creeper damage: 10" is live, a later submitter observed 12, Q1 did not match "Creeper explosion damage" to "Creeper damage", and the wiki holds 10 and 12 in one scope. The second fact is a correction that Q1 mis-filed, so someone must decide which value stands, with the justifications of both.

The code picks the fact to keep: the one with the most versions, and the oldest on a tie. For each other live fact, Q2 decides whether its content or the kept fact's content stands. With 3 or more live facts, the content that stands meets each other fact in turn, and Q3 gets the content that stands at the end.

Q2 input:

```ts
{ kept: FactMaterial; other: FactMaterial }
```

Q2 output:

```ts
{ stands: "kept" | "other" | "unrelated"; reason: string }
```

Q2 weighs the justifications of the 2 current versions as observations of reality, the same way step 4 weighs a claim. When the contents say the same thing, `kept` stands and the call is cheap.

Q2 answers `unrelated` when the 2 contents are about another subject or attribute, so both can be true together: Q1 over-matched a sibling scope (F24). Q1 reads headers only, and Q2 is the first question that reads both contents. The other fact then leaves the merge: it stays live and unchanged, and the code logs `scope_overmatch` with both ids. When every other fact is `unrelated`, no merge runs and the step writes nothing. On the path of 1 request at a time, the unrelated facts also leave the scope of the claim, and step 4 judges the claim against the kept fact. Why: the duplicate fact finder of the cleanup merged 9 pairs on the `wikifact` wiki on 2026-10-21, and 4 of the 9 were sibling scopes. Each of the 4 merges deleted a true fact, for example "VEC_CANDIDATES 200 recall at 100k facts" into "VEC_CANDIDATES recall at 100k facts" ([research note](../research/duplicate-fact-run-2026-10-21.md), #31).

Q3 then drafts the merged version of the kept fact: the content that stands, and the union of the references.

Q3 input:

```ts
{ kept: FactMaterial; others: FactMaterial[]; content: string; lintFailure?: string }
```

Q3 output: one `FactDraft` for the kept fact, without `justification`.

The code sets the justification: the justification of each merged fact's current version, as it was, one after the other. The code sets `references` to the union of the live references of the merged facts, without the merged ids. The code drafts a deletion of each other fact, with no references ([References](../design/data-model.md#references)). A deletion carries the `header` and `content` of the prior version and its justification.

The dependents of each deleted fact get a maintenance write in the same change: the code drafts a new version with the deleted id replaced by the kept id in `references`, and header, content and justification carried over. No model reads it, and it does not reset confidence ([Confidence](lookup.md#confidence)). So the merge does not run step 7, and no dependent is left on a deleted fact.

The retrieval history of the deleted facts stays on them. It is not moved to the kept fact, because confidence counts events on one content version, and the merged version is new content.

The merge is not the submitter's request. It is a repair that the pipeline made on the way, so it is its own change: the drafts go through lint (step 6) and the write transaction ([Write transaction](updates.md#write-transaction)) at once, as a `changes` row with `outcome: "accepted"`, its own summary, and the same `request_id`. Then the pipeline continues. A crash after this commit leaves a repaired wiki, and the re-run finds one live fact in the scope and skips this step.

Input: the live facts in `Scope.matches`. Output: one committed `seq`, and `Scope` with `matches` cut to the kept fact, read again from the store, and the deleted matches.

### Step 4. Judge

Q4 is the judgment of the claim. It reads the claim and its justification, the existing fact in the claim's scope with its history, if there is one, and the other gathered facts. It decides 3 things and writes nothing.

The code picks the existing fact from `Scope.matches`. When a live match exists, it is that one, and the deleted matches are dropped: they were replaced by it or merged into it. When no live match exists and Q1 matched deleted facts, it is the most recently deleted one. Its deletion justification is evidence against the claim, and Q4 weighs it.

1. **Is the claim supported?** The justification is an observation of reality. Q4 weighs it against the justifications of the facts that disagree. A claim with no justification worth acting on is not supported, reason `unsupported`. A claim that a stronger justification contradicts is not supported, reason `contradicted`. When the existing fact is deleted, its deletion justification is one of the justifications that Q4 weighs. A claim that restates a deleted fact with an observation weaker than the deletion justification is still supported, because it is an observation. It is not restored: see `stale` below. A claim with no observation worth acting on stays `unsupported`.
2. **How does the claim relate to the existing fact?** Asked only when there is one. `same` when the claim says the same thing as the fact's content. `different` when the claim gives a different value for the same scope. `negates` when the existing fact is live, and the claim says that it is no longer true and gives no new content for its subject ("Torches can no longer be crafted"). A claim that also gives new content is `different`: it is a correction. `stale` when the existing fact is deleted, the claim restates it, and its observation is weaker than the deletion justification. An observation at least as strong restores the claim: `same` or `different`, as before.
3. **Which related facts does the claim show to be wrong, and what happens to each?** A supported claim can contradict a gathered fact in another scope. Q4 lists them, with one of 2 actions. `delete` when the whole fact is shown wrong: "No hostile mob does more than 8 damage" against an observation of 12. Nobody measured a new cap, so the fact goes. `narrow` when part of the fact is shown wrong and the rest stands on its own observation: "Creepers and zombies do 10 damage" against an observation of 12 on creepers. The zombie part stays. A fact that was derived from the existing fact, "A creeper takes 2 hits to kill a player", is not wrong related. It is a dependent, and step 7 reaches it through `references`. The Q4 prompt states all 3 cases.

Q4 input:

```ts
{
  change: string;
  justification: string;
  existing?: FactMaterial;        // the fact that already holds this scope, if any
  related: FactMaterial[];        // the targets and the candidates that Q1 did not match, with no fact twice
}
```

Q4 output:

```ts
{
  supported: boolean;
  rejectReason?: "unsupported" | "contradicted" | "compound";   // required when not supported
  relation?: "same" | "different" | "unrelated" | "negates" | "stale";   // required when `existing` is present, absent otherwise
  wrongRelated: Array<{           // facts in `related` that the claim contradicts
    factId: string;
    action: "delete" | "narrow";
  }>;
  reason: string;                 // one paragraph; becomes `changeReasoning`
}
```

The code maps the answer to the outcome and the write targets:

| `supported` | `existing` | `relation` | Outcome | Targets |
|---|---|---|---|---|
| false | any | any | `rejected` | None. |
| true | none | absent | `accepted` | A new fact. |
| true | live | `same` | `duplicate` | None. A confirm row on the fact. |
| true | deleted | `same` | `accepted` | A new live version of the fact. A restated deleted fact is never a duplicate. |
| true | live or deleted | `different` | `accepted` | A new version of the fact. |
| true | live or deleted | `unrelated` | `accepted` | A new fact. The `existing` fact is not the scope of the claim: Q1 over-matched a sibling (F24). The code logs `scope_overmatch` with both ids and treats the claim as if Q1 had found nothing. |
| true | live | `negates` | `accepted` | A deletion of the fact. No fact is written for the negated claim, so stale facts do not build up. |
| true | deleted | `stale` | `accepted` | A new live version of the fact, with the content negated (step 5). The next consumer finds the answer. |
| true | deleted | `negates` | `duplicate` | None. `duplicateOf` is the deleted fact. No confirm row, because a deleted fact never gets a confirm. |

A consumer sends a deletion as any other submission. The worker finds it because the claim negates the existing fact and gives no new content. Two answers write nothing. A claim that a stronger observation contradicts is `rejected` with `contradicted`. `negates` on a deleted fact agrees with the wiki, which already says it, so it is a `duplicate` of the deletion: `duplicateOf` is the deleted fact and no confirm row is written. `stale` on a live fact fails the attempt, like any other invalid answer. `rejected` is only for a request that writes nothing.

`unrelated` is Q4's check on Q1. Q1 sees headers only, and 2 facts about sibling subjects ("the full log keeps 5 files", "the errors log keeps 10 files") read as one scope at that distance. Q4 sees the full material and says so. Without it, a correction lands on the wrong fact and the old content survives as a version only.

Every entry in `wrongRelated` is one more target when the outcome is `accepted`.

Input: `Request`, `Gathered`, `Scope`. Output:

```ts
type Judgment = {
  outcome: "accepted" | "duplicate" | "rejected";
  rejectReason?: "unsupported" | "contradicted";  // required when rejected
  duplicateOf?: string;                           // required when duplicate
  changeReasoning: string;      // the Q4 reason
  targets: Array<{
    kind: "claim" | "negate" | "delete" | "narrow";
    factId?: string;            // absent: a new fact
  }>;
};
```

A `rejected` or `duplicate` judgment has no targets, and the pipeline skips to step 8 with an empty change set. A `negates` answer gives a `delete` target on the existing fact and no `claim` target. A `stale` answer gives a `negate` target on the deleted fact. With `negates`, a `narrow` entry of `wrongRelated` is dropped with a log line, because there is no claim draft to narrow against.

Q4 may answer `supported: false` with `rejectReason: "compound"` for a claim that joins 2 claims. The step maps it to a rejection with the reason `compound`, as step 1 does ([research](../research/failed-requests-2026-10-19.md): 8 requests failed attempts on this answer, 3 ended `failed`). The code guards what the schema cannot: `supported: false` without a valid `rejectReason`, or an `existing` fact without `relation`, fails the attempt. A `wrongRelated` entry that names an unknown, deleted or repeated fact is dropped with a log line.

### Step 5. Draft

This step writes one fact version per target. The `claim` target goes to Q5. The `negate` target goes to Q5 with `negate: true`: Q5 keeps the header of the deleted fact and writes one sentence that says its claim is no longer true. It adds no value that the claim does not state. The version is live, and the justification is the submitter's, as sent. A deletion by negation (the `delete` target of the existing fact, with no `claim` target) calls no Q5. Each `narrow` target goes to Q6. Each `delete` target is written by code. The code sets every justification and assembles the change set.

Q5 input, the claim's fact:

```ts
{
  change: string;
  justification: string;
  existing?: FactMaterial;        // the target fact, when the target is a new version of it
  related: FactMaterial[];        // for references
  negate?: boolean;               // true: `existing` is deleted, and the draft says its claim is no longer true
  lintFailure?: string;
}
```

Q5 output: one `FactDraft` without `justification`. When `existing` is present, the draft keeps its prior `references` and returns the full list. The code sets the justification: the submitter's `justification`, as sent.

Q6 input, one call per `narrow` target:

```ts
{
  wrong: FactMaterial;            // the related fact the claim showed partly wrong
  claim: FactDraft;               // the Q5 draft
  lintFailure?: string;
}
```

Q6 output: one `FactDraft` for `wrong`, without `justification`, with the broken part removed. The draft keeps the prior `references` and adds the claim's fact. The code sets the justification: the wrong fact's current justification, as it was. Its observation still covers the part that remains, and the reference to the claim's fact explains the removal.

A `delete` target is a `FactDraft` with `isDeleted: true`, written by code. It carries the `header` and `content` of the prior version, the submitter's `justification` as sent, since that observation is what showed the fact wrong, and no references ([References](../design/data-model.md#references)).

A new fact gets its ULID from the pipeline before the drafts are written, so the `delete` and `narrow` drafts can reference it. A `factId` that does not exist creates the fact with that id at write time.

Input: `Judgment`, `Request`, `Gathered`, `Scope`. Output:

```ts
type ChangeSet = {
  outcome: "accepted" | "duplicate" | "rejected";
  rejectReason?: "unsupported" | "contradicted";  // required when rejected
  duplicateOf?: string;                           // required when duplicate
  summary: string;              // one line, written by code from the outcome and the targets
  changeReasoning: string;      // the Q4 reason; stored on each new fact version
  facts: FactDraft[];
};

type FactDraft = {
  factId?: string;              // a new fact carries a ULID that the pipeline assigned; absent only when nothing references it
  header: string;
  content: string;
  justification: string;        // set by the step, never by a model
  references: string[];         // ids of the facts this version depends on
  isDeleted?: boolean;
};
```

### Step 6. Lint

Lint catches the mechanical kind of bad draft before anything is written: a missing field, a reference to a fact that does not exist. It is code, no model call. The compound kind, 2 claims in one fact (F2), is caught at step 1 on the submission itself, so no draft of a compound claim reaches this step.

The code checks:

- Every field is present.
- Every reference id is a live fact or a fact drafted in this change set.

A failure goes back to the question that wrote the draft, as its `lintFailure` field. That happens once per draft. A second failure fails the attempt (F22): a draft that misses a field twice is a model fault, and the next attempt may pass.

The pipeline does not split a fact. A compound submission is split at step 1, and a compound fact that a single claim still produced is the job of a future fact finder of the cleanup ([Cleanup](cleanup.md)).

Input: `ChangeSet`, the set of live fact ids. Output: the `ChangeSet`, with any redrafted facts.

### Step 7. Dependents

A fact can rest on other facts: "A charged creeper kills an unarmored player in one hit" rests on "Creepers do 10 damage" and "Players have 20 health". When a base fact changes, the dependent may be wrong now. This step finds every fact that rests on a changed fact, asks Q8 whether each one still holds, and has Q9 rewrite the ones that do not. The loop follows the reference graph to any depth, and visits each fact one time. [Dependents loop](updates.md#dependents-loop) gives the loop and both questions.

Input: `ChangeSet`. Output: the `ChangeSet`, with the rewritten dependents added to `facts`.

### Step 8. Write

The code writes the whole change set in one transaction: the `changes` row, the new fact versions, their references, and the index rows. [Write transaction](updates.md#write-transaction) gives the steps.

Input: `Request.id`, `ChangeSet`. Output: one `seq`.

### Step 9. Prior query check

The submitter ran a search, did not find the fact, and acted on reality. `Request.searchId` names that search, and the prior query is the `query` of its `searches` row (a request with no `searchId` has no prior query and skips this step). After the commit, the wiki must return the relevant fact for that search, or the next consumer with the same words misses it again. This step makes sure of that.

In a batch the step does not run inside the request: the promotion queues it as a lookupRepair request ([High volume mode](#high-volume-mode)).

The relevant fact is `duplicateOf` for a duplicate of a live fact, and the `claim` target's fact for an accepted change. A rejection and a duplicate of a deletion have no relevant fact, because no live search returns a deleted fact, so the check does not run.

1. Run the consumer `search` for the prior query against the committed state, as a consumer does, with `searchCap` and live facts only. This search writes no `searches` row: it is the worker's, not a consumer's.
2. If the relevant fact is in the results, stop. After a repair, the equivalence fact written by Q10 also counts as a hit.
3. If not, and the request is a `submission`, enqueue a repair request with `kind: 'lookupRepair'`, the relevant fact as its one target, and the same `searchId`.
4. If not, and the request is itself a `lookupRepair`, log it and stop, so a search that no fact can satisfy does not loop.

A `lookupRepair` request runs step 1, then Q10, then steps 6, 8 and 9. The wiki may have changed since the request was queued. When the search already returns the target, or the target is gone or deleted, the request finishes with no write. The search `priorQuery` does not return the target fact, so the wiki's words and the submitter's words differ. Q10 writes what makes the search return it: an equivalence fact, "skellies are skeletons", so that the search finds the equivalence and, through its reference, the target.

Q10 input:

```ts
{
  priorQuery: string;   // the `query` of the search that `Request.searchId` names
  target: FactMaterial;
  results: Array<{ id: string; header: string }>;   // what the search returns now
  lintFailure?: string;
}
```

Q10 output: one `FactDraft` for the equivalence fact, without `justification`, with `target` in `references`. The code sets the justification: empty. The equivalence fact is derived, and its evidence sits on the target fact.

Input: the `query` of the search of `Request.searchId`, `ChangeSet`. Output: none, or one queued request.

### Call settings

Call settings, every question: adaptive thinking, server-side fallback on refusal (`betas: ["server-side-fallback-2026-07-01"]`, `fallbacks: "default"`), the fixed prompt under one cache breakpoint. **The cached prefix** (requirement "Cache use") (#16): a spec renders the block of the wiki (`renderSubject`, the subject alone, for every question) apart from the input of the call, and the transport puts that block in the cached prefix, after the fixed prompt and before the user message. The Anthropic transport sends it as a second system block with its own cache breakpoint, so a call reads the fixed prompt and the block from the cache when a call of the same question wrote them in the last 5 minutes. The CLI transport appends the block to the system prompt, and passes the prompt in a file (`--system-prompt-file`, in the temp folder of the call), because the block of a real wiki (about 120,000 characters) is longer than the 32,767 characters of a Windows command line. The user message holds only the input of the call. `claude -p` also writes the user message to the cache, and no later call reads it, because each call is a new session; no option of the CLI removes that write (#79). The CLI transport sets `FORCE_PROMPT_CACHING_5M=1` in the environment of the child, so the writes use the 5-minute cache at 1.25 times the input price, not the 1-hour cache at 2 times that `claude -p` takes with the Claude Code login. The block changes only when the subject changes. Classification questions: `max_tokens` 4096. Judgment and drafting questions: streaming, `max_tokens` 16000. Every API call has a wall-clock timeout, `questionTimeout` in `wikifact.json`, default 120 seconds, so a question with its one retry takes at most twice that. A timeout fails the attempt ([Queue and worker](updates.md#queue-and-worker)). The code validates every output against its schema and retries the call once with the validation error. A second invalid output fails the attempt. Thinking counts toward `max_tokens`, so an answer cut at the limit fails the attempt in the same way.

Haiku 4.5 takes no adaptive thinking, no effort and no fallback, so a question on Haiku sends none of them, and a refusal on Haiku fails the attempt at once. The `"default"` fallback on Sonnet 5.5 covers only part of the decline kinds, and the other kinds end as F19.

### Evidence rule

The material that the judgment questions, Q2 and Q4, receive holds 2 kinds of text, and their prompts tell the model how to weigh each kind.

- A submitter's justification on a fact version is an observation of reality, stored as sent. It counts as evidence. A version with an empty justification was derived by the pipeline from the facts it references, and the evidence sits on those.
- The `summary` on a change and the `changeReasoning` on a fact version are agent text. They record a past decision and its reason. They are not evidence about reality, so the code removes them from the material before the call.

Every submission is judged alone. A rejected claim leaves a `change_requests` row and a `changes` row and nothing else. The pipeline does not look for a past submission of the same claim, so a repeat of a rejected claim is judged on its own justification. A repeat with the same justification gets the same result. Detection of repeats is a future feature ([future.md](../future.md)).

## Dependents loop

The loop runs before the write, on the draft change set. Nothing is committed until the loop ends. The visited set starts with the fact ids in the change set.

1. Collect `getDependents` for each fact id added to the change set in the last pass. `getDependents` reads the committed state. A new fact has no dependents. Remove the ids in the visited set. Stop when the set is empty.
2. For each dependent, call Q8 one time. Q8 classifies. It does not draft.
3. For each dependent that does not hold, call Q9.
4. Lint the drafts (step 6 of [Pipeline](updates.md#pipeline)). A failure sends the reason back to Q9 once. Add the drafts to `facts` in the change set. Add their fact ids to the visited set.
5. Repeat from step 1.

The visited set stops a cycle in the reference graph. There is no depth limit, so every fact that rests on a changed fact is re-judged once. A dependent that holds is not in the visited set, so a later pass can judge it again against more changed facts. A draft whose header, content and `is_deleted` equal the committed version, such as the F8 draft, goes into the visited set and does not collect its own dependents, because nothing changed for them. The log line for the request holds the number of passes and of facts re-judged.

### Q8: does the dependent still hold

One call per dependent, with every changed fact that the dependent references, so the answer does not depend on call order.

Input:

```ts
{
  dependent: { factId: string; header: string; content: string; justification: string };
  changed: Array<{             // every fact in the change set that `dependent` references
    factId: string;
    before: { header: string; content: string };
    after:  { header: string; content: string; isDeleted: boolean };
  }>;
  unchanged: Array<{           // the other facts that `dependent` references
    factId: string; header: string; content: string;
  }>;
}
```

Output:

```ts
{
  holds: boolean;              // the content of `dependent` is still true under `after`
  stillDepends: string[];      // the ids in `changed` that `dependent` still rests on
  reason: string;              // one sentence
}
```

The decision rule in the Q8 prompt: a dependent holds when its content is true under the new content of every changed fact. A dependent whose justification names an old value, and whose content stays true, holds. A dependent depends on a changed fact when its content was worked out from that fact, so it would need a change if that fact changed again. A fact that was observed on its own does not depend on anything. A dependent never depends on a deleted fact.

The code acts on the output:

| `holds` | `stillDepends` | Action |
|---|---|---|
| true | every changed id | Nothing. |
| true | fewer ids | The code drafts a new fact version with the dropped references removed (F8). No model call. The justification carries over. |
| false | any | Q9. |

### Q9: rewrite the dependent

Input:

```ts
{
  dependent: FactMaterial;
  reason: string;              // from Q8
  changed: Array<{ factId: string; before: { header: string; content: string }; after: { header: string; content: string; isDeleted: boolean } }>;
  lintFailure?: string;
}
```

Output: one `FactDraft` for the dependent, without `justification`, that holds under `after`, or `isDeleted: true` when the dependent's subject is gone. The draft keeps the prior `references` less the ids that Q8 dropped; a deletion draft has no references ([References](../design/data-model.md#references)).

The code sets the justification: empty. Nobody observed the rewrite. It is an inference from the changed facts, and `references` holds them. The old justification stays on the prior version. It supported the old content, and on the new content it would read as evidence against the text it sits on.

A dependent is judged against the draft, not against a committed state. So a crash at any point in the loop leaves no trace, and the whole request repeats (F13).

## Write transaction

`applyChange(requestId, changeSet)` is async, because step 1 calls the embedder. Steps 2 to 6 are one synchronous transaction.

1. Compute the embeddings for every new fact version. This happens before the transaction.
2. `BEGIN IMMEDIATE`.
3. Insert the `changes` row and read back `seq`. If `duplicateOf` is set and that fact is live, insert one `confirm` row for its current fact version; a `duplicateOf` that is deleted gets no row (the duplicate of a deletion, [Step 4. Judge](updates.md#step-4-judge)), and one that does not exist is refused. A `duplicate` or `rejected` change with facts is refused.
4. For each fact in `facts`, resolve or create the `facts` row, then insert the `fact_versions` row with `seq`, and its `fact_version_refs` rows. Reject the write if a reference id does not exist, or if a deletion version holds a reference ([References](../design/data-model.md#references): every writer of a deletion is code, so a reference there is a bug in the caller).
5. Insert the new fact versions into `fact_versions_fts` and `fact_versions_vec`. For each fact with a new version, delete its `current_vec` row, and insert one when the new version is live, with the 1-bit vector and the float vector.
6. `COMMIT`.

`fact_versions_fts` is an external-content table, so a plain `DELETE` does not remove an index row. The delete form is:

```sql
INSERT INTO fact_versions_fts(fact_versions_fts, rowid, header, content) VALUES ('delete', ?, ?, ?);
```

`wikifact reindex` uses the same form, or rebuilds with `INSERT INTO fact_versions_fts(fact_versions_fts) VALUES ('rebuild')`.

A failure at any step rolls back everything, so one change gives one transaction, one sequence number, and one wiki state. The claim's facts and the dependent facts of [Dependents loop](updates.md#dependents-loop) share that sequence number. A merge ([Step 3. Merge](updates.md#step-3-merge)) is its own change and commits before the claim's.


## High volume mode

Design: [High volume mode](../design/updates.md#high-volume-mode). Code in `src/updates/batch/`; the store part in `src/store/batch.ts`.

**The shape of a batch** (code in `src/updates/batch/`, `run.ts`, `reconcile.ts`, `step.ts`; the store part in `src/store/batch.ts`, `src/store/staging.ts` and `src/store/stagedVectors.ts`). A batch is staged, then promoted: the requests write to the staging tables of the live database, and 1 transaction promotes them to the live wiki. The batch has no table and no column of its own. It has the staging tables ([Staging tables](storage.md#staging-tables)), the meta key of the seq at its start (`MetaKey.BatchStartSeq`; the key exists while the staging tables hold rows), the meta key of its progress (`MetaKey.BatchProgress`, `{ taken, done, staged, stale, reconciliation }` with `staged` the changes in the staging tables and the reconciliation `pending`, `running`, `promoting` or `done`, which the next batch replaces; the Operation page reads it), the stale check of a write and the list of the facts that the staging tables created. The order of the writes to the staging tables does not matter, and the order of the promotion does not matter: the result is the same for each order.

1. **Staging.** `runBatch` drops and recreates the staging tables from the live definitions ([Staging tables](storage.md#staging-tables)), sets their id sequences to the highest live ids (`resetStaging`), so that a staged `seq` and a staged version id are above each live one and the promotion keeps them. It opens the overlay store (`openOverlay`): a second connection to the same database file, with temporary views that shadow the tables `changes`, `facts`, `fact_versions`, `fact_version_refs` and `retrievals` and show the live rows plus the staged rows. Every function of the store API that runs on the overlay store therefore reads the live wiki with the staged set applied, and writes to the `stg_*` tables (`writeNames`). It reuses the index writer of the live store (one embedder), but the index step of the overlay saves the vectors to `stg_vectors` and does not touch the index tables. `runBatch` takes `startSeq` = the highest change seq of the live store, and writes the start seq key. A search, a read and the console read the live tables only, so they never see a staged row.
2. **Run** ([design](../design/updates.md#high-volume-mode), path C of #60). A batch takes up to `batchSize` queued submissions. The run has 2 rounds: the requests of the batch, then the children of their splits. Each round has 4 stages:
   1. **Head.** Each request runs `submissionHead` (Q7, the gather and Q1, steps 1 and 2 of the submission) through `prepareMember` (`src/updates/agent/group.ts`), with up to `highVolume.concurrency` requests at the same time. `takeRequest(store, id, now)` takes a named queued row to `running` on the live store; a child is a row of `stg_change_requests`, and `takeStagedRequest` takes it there. The head reads the live store only; a split writes its change and its children to the staging tables through the overlay store. A request that Q7 ends is settled. A request whose scope holds 2 or more live facts (`Crowded`) leaves the round and runs again alone after the promotion (step 5).
   2. **Group.** `groupRequests` (`src/updates/batch/groups.ts`) embeds the change text of each request with the index embedder of the store and links 2 requests when the cosine distance of the 2 vectors is under `highVolume.groupCut`. A group is a connected set of links (union-find), its members in queue order. No model call.
   3. **Judge.** Up to `highVolume.concurrency` groups at the same time. 1 call of the group question QG (`buildGroupCall`, `src/updates/questions/group-call.ts`; the spec in `src/updates/questions/specs/group.ts`; the model and the effort of Q4) takes the claims of the group in queue order (`position`, `change`, `justification`, the facts of the scope from Q1) and returns 1 answer for each: `position`, the verdict of Q4, `target` (a fact id, or the position of an earlier claim of the group) and the `draft` of Q5 when the verdict writes a fact. An invalid answer is asked 1 more time with the error. The call writes its `model_calls` row (question `QG`, under the first request of the group) like any question, and returns its tokens with the answer; the round (`src/updates/batch/round.ts`) splits them over the requests of the group in equal shares, the rest to the first (`splitUsage`), and adds the share of a request to the usage account (`addUsage`) before it writes that request, so that the `change` line of each request carries its share. `writeMember` writes the answers in queue order through `finishSubmission` (the lint, `applyChange`, the dependents) on the overlay store, with the stale check (step 3); a target by position resolves to the fact that the earlier claim wrote.
   4. **Fall back.** A second invalid answer or a failed call (not a rate limit) runs the requests of the group 1 at a time with `submission()`, the full pipeline, on the overlay store. A failed write runs the rest of the group the same way, from the failed claim on; the earlier writes stay staged. A failed QG call carries the tokens of all its attempts on the thrown error (`askMeasured` attaches them in 1 `catch`; `failedUsageOf` reads them). The round adds them to the usage account before the first fall back runs, so the `change` line of the first request that falls back carries the whole cost of the failed call, and a stop during the fall back loses no token. A QG call that ends in a rate limit adds its tokens to no request: the batch is dropped and its requests go back to the queue. Its `model_calls` rows hold the tokens, and the cost (`tokenCost`) reads those rows.
   A request that ran to its end stays `running` on the live store until the promotion (`staged` of the progress counts the staged changes; `done` counts only the requests that the promotion marked done, and the reruns that ended); `settleFailure` settles a failure on the live store: a rate limit releases the row and drops the batch, a broken invariant fails it, any other error counts an attempt. Step 9 (prior query check) is skipped, and `ProcessResult.relevantFactId` carries the fact that the prior query should find. `runBatch` collects the checks (`PriorQueryCheck`: the `searchId` and the fact; the fact goes through `keptFact` of `reconcile.ts`, so a fact that the reconciliation merged away becomes the fact that it kept), and `promoteStaging` queues a lookupRepair request for each in the promotion transaction, after the requests are marked done. The context carries 2 flags: `staleCheck` (the write is checked against other writers) and `inBatch` (step 9 is left to the promotion); the reruns after the promotion set neither. A child is never split again: a child that Q7 finds compound is rejected as compound.
3. **Stale check, in code.** Each request records the highest live seq at its gather (`AgentContext.staleCheck` turns the check on; the path of 1 request at a time has none). At its write, inside the write transaction of the overlay connection, `applyChange` reads the facts that its change set writes, the `duplicateOf` fact, the target facts and the live facts of its scope (the Q1 matches). A fact is stale when a live version of it has a seq above the recorded seq (a writer outside the batch), or when the staging tables hold a version of it that belongs to a change of another request (`request_id` is not the request itself). The same check covers the facts that a draft references (a stale fact, or a reference to a fact that is deleted in the overlay now). Then the write is refused (`StaleChangeError`, the facts in `factIds`; `factsChangedSince` is the query), the batch logs `batch_stale`, and the request waits. After the promotion it runs again alone on the live wiki, in queue order, with the staged changes now live. A request runs again at most 1 time, and the second run has no stale check, because nothing runs next to it.
4. **Reconciliation of the staged facts, on the staging tables.** After the last round, each fact that the staging tables hold a version of (`stagedFacts`, ordered by the queue time of its request, then by id, so that the order does not depend on the order of the writes) gets the duplicate fact repair of the cleanup (`repairFacts`: Q1, then the merge with the guard of Q2) against its `DUPLICATE_FACT_NEIGHBORS` (3) nearest facts among the facts that another group of the batch staged (`nearestAmong`, by the cosine distance of `stg_vectors`, under `store.config.neighborDistance`). A pair inside 1 group and a pair with a fact from before the batch get no check: the group call saw both claims, and a request read the facts from before the batch at its own Q1. The 2 rounds count as 1 batch, so a child is compared with the facts of the other groups of both rounds. It runs on the overlay store. The older fact of a pair comes first (`olderFirst`: by the queue time of its request). The change of a merge is written to the staging tables under the request that created the newer fact of the pair, and the merges are recorded in `ReconcileResult.mergedInto`. A pair with a fact that an earlier merge removed is skipped as stale. A pair that fails (a lint error, a failed call) is logged as an `unhandled` warning and the next pair runs; a rate limit halts the reconciliation and drops the batch.
5. **Promotion.** When the reconciliation is complete, the progress is `promoting` and `promoteStaging(live, { startSeq, done, priorChecks, now })` runs 1 immediate transaction on the live store. It asserts that the highest change seq of the live wiki still equals `startSeq` (`LiveMovedError` otherwise: nothing is written; this guard also keeps the staged ids from meeting a live id). It copies the staging tables to the live tables with their ids, in the order that the foreign keys need, never in the order of the writes: the requests that only the staging tables hold (the children of a split), the changes, the facts, the fact versions, the links, the references and the retrievals. Then it writes the index rows in one call of the index writer, with the versions in id order, and the vectors from `stg_vectors`, so the embedder does not run (when a vector is missing, only the FTS rows are written). It marks the requests that the batch ran to their end done (`finishRequest`), queues the lookupRepair requests of the prior query checks (`priorChecks`, step 2) and deletes the staging rows and the start seq key, all in the same transaction. A failure rolls back all of it and is a drop (step 6). The staging tables are empty when the stale reruns start, so a crash during a rerun finds nothing to drop.
6. **Drop.** A stop (queue pause or signal), a rate limit, a reconciliation that did not end, a promotion that failed (a live wiki that moved) or an error before the promotion drops the staging set: the overlay connection is closed, the staging rows are deleted (`clearStaging`), the start seq key is deleted, the requests that ran on the staging set go back to the queue (`releaseRequest`: no attempt is counted, because a fault of the batch is not a fault of the requests), the progress is `pending` with `done` unchanged at the promoted count (0 before a promotion), the live wiki is unchanged, and `batch_dropped` is logged (`reason`, `staged`; level `error` for a failed promotion, `warn` otherwise). A failed promotion does not throw out of `runBatch`: the result is `Dropped` with the `error` and the `ids` of the released requests in queue order. The worker then runs those requests on the path of 1 request at a time (`runOnce`: no staging, so no promotion can fail), in queue order, and starts no batch until it has taken that many steps (it counts a step that ends in done, rejected or a failed attempt; a rate-limited step and an idle poll do not count, and an idle poll ends the run). So the queue does not stay backed up, and no loop of failing batches is possible. The error shows in the worker status as `lastBatchError` (below) and on the Operation page in the panel "Batch, now". A crash leaves the key and the staging rows: `batchStep` finds the key, deletes the rows and the key, sets the progress to `pending` and logs `batch_dropped`; the requests are already queued again (`resetRunning` at the start of the worker, and at the `--resume` of the bulk test). There is no resume: the work of the dropped batch runs again.
7. **Old keys and old files.** A `wikifact.json` that holds `highVolume.min` or `highVolume.neighborDistance` loads, and the key is ignored. Schema 17 deletes the meta key `high_volume`. The preset loader (`src/config/presets.ts`) and the result reader (`eval/questions/results.ts`) skip the entries of Q7B, Q5B and Q15 through `REMOVED_QUESTION_IDS` (`src/constants.ts`), so old presets and old result files still load.

Why: the check and the draft of 1 submission do not depend on the other submissions. Only 2 requests of 1 batch in 1 scope do. So the judgment is the judgment of 1 request at a time by construction, and the batch needs only the stale check and the reconciliation. The cost is the cost of 1 request at a time plus the reconciliation. The staging set is a set of tables in the live database, not a copy of the database: a request then reads the live wiki only and never meets the staged change of another request, so no order of the writes can change what a request sees, and the promotion has no write order to replay. The write layer (`writeSteps.ts`) is one code path that takes a target, the live tables or the staging tables (`writeNames`), so the pipeline needs no second version of it. The overlay views give the reconciliation one store that holds the live wiki plus the staged set. The cost is that a request cannot read its own staged merge, so it waits for the promotion (step 2), and a promotion that fails when the live wiki moved (the batch is dropped, and its requests run 1 at a time). A cheaper path is a separate problem (the owner, 2026-10-21).

**The worker loop.** After a poll, `planBatch` decides the step. When the front of the queue holds `highVolume.batchSize` submissions, or the oldest queued submission at the front was queued `highVolume.waitMs` or more ago, or the meta key `batch_now` exists, the worker runs 1 batch with the submissions at the front, up to `batchSize`, and deletes `batch_now`. Else, when the front row is not a submission (`operatorEdit`, `lookupRepair`, `cleanupRepair`), it runs that row alone with `runOnce`; these rows never join a batch and keep their order rules. Else it waits for the next poll. The queue pause, the rate limit pause and the stop signal are checked before each request and each pair of a batch; a request that has started ends. When a batch ends with failed requests, the worker waits `retryDelayMs` once before the next step, and a batch whose requests all failed counts as a failed attempt of the worker (`worker-status`). A batch dropped for a failed promotion is not a model call: it does not touch `lastCall` or `consecutiveFailures`.

**Rules of the runner** (`src/updates/batch/`, `runBatch`, `planBatch` and `batchStep`):

- Config `highVolume` in `wikifact.json`: `batchSize` (10), `waitMs` (60000), `concurrency` (4) and `groupCut` (0.215), the values that #60 measured. A `wikifact.json` that still holds `min` loads, and the key is ignored.
- The meta key `batch_now` (`{ at }`) is written by the operator's button "Run a batch now" on the Operation page, read and deleted by `planBatch`. With no queued submission, the worker deletes it and runs no batch.
- A batch takes the submissions at the front of the queue, in queue order, up to `batchSize`, and stops at the first row of another kind: that row runs alone first, so the order rules of the kinds hold.
- `BatchRunResult`: `Done` (`size`, `outcomes`, `failed`, `error`, `stale`, `merged`, `promoted`), `Stopped` (the reason), `Dropped` (the `error` of a failed promotion and the `ids` of the requests released with no attempt counted) or `RateLimited` (the request and the error). `Stopped` and `RateLimited` mean that the staging set was dropped before its promotion, or, when only a stale rerun was cut short, after it.
- Log events: `batch_stale` (`request_id`, `facts`), `batch_dropped` (`reason`, `staged`) and `batch_done` (the size, the counts per outcome, `failed`, `stale`, `merged`, `promoted` and the `ms` of the batch). Each request writes its own `change` line. The tokens on a `change` line are approximate when requests run side by side, because the usage counter of the questions is drained by whichever request ends first; the `model_calls` rows are exact.

**The test of both paths.** `npm run eval:bulk -- --db <copy> | --wiki <name> [--env <name>] --requests <n> [--batch-size ...]` in `eval/bulk/`: it takes `n` queued submissions of a copy, runs them 1 at a time on a second copy and as batches on a third, from the same start, and writes a result file with, per path: the wall time, the tokens (in, out, cache read, cache write) and the dollars, the calls, the outcome of each request, and after the run the duplicate pairs of the live facts (the candidates of the duplicate fact finder, judged by Q1 on both copies) and the facts that differ. The tokens, the dollars and the calls are the `model_calls` rows of the copy from the start of the path (`modelCallTotals`), priced by `config/prices.json`; the wall time is that of the path alone: the sum of the time of its steps, not of the copies, the judging or the snapshots that the harness takes between the steps (reading the requests, measuring the usage, writing the file), which are kept apart as `snapshotMs`, so that a path with more steps does not look slower for its snapshots. The harness trims each copy to the same `n` first queued submissions (it fails the other queued rows on the copy, with a note), clears the queue pause, runs the 1 at a time path with `runOnce` until the queue is idle, and the batch path with `batchStep` started at once (no wait) until it takes no batch (the children of a split join the next batch). The duplicate pairs: for each live fact written in the run, its 3 nearest live facts by the cosine distance of the text embedding under `neighborDistance` (the method of the duplicate fact finder); Q1 judges the fact against those neighbors, and each neighbor it returns makes a pair. The facts that differ: the requests whose outcomes differ between the paths, and the facts written in the run whose header (matched in lower case) only one copy holds. The result file is rewritten after each request or batch, and a path that did not end is marked incomplete. A rate limit stops the run and keeps the rows; the harness does not wait it out. A run that did not end keeps its two copies, and `--resume <result file>` (with `--db`, for the config) reopens them, takes the sample size, the batch size, the concurrency and the stub mode from the file, skips a path that ended and continues the other from its last finished step, with its counters, its times and the start of its usage window kept; a missing copy fails the resume. `--resume` calls `resetRunning` (the function that the worker calls at its start) on each reopened copy before it continues a path, so that the requests of the step that stopped run again. At the end of a path the harness counts the requests of the sample, the children of a split included, that are still `running` or `queued`; when the count is more than 0 the path is not complete, the result file marks it incomplete with the count (`unfinished`), and the run exits with code 1 and 1 line that names the count. A run made with `--work-dir` resumes only with the same `--work-dir` folder. The work folder holds the copies. Its default is decided in 1 function of `eval/bulk/args.ts`: with `--db`, the folder of the `--db` file; with `--wiki`, `.cache/bulk-work/<env>/<wiki>/` in the repo, so that 2 wikis or 2 environments never share copies. `--resume` compares the `env` and the `wiki` of the result file with the arguments, and a difference fails the resume before it opens a copy. A test that runs the bulk test always gives `--work-dir` in its own run folder. The read-only connection to a wiki of the environment can make the `-wal` and `-shm` side files of SQLite beside the wiki; these are the only files that an eval puts into a folder of the environment, and the content of the wiki does not change. `--stub` runs the harness on stub questions and the fake embedder, and stops with an error when the wiki was built with the other embedder ([The wiki of the bulk test](#the-wiki-of-the-bulk-test)). It runs at sizes on orders of magnitude (10, 100 and 1,000 requests; the owner, 2026-10-20). The 1-at-a-time path costs the same per request at every size (each request runs alone, about 28 s), so it runs at 10 and 100 requests, and its time and tokens at 1,000 are 10 times those at 100, marked as projected in the result file. The source is a test wiki that `npm run eval:bulk-wiki` builds from test data in `fakes/`: seed facts and queued submissions, with the 2 compound claims of #32 among them; the built file is not committed ([The wiki of the bulk test](#the-wiki-of-the-bulk-test)). The bulk test is a postdeploy test: it can also take its source from a wiki of the environment that `--env` selects (`--env local --wiki <name>`), and it never writes that wiki. The copies are made with the SQLite backup API, never by a file copy of a database in WAL mode. The result file records the `env` and the `wiki` of a `--wiki` run besides the file name in `source`. An error in an entry point of `eval/` gives exit code 1.

**The labels of the bulk test data.** Each queued submission of the test data in `fakes/` carries the set of ends that a correct pipeline can give it. The set follows from the steps above, first the justification, then the claim:

| The submission | Its justification | The correct ends |
|---|---|---|
| Any claim | A belief or an inference | rejected unsupported (step 1) |
| 1 claim against a seed fact | Hearsay (someone told the submitter): a `report`, which step 1 lets through | rejected contradicted (Q4 weighs it against the stronger justification of the seed fact) |
| 2 or more claims | An observation | split only: a compound submission that is not a child is split; only a child that is still compound is rejected as compound, and the queue holds no child |
| 1 claim that a seed fact already states | An observation | duplicate of a seed fact |
| 1 claim against a seed fact | An observation weaker than the justification of the seed fact (an older draft, a stale page) | rejected contradicted |
| 1 claim against a seed fact | An observation stronger than the justification of the seed fact (a code constant, a run of the system) | correction accepted |
| 1 new claim | An observation | accepted as new |
| A later member of a group that states 1 new claim in other words | An observation | duplicate of an earlier submission, merged |
| The weaker member of a pair with 2 values for 1 new scope | A weak observation (an older draft) | rejected contradicted, loses in the reconciliation |

A "duplicate of a seed fact" and a "duplicate of an earlier submission" are 2 ends, with 2 values in the result file. The pair of a group names the value that the kept fact must hold. The labels are checked by the values of the ends, never by the prose of a note.

### The wiki of the bulk test

The bulk test does not take the live queue. `npm run eval:bulk-wiki [-- --stub]` (`eval/bulk-wiki.ts`, the builder in `eval/bulk/wiki.ts`) builds its source copy from the 2 data files in `fakes/`: `bulk-seed-facts.ts` (about 200 facts about the code base, each 1 claim) and `bulk-submissions.ts` (100 submissions with a change, a justification and the outcome each must end as, in queue order). A new failure case of the pipeline adds its submission to the file.

**Where it goes.** To a fixed path under `.cache/bulk-wiki/`, which git ignores, and never under `wikis/` (a service that mounts `wikis/` would run the 100 submissions with real model calls). There is no `--out`. The 2 kinds have 2 folders and 2 file names, each with its own `wikifact.json`: `stub/bulk-stub.sqlite` for `--stub` (the fake embedder, no model download) and `real/bulk.sqlite` for the real embedding model. The config of the stub wiki names the embedding model `fake-embedder`, which the store keeps in `meta` and checks at each open. `npm run eval:bulk` reads that name, so it stops with an error on a stub wiki without `--stub`, and on a real wiki with `--stub`.

**A stale wiki.** A wiki built before a change of `fakes/bulk-submissions.ts` holds other submission texts than the labels. Before it makes a copy, `npm run eval:bulk` on a wiki that `npm run eval:bulk-wiki` built compares the change text of each queued submission, in queue order, with the submission at the same position of `fakes/bulk-submissions.ts`. When 1 or more differ, it stops with an error that names the count and the first positions, and says to run `npm run eval:bulk-wiki`. The score against the labels and the label pairs of the grouping then map each request to its label by its position only. The test knows a wiki that `npm run eval:bulk-wiki` built by the meta key `bulk_test_wiki`, which the builder writes into the database (a copy keeps it); a source without the key, such as a copy of a live wiki, is not checked. A wiki in `.cache/bulk-wiki/` that has no key is built again with `npm run eval:bulk-wiki` before its next run.

**How it is built.** The database is made in a temp file in the same folder and a rename puts it over the target when the build ends, so a reader never sees a half-built file and 2 builds at once do not corrupt each other (the last rename wins). When Windows refuses the rename or the delete of the side files (EBUSY or EPERM), the build fails with an error that says another process holds the wiki file. The builder owns its folders, so it always writes its own `wikifact.json` there, and the embedder in the config is always the one that was built; `npm run demo:seed` keeps an existing config. It creates the database with the schema of the current code, writes the seed facts in one accepted change with their embeddings, and queues the submissions 1 ms apart. The step that `npm run demo:seed` also takes (write the local-mode config, open the store, write the seed change) is 1 function, `seedWiki` in `eval/lib/seed-wiki.ts`.


**What the submissions hold.** Each carries its `kind`, its justification (with its kind: observation, hearsay, belief or inference) and a non-empty set of acceptable ends (`expected`): a submission is judged right when it ends as any member. The set comes from the paragraph "The labels of the bulk test data" above and from nothing else; a test checks the submissions with a hearsay, belief or inference justification against the table: a belief or an inference expects rejected unsupported only, and hearsay (a claim against a seed fact that states the true value of its scope) expects rejected contradicted only. The first 10 hold the 2 compound claims that the old batch path accepted (the children of "WikiFact is written in TypeScript on Node.js 22 with better-sqlite3." are duplicates of seed facts), then at least 1 of each other kind, and the kinds alternate after them. The same-subject groups are pairs or triples on one new scope. In a group that states one claim in other words, the first member is accepted as new and each later member ends as a duplicate of an earlier submission, merged. In a group with conflicting values, the first member is true and has a strong observation (a code constant or a direct observation), each later member is false and has a weak observation (an older draft), and ends as rejected contradicted or loses in the reconciliation; the submission names the value that must win (`keeps`), so a scorer can check the kept fact.

### The score of the bulk test

The bulk test compares the batch path of the worker with the path of 1 request at a time, the benchmark, each on its own copy from the same start. #60 chose the architecture of the batch with it ([research note](../research/bulk-architectures-runs-2026-10-26.md)).

**The score against the labels.** The result file scores each path against the labels of `fakes/bulk-expected.ts`, not against the other path:

1. For each request, the children included: its end, and whether the end is in its set of correct ends.
2. For the end state of the copy: the count of new live facts against the labels (41 on the full set), the corrected seed facts, the live facts that hold the false value of a conflict group (the `keeps` value must win), the pairs of live facts in 1 scope (Q1 on the candidates of the duplicate fact finder, as today), and the compound live facts.
3. 1 line for each path: the right ends, the wrong ends, and each failed check of the end state, with the positions of the requests.

A label that the research note marks as unclear is scored apart and not counted as wrong.

**An equal pair in either order.** A label that says "duplicate of position q" names an equal pair: the request (or child) that has the label, and the request at position q, whose label is accepted as new. The labels put the pair in queue order, with children after all 100 requests. A path that runs in batches can run the 2 ends in the other order: a child of an early batch runs before the request q of a later batch. The scorer takes both orders as right:

1. The labelled order: the end with the label "duplicate of position q" ends as a duplicate, and the request q ends as accepted as new.
2. The other order: the end with the label "duplicate of position q" ends as accepted as new, and the request q ends as a duplicate of a fact that this end wrote.

In the other order, each of the 2 ends is right only when the other end has its matching outcome. Any other combination scores as the labels say.

**A new score of a result file.** `npm run eval:bulk -- --rescore <result file>` scores the request ends of each path of the file again with the current scorer, and writes the new `score` of each path back into the same file. It makes no model call and no copy. The checks of the end state need the copy, so it keeps them as they are in the file. Each end of a score holds whether an accepted end was a correction. In a file from before that field, the earlier score shows it only when the label of the end accepts a correction or a new fact; for any other accepted end, the new score keeps the earlier verdict of that end and of its pair, and leaves the field absent on that end, so a later new score keeps the verdict again. The file is written to a temp file in the same folder, and a rename puts it over the file.

The scorer is `eval/bulk/score.ts` (`scoreRequests`, `scorePath`); each path result in the file holds `score` (the right, the wrong, the unclear apart, each end, the checks of the end state and the line). A sample of fewer than 100 requests is scored against the labels of its first positions, and a source whose sampled requests are not the submissions of `fakes/bulk-submissions.ts` gets no score. The code reads the checks like this: an accepted request is a correction when it wrote a version of a fact from before the run, else a new fact; a duplicate matches the 3 duplicate ends; a rejection matches by its reason; a child is scored by its place among the children against the claim of that place, by its outcome. New live facts are the live facts whose first version is after the start; the range of the check is the labels' count up to the extra facts of the 4 unclear submissions that a path may split (`MAY_SPLIT_EXTRA_FACTS`, 41 to 46 on the full set). A corrected seed fact is a live fact from before the run with a version after it. A member of a conflict group holds the false value when a live fact that it wrote lacks the `keeps` value. A compound live fact is a live fact that a compound submission (a label of the kind split) wrote as 1 accepted request. The pairs are those of the duplicate judging, and a judging that did not finish fails the check.

**The batch path of the bulk test.** The second path is the batch path of the worker: `batchStep` until it takes no batch, with the batch started at once (no wait), then `runOnce` until the queue is idle, so that the lookupRepair requests of step 9 run and count in the path. `--batch-size`, `--concurrency` and `--group-cut` set `highVolume.batchSize`, `highVolume.concurrency` and `highVolume.groupCut` of the copy for the run; with none of them, the config of the source applies. The result file records the 3 values. The result files of #60 hold an `arch` and the rounds of B and C; the reader still reads them, so `--rescore` scores them again, and `--resume` of such a file is an error that says the architecture is gone.

**The second path alone** (`--second-only`). The run makes no copy for the benchmark and runs only the batch path. The score against the labels measures the path; the result file holds no sequential path and no differences between paths. `--resume` of such a file continues it as a run of the batch path alone, so that each batch size does not pay for the benchmark again.

## Consumer correction duty

The 3 levers from [Correction duty](../design/submit.md#correction-duty):

| Lever | Where |
|---|---|
| Tool descriptions | `search` and `getFact` end with: "Before you finish your task, send what you observed that the wiki lacks or gets wrong with the `requestChange` tool: what you saw, and how you know." |
| Cost of a correction | `requestChange` needs 2 free-text fields and no target. The submitter does not write the fact. |
| Result size | `search` returns at most `searchCap` results ([search](lookup.md#search)). |

The harness-side lever, a stop hook, is outside this repository. The eval harness includes one example hook for Claude Code, so the correction test measures both cases.

## Failure modes

No human watches the wiki, and a submitter sends one message and is gone (requirement "One call"). So a failure is diagnosed by one of 5 actors:

- The pipeline, on a later request that touches the same facts.
- A consumer, when it acts on a fact and reality disagrees. It often triggers a diagnosis without knowing what the issue is.
- The operator, by a command or a test.
- The cleanup of [Cleanup](cleanup.md), when its check is due.
- The code, by schema validation and timers ([Model call failures](updates.md#model-call-failures)).

"Found by" names who diagnoses the issue. "Repaired by" names who writes the fix.

### Agent write failures

| # | Failure | Example | Cost | Found by | Repaired by |
|---|---|---|---|---|---|
| F1 | Duplicate. A fact with the same scope exists. Q1 misses it and a second fact is written. | "Creeper damage" and "Creeper explosion damage" are both live. | High. The 2 drift apart. A correction lands on one. Confidence and usefulness split. | Q1, on a later request whose candidates hold both: 2 live same-scope matches. Or a future fact finder of the cleanup ([Cleanup](cleanup.md)). | The merge step ([Step 3. Merge](updates.md#step-3-merge)). One merged version on the kept fact, and a deletion of the other, with no references ([References](../design/data-model.md#references)). The retrieval history of the deleted fact stays on it. |
| F2 | Compound fact. One fact version holds 2 claims. Q7 missed it at step 1. | "Skeletons are hostile and spawn at night." | High. A correction to one claim rewrites the other. A deletion deletes both. Q1 matches the compound to neither single claim, so F1 follows. | A future fact finder of the cleanup ([Cleanup](cleanup.md)), or a later request that touches the fact. | The consumer, with 2 requests of one claim each after the finder finds it. The pipeline never splits a fact. |
| F3 | Fragment. One claim cut into facts that do not stand alone. Q5 over-applies the one-claim rule, most often while it fixes an F2. | "A bow at full draw deals 6 damage" becomes "Bow damage is 6" and "Full draw is required". | Low. A search for "bow damage" returns the first fragment alone. | Q4, on the correction, when gather shows the other fragment in the same scope. Trigger: a consumer acts on the fragment, reality disagrees, it submits what looks like an F5. | Q5. Joins them. |
| F4 | Lost claim. A true claim is rejected, or Q4 reads it as the same claim as the existing content. | "Creepers do 10, not 7" marked a duplicate of "Creeper damage: 7". | Medium. The claim stays out until another agent observes the same reality and submits with a stronger justification. A repeat with the same justification gets the same result. | Q4, on the later submission, judged alone. The Q4 test set holds "same scope, different value" cases. | Q4 on that submission. |
| F5 | Wrong fact. A false claim written, or a true claim gone stale. Both look the same to every actor. | "Zombies drop diamonds", from one untested submission. Or "Creepers do 10 damage" after a game update set it to 12. | Low. | A consumer, when it acts on the fact and reality disagrees. | That consumer's correction. |
| F6 | Wrong delete. A fact that still holds is deleted as a duplicate, in a split, or because Q4 judged its subject gone. A false claim is corrected, not deleted. | "Potions were removed from the game" makes Q4 delete every potion fact. They were not removed. | Low. The consumer sees a gap: `search` excludes deleted facts. | Q1, on the next submission in that scope: it returns the deleted match, and Q4 weighs the deletion justification against the submission. Trigger: a lookup gives no answer, the consumer acts on reality and submits. | Q4. A new fact version with the new justification. |
| F7 | Missing reference. A fact depends on another and does not list it. | "Charged creepers do double damage" lists no reference to "Creepers do 10 damage". | Medium. A change to the base damage does not re-judge the dependent. It goes stale in silence and reads as an F5. | Q5, on the correction, if it sees that the fact rests on a gathered fact. It may set the reference and never name the cause. Or a future fact finder of the cleanup ([Cleanup](cleanup.md)). | Q5. Sets the list on the new fact version. |
| F8 | Wrong reference. A fact lists a fact it does not depend on. | "Creepers are green" references "Creepers do 10 damage". | Low. One needless re-judge per change to the target. | Q8, on the needless dependents pass: the target id is absent from `stillDepends`. | Code. A new fact version with the reference removed. |

### System failures

| # | Failure | Example | Cost | Found by | Repaired by |
|---|---|---|---|---|---|
| F12 | Lost request. 3 failed attempts, or 1 for a broken invariant ([Queue and worker](updates.md#queue-and-worker)). | The API returns an overload error 3 times. Or a call times out, or a question returns invalid output twice, or a draft fails lint twice, on 3 attempts. | Medium. The claim stays out, as in F4. | The operator, with `wikifact requeue`, which lists failed rows. One log line per failure. | `wikifact requeue <id>`. |
| F13 | Crash mid-run. | Power loss after Q8 returns on the third dependents pass and before `COMMIT`. | None. | The worker, at restart: `running` rows go back to `queued`. | The run repeats. One transaction, so no partial state. |
| F14 | Index drift. FTS5 or the vector table disagrees with `fact_versions`. | The operator edits `fact_versions` by hand. | None by design: index writes sit in the write transaction. | `wikifact check`, which compares row counts. | `wikifact reindex`. |
| F15 | Embedding model change. | `embeddingModel` changes from a 384-dimension model to a 768-dimension model. | Medium. Every search degrades until the rebuild. | The Store API, at start: it compares the config with `meta` and refuses to start on a mismatch. | `wikifact reindex`, which embeds every fact version again. |
| F16 | Lazy consumers. Facts are read and never corrected. | "Zombies drop diamonds" has 200 reads and 0 corrections. | High over time. Confidence inflates. F5 facts stay. | The correction test ([Tests](submit.md#tests)). | [Consumer correction duty](updates.md#consumer-correction-duty) and [O5](README.md#open-settings). |
| F17 | Rank feedback. Low usefulness, low rank, no reads, low usefulness. New facts never surface. | A new fact ranks 11th on every search, under the cap of 10. | Medium. | The correction test: it seeds new facts and counts how often a search returns them. | The confirm event. A consumer that cannot find the fact observes reality and submits it, the duplicate pass writes a confirm row, and usefulness rises. `W_USE` ([O2](README.md#open-settings)) sets how far rank follows usefulness. |

### Model call failures

A wrong judgment shows up as one of F1 to F11. This table holds the mechanical failures of a call.

| # | Failure | Example | Cost | Found by | Repaired by |
|---|---|---|---|---|---|
| F18 | Invalid output. The answer does not match the schema, or a required field is absent. | Q4 returns `rejected` with no `rejectReason`. | None once. The code retries the call once with the validation error. Twice: the attempt fails, toward F12. | Code, on validation after the call. | The retry. Then the attempt path. |
| F19 | Refusal. The API returns `stop_reason: "refusal"`. | A justification quotes exploit text and a classifier declines. | None once. The server-side fallback routes to another model. If that refuses too, the attempt fails, toward F12. | Code, on `stop_reason`. | The fallback. Then the attempt path. |
| F20 | Gather missed a fact that Q4 needed. | The claim contradicts a fact in another scope, and the gather search did not reach it. | Medium. Q4 does not see the disagreement, and Q5 writes a fact that disagrees with a live fact, and neither references the other. Reads as an F5 or an F7. | The replay test, with a case per miss kind. Or a consumer, as F5. | Widen gather: `agentSearchCap` in `wikifact.json`. |
| F21 | Timeout. A call runs past `questionTimeout`. | A hung connection. | None once. The attempt fails and the worker retries. Three times: F12. | Code, on the timer. | The attempt path. |
| F22 | Compound submission. The `change` text holds 2 claims. | "The pipeline judges in step 4 and drafts in step 5, as separate questions." | Low. Q7 at step 1 splits the request into one child per claim and ends it as `split`, after 1 model call; a compound child, or a change with fewer than 2 claims, ends as `rejected` with the reason `compound` and Q7's reason. The first wiki showed the old path, a lint at step 6: 3 attempts, 6 drafts, 3 minutes, and a `failed` row that read like an outage. | Q7, step 1. | None for a split: the children run alone. For a rejection the consumer resubmits the claims one by one. The Q7 set holds compound submissions that must split into the right claims and single claims with context that must pass. |
| F26 | Rate limit. The model answers 429 or "overloaded", for example the session limit of the login. | The CLI says "rate limit" for every call until the session resets. | None for the request. No attempt is counted. Every request would meet the limit, so counting it ended a queue of 600 as `failed`. | Code, `classifyCallFailure` on the error text of the attempt. | The pause: the worker sets the request back to `queued`, attempts unchanged, and takes no request for `RATE_LIMIT_PAUSE_MS` (5 minutes) the first time, doubling on each rate-limited call in a row up to `RATE_LIMIT_PAUSE_MAX_MS` (1 hour), and back to the first value after a call succeeds. When the error text names the time of the reset (the CLI says, for example, "resets 4pm (America/Los_Angeles)"; the forms are the ones in the logs of the service), `rateLimitResetAt(error, now)` in `src/updates/worker-status.ts` gives that time in ms since the epoch: the next moment at that clock time in that time zone, with the date when the text names one. The pause then lasts until that time plus `RATE_LIMIT_RESET_MARGIN_MS` (2 minutes), in place of the doubled wait, and `pausedUntil` holds it; a time in the past or more than `RATE_LIMIT_RESET_MAX_MS` (8 days) ahead, or a text that does not parse, gives the doubled wait ([A large queue](../design/updates.md#a-large-queue): the doubled wait ended 33 to 41 minutes after the reset in 4 of 5 cases). The pause ends on its timer or on the stop signal. 1 log line per pause: `rate_limit_pause` at level `warn` with `request_id`, `waitMs` and `error`; the resume has no line of its own. The status of [Queue and worker](updates.md#queue-and-worker) shows it, and Service health shows the worker as paused. A credential text wins over a rate limit and is an ordinary failed attempt. |
| F24 | Scope over-match. Q1 matches the claim to a sibling scope, and the claim rewrites the wrong fact. | "The errors log keeps 10 files" matched "The full log keeps 5 files", and 3 single claims about 2 log files ended as 1 fact. | High. The old content survives as a version only, and a reader sees the wrong value under the wrong header. | Q4, with `relation: unrelated` (step 4). Q2, with `stands: unrelated`, before a merge (step 3). The replay case "sibling scopes stay apart". | The code treats the claim as new. The Q1 set holds sibling-scope cases, and Q1's bar is measured on them. A future fact finder of the cleanup ([Cleanup](cleanup.md)), for the facts already overwritten. |
| F23 | Unstable answer. The same input gives a different label on another run. | Q1 matches a scope on one run and not on the next. | Medium. The question test set fails on some runs and not others. One run of the pipeline is wrong by chance. | The question test, run more than once per model. | A stronger model or a higher effort for that question ([O6](README.md#open-settings)). |

## Tests

Design: [How the feature is measured](../design/updates.md#how-the-feature-is-measured). The command `npm run eval:all` runs this test with the others ([System evaluation](evaluation.md)).

| Test | Requirement | Method | Pass condition |
|---|---|---|---|
| Replay | AI agents add, correct and delete facts | 10 recorded change requests with expected outcomes, including duplicates and conflicts. Each runs the whole pipeline on a fresh copy of the seed, so one miss does not move the next case. | No duplicate and no compound fact: the 2 costly failures. Any other wrong write is cheap to repair, so other misses are reported only. |
