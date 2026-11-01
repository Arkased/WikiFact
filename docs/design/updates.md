# Process submissions

Design layer. The requirements are in [../requirements/updates.md](../requirements/updates.md). The technical details are in [../technical/updates.md](../technical/updates.md). The data model is in [data-model.md](data-model.md).

## Approach

The update worker is deterministic code. It takes the submissions from a durable queue in batches ([High volume mode](#high-volume-mode)) and runs a fixed chain of steps on each. Code gathers all the material first. Then a model answers a set of narrow questions, 1 question per call, from that material only. Code maps each answer to the next step, and writes the whole change in 1 transaction.

The worker is its own process, 1 per wiki, under a lock. The MCP servers only read and queue. The worker is 1 global job: each change must see every change before it. Consumers come and go, so no MCP server can own the worker.

A submission says what should be different, not how the wiki should be shaped. So the worker adds, corrects or deletes facts. The wiki has its own repair, the cleanup ([cleanup.md](cleanup.md)), which runs between 2 requests when a check is due.

## The pipeline

Each request runs these steps in order. Each step takes the output of the step before it.

1. **Claim check and gather.** The submission check rejects a belief, and splits a compound claim into 1 request per claim ([submit.md](submit.md)). Then code collects the material: the target facts, and the facts that a search on the change text finds. The search includes deleted facts and old versions, so that a deleted claim does not return without new evidence.
2. **Scope match.** A question reads the headers of the candidates and names the ones in the scope of the claim. 0 live matches: the claim is new. 1: the claim corrects or repeats that fact. 2 or more: the wiki holds duplicates.
3. **Merge.** Only with 2 or more live matches. A judgment question decides which content stands, and a draft question writes the merged version. The merge is its own change, and it commits before the claim is judged.
4. **Judge.** A judgment question decides whether the claim is supported, how it relates to the existing fact in its scope, and which other facts it shows to be wrong. Code maps the answer to the outcome and the facts to write.
5. **Draft.** A draft question writes each new fact version. Code writes each deletion and sets each justification.
6. **Lint.** Code checks each draft: every field present, every reference to a live fact. A failure goes back once to the question that wrote the draft.
7. **Dependents.** The worker checks each fact that depends on a changed fact (see "Dependents").
8. **Write.** Code writes the whole change in 1 transaction, with 1 sequence number.
9. **Prior query check.** After the commit, the worker makes sure that the search of the submitter now finds the fact ([submit.md](submit.md), "Missed search repaired").

The outcome of a request is 1 of 3:

- "duplicate": the claim is already in the wiki. No write. The existing fact gets 1 confirmation event.
- "rejected": the request writes nothing. The reason is "compound", "unsupported" or "contradicted".
- "accepted": the request writes at least 1 version.

## Evidence rule

The judgment questions read 2 kinds of text:

- The justification of a submitter is an observation of the shared system. It is evidence. A version with an empty justification was derived, and its evidence is on the facts that it references.
- The summary of a change and the reason of the update agent are agent text. They record a past decision. They are not evidence, so code removes them before the call.

Every submission is judged alone. The worker does not look for an earlier submission of the same claim. A repeat with the same justification gets the same result.

## Dependents

A fact can rest on other facts. When a base fact changes, the dependent can be wrong now. The worker follows the references from each changed fact, to any depth, and visits each fact once:

1. A classification question asks whether each dependent still holds under the changed facts.
2. A dependent that holds and no longer rests on a changed fact gets a new version without that reference. No model writes it.
3. A dependent that does not hold goes to a draft question, which rewrites or deletes it. The rewrite has an empty justification, because nobody observed it.
4. The new drafts can have dependents too, so the loop repeats until no new fact enters.

The loop runs on the draft change set, before the write. A crash at any point leaves no trace, and the whole request runs again.

## A large queue

The worker has a bulk mode for a large queue. The measurement of October 19, 2026 ([research](../research/worker-throughput-2026-10-19.md)) decides the design:

- **The model, not the code, takes the time.** The code steps (gather, embedding, search, lint, write) are 0.6% of a request. Each model call has a fixed cost of about 3.8 s, and a submission makes 3.8 calls.
- **The rate limit of the login is the cap.** In the 51 hours after the fill, the worker was busy 15% of the time, paused on a rate limit 36%, and not running 49%. The weekly limit closed the worker for 27.7 hours. The quota counts tokens, so 2 workers on the same login use it 2 times as fast and do no more work in a week.
- **The cleanup already runs in bulk.** A check runs 1 time for each interval of writes, also in a long queue. A candidate that changed 2 times in 1 interval is examined 1 time.

So the worker has no separate bulk mode. The worker always uses the levers that save time or tokens and change no requirement:

1. **Resume at the reset time.** The message of a rate limit names the time of the reset. The pause ends at that time, plus a margin, in place of the doubled wait, which ended 33 to 41 minutes late in 4 of 5 cases. The doubled wait stays when the message names no time.
2. **The interval counts writes.** The interval of a check counts the accepted changes, as its design says ([Interval per check](cleanup.md#interval-per-check)). The code counted every change row, also a split, a duplicate and a rejection, so a check ran about 2 times as often as its interval says.
Parallel requests and a worker on an API key change the cost or a requirement ("One at a time"), so they are the owner's decision.

## High volume mode

The requirements are in [requirements/updates.md](../requirements/updates.md) ("Consistent result", "High volume mode", "Reconciliation of a batch", "Batch visible"). The worker has 1 processing path, the batch. #60 measured the candidate architectures on 100 submissions with the real models ([research note](../research/bulk-architectures-runs-2026-10-26.md)) and chose C, 1 judgment for each group, at a batch size of 10: 7.6 s and $0.047 for each change request, and 104 right ends of 117, against 17.3 s, $0.040 to $0.045 and 100 to 104 right on the path of 1 request at a time. The idea: requests on 1 subject are judged together in 1 model call, so the call sees their overlap, and requests on different subjects do not depend on each other, so their groups run side by side.

**When a batch starts.** The worker starts a batch when the front of the queue holds `batchSize` (10) submissions, or when the oldest queued submission has waited `waitMs` (60 s), whichever comes first. A row of another kind at the front of the queue (an operator edit, a repair) runs alone first, so the order rules of the kinds hold. The operator can start a batch at once on the Operation page, with the submissions that are queued, and stops the worker with the queue pause.

**A batch, step by step.**

1. **Open.** The worker takes up to `batchSize` queued submissions in queue order and marks them `running`. It makes an empty staging set, a set of tables next to the wiki tables in the same database, and the batch remembers the `seq` of the wiki at its start.
2. **The head of each request.** Each request runs the claim check Q7, the gather and the scope match Q1 of the pipeline, side by side across the batch. These steps read the live wiki only. A request that Q7 ends (unsupported) is done. A request that Q7 splits writes its split to the staging set, and its children wait for step 6.
3. **Group.** Code puts the other requests into groups, with no model call: 2 requests join 1 group when the cosine distance of the embeddings of their 2 changes is under the cut `groupCut` (0.215, from #60). A group is a connected set of such links, in queue order.
4. **Judge each group.** 1 call (the group question QG) judges all the claims of 1 group: their verdicts, the target of each, and the draft of each fact to write. A later claim is judged against the facts that the earlier claims of the group produce. Code writes the answers in queue order through the lint and the write step of the pipeline to the staging set, 1 change for each claim. The groups run side by side. A request whose scope holds 2 or more live facts does not join a group, because the group call does no merge: it waits for step 8.
5. **Stale check, in code.** Each request records the `seq` of the live wiki at its gather. When it comes to write, and another writer has changed a fact of its change set or of its scope after that `seq`, or another group of the batch has staged a change to it, the write is refused, and the request waits for step 8.
6. **The children.** After the last group, the children of the splits of step 2 run steps 2 to 5 as a second round of the same batch, grouped against each other. A child is never split again.
7. **Reconcile, then promote.** Two groups can each write a new fact in 1 scope, because the groups do not see each other. So each fact that the batch staged gets the duplicate fact repair of the cleanup ([Duplicate fact](cleanup.md#duplicate-fact)) against its 3 nearest facts that another group of the batch staged: Q1, then the merge with the guard of Q2. A pair inside 1 group gets no check, because the group call saw both claims. A pair with a fact from before the batch gets no check, because the request read that fact at its own Q1. Then 1 transaction writes the staging set to the live wiki and marks the requests done, as before: a reader sees the wiki before the batch or after it, never half. The prior query check (step 9 of the pipeline) is queued as a lookupRepair request in the same transaction.
8. **The requests that waited.** The requests of a crowded scope (step 4) and the refused writes (step 5) run after the promotion, alone, in queue order, on the live wiki, from the gather on.
9. **Cleanup.** A due check runs after the batch, as after any other request ([Free for submissions](cleanup.md#free-for-submissions)).

**A failed group call.** An answer that fails its schema, or that names a target outside the group, is asked 1 more time. A second failure or a failed call runs the requests of the group 1 at a time, with the full pipeline of 1 request, into the staging set. A failed write runs the rest of the group the same way, from the failed claim on; the earlier writes of the group stay staged. A rate limit drops the batch (below).

**Why it judges as well as 1 at a time.** The group call has the rules of the judgment (Q4) and of the draft (Q5) word for word, and sees every claim of its subject at once, so 2 claims on 1 fact are judged together and not in a race. #60 measured it on the labels: 104 right ends against 100 to 104 for 1 request at a time.

**Stop and crash.** The batch has no table of its own. The start `seq` is a meta key that exists while the staging rows exist. A stop, a rate limit or a crash drops the staging set: the live wiki holds none of its changes, the requests go back to the queue and the work runs again. There is no resume. When the promotion fails because the live wiki moved, the batch is dropped and its requests run 1 at a time, in queue order, before the next batch, so the queue keeps moving.

## How the design meets each requirement

### Consistent result

The worker processes the submissions in batches ([High volume mode](#high-volume-mode)). A batch is staged, reconciled and promoted in 1 transaction, so the wiki is the result of the batches in queue order, and inside a batch the order of the requests does not matter. A row of another kind runs alone, in queue order. A lock file next to the database stops a second worker on the same wiki. The lock holds the process id, and a worker takes over a lock whose process is gone.

### Crash safety

Each change is 1 transaction: the new versions, their references and the index rows. A failure at any point rolls back all of it. So 1 change gives 1 sequence number and 1 state of the wiki.

On restart, the worker puts each running request back in the queue, and the request runs again:

- A run that did not commit left no trace.
- A run that committed a merge and then stopped left a repaired wiki. The run again finds 1 live fact in the scope and skips the merge.
- A crash between the commit and the "done" mark repeats the request. The repeat finds its own fact as a duplicate and writes 1 confirmation event. That is the accepted cost.

### Durable queue

`requestChange` writes the request as a row in the database file of the wiki before it returns. So the death of the service, the worker or the machine does not lose it. A worker that starts takes the queued rows in order. The service does not start again by itself after a crash; until the next logon, no worker runs. The fix is a future supervisor.

### Failed request

An error of the model call or of the API is a failed attempt. The worker puts the request back in the queue, and waits longer after each failure, so that an outage does not use up the attempts in seconds. After a set number of attempts, the request stops as "failed" with its error. The operator puts it back in the queue with a command or from the console.

A failure that a new attempt cannot change, a broken invariant of the code or the store, stops the request as "failed" at its first attempt: the retries would only repeat it.

A rate limit of the model is not a failed attempt (the owner's decision of 2026-10-16). A session limit of the login is a wait, not a fault of the request: every other request would meet it too, so counting it would end a whole queue as `failed` at 1 request per minute. The worker puts the request back in the queue with its attempts unchanged and pauses: 5 minutes the first time, double on each rate-limited call in a row, at most 1 hour, and the first value again after a call succeeds. While it waits it polls nothing and takes no request. Service health shows the worker as paused with the time of the next try.

A fault in the submission is not a failed attempt: it is a rejection with a reason. A draft that fails the lint twice is a failed attempt, because the next attempt can pass.

### Stale fact deleted

A consumer sends a deletion as any other submission. The judgment question finds it: the claim says that the live existing fact is no longer true and gives no new content for its subject. Its relation is then "negates". Code then:

1. writes a deletion version of the fact, with the justification of the submitter,
2. writes no fact for the negated claim, so that stale facts do not build up,
3. ends the request as "accepted".

No draft question runs for a deletion. A claim that also gives new content for the subject is a correction ("different"), and it becomes a new version.

### Negation on return

When the existing fact in the scope is deleted, the judgment question weighs the reason of the deletion against the new observation:

- The claim restates the deleted fact, and its observation is weaker than the reason of the deletion: the relation is "stale". A draft question keeps the header of the fact, and writes 1 sentence that says the claim is no longer true. The new version is live under the same fact id. The request is "accepted". The next consumer then finds the answer.
- The observation is at least as strong: the relation is "same" or "different", and the claim is restored as a new live version.

- The claim says that the deleted fact is no longer true: the relation is "negates". The claim agrees with the wiki, so nothing is written. The request is a "duplicate" of the deletion. It gets no confirmation event, because a deleted fact has confidence 0 and never gets a confirm.

A deleted fact is a duplicate in this one case only. A claim that restates a deleted fact is never a duplicate: it is "stale" or it restores the fact. "Rejected" is only for a request that writes nothing and that the wiki does not already say.

### Question accuracy

Each question has its own labeled test set, and the question test runs each set on each candidate model and effort. A question passes on a set mean and a set floor per run. Every case is in a group: designed by hand, from a rebuilt wiki, or from real use. The runner reports each group apart. The sets grow from real use: the worker logs each question call, a tool harvests a sample, and a labeler writes the expected answer. A labeler is a person or a model of a higher tier, and never copies the observed answer.

A prompt change runs the question test again on each model, because the pool of results starts again for a changed prompt.

### No duplicates

The replay test sends recorded submissions through the whole pipeline, each on a fresh copy of a seed wiki, and checks the result. A duplicate fact and a fact with 2 claims are the 2 costly failures. Any other wrong write is cheap to repair, so the test only reports it.

The pipeline guards against both failures:

- The submission check rejects a compound submission at step 1.
- The scope match puts a claim in the same scope onto the existing fact.
- The judgment question checks the scope match: a sibling scope is "unrelated", and the claim becomes a new fact.
- When the scope match misses, the merge repairs the duplicate on the next request in that scope.

### Known cost

The question test records the price of each question on each model and effort, with its accuracy. From these measurements, a tool computes 3 presets of model and effort per question:

- "budget": the cheapest configuration that passes the bar.
- "standard", the default: the best mean for each classification and judgment question, and the budget rule for each draft question. A wrong classification or judgment writes a duplicate, a compound or a wrong fact. A wrong draft is cheap to correct.
- "premium": the best mean on every question.

The operator picks a preset per wiki, and can set 1 question apart. The code holds no copy of a table: the presets come from the measurement alone.

The worker stores the token counts of each model call in the wiki, with the request and the question of the call. The call for a child of a split that a batch has not promoted yet is stored with the parent of the child, because the child is not in the live queue yet; the cost of the submission stays whole. The console computes the cost in dollars per write from these rows and the price table `config/prices.json` ([console.md](console.md), "Cost"). The log line of a change holds the same counts, but the log rolls, and the cost is a signal over the whole life of the wiki.

### Credentials

The worker calls the model through 1 of 2 transports. With an API key, the worker uses the SDK transport, in every mode. In local mode (1 user, 1 account, 1 machine), a worker with no API key uses the Claude Code login through the CLI transport. The worker records the result of each model call. A credential failure becomes the warning of `requestChange` and the worker state of `listWikis`.

### Request time

The design has no time target. Measured on 2026-10-10: 24 to 35 seconds per request. A new fact runs 3 to 4 model questions in sequence, each with about 1 second of process start, and the judgment runs on a strong model.

The future design has 3 levers, in order of cost:

1. A persistent model connection: the SDK transport has no process start.
2. A cheaper judgment question, at a measured loss of accuracy.
3. Parallel requests. Requests whose gathered facts do not overlap run at once, in groups, with 1 write transaction each. A conflict at write time runs that request again alone. This lever is in [Future](../future.md), with its trigger.

## Who finds and who repairs a failure

No person watches the wiki, and a submitter sends 1 message and is gone. So each kind of failure has an actor that finds it and an actor that repairs it:

- The pipeline finds a failure on a later request that touches the same facts. Example: 2 live facts in 1 scope, which the merge repairs.
- A consumer finds a failure when it acts on a fact and the shared system disagrees. Its correction repairs it.
- The cleanup finds a duplicate fact when its check is due, and code repairs it.
- The code finds a failure of a model call by schema checks and timers. A retry or a new attempt repairs it. A rate limit is found the same way and repaired by time: the worker pauses and tries the same request again, so that a session limit is a wait, not a failed request.
- The operator finds a failure by a command or a test, and repairs it by a command.

The model writes nothing by itself. Code checks each answer, and a wrong answer shows up as a known kind of failure with a known repair.

## How the feature is measured

The tests of this feature, by kind of change. The system-wide rules are in [System evaluation](evaluation.md). The pass bar is in "No duplicates" above.

| Kind of change | Measurement | Why this measurement fits |
| --- | --- | --- |
| The order or the logic of the update steps | The replay test                  | The question test cannot see mistakes that add up between questions. The replay showed a miss rate far above the rate of the question sets.                                                                      |
| The scope match or the draft of a fact     | The replay test, 3 runs          | These steps decide a duplicate or a compound fact, the 2 costly failures. Their misses are random between runs, so 1 run can miss them.                                                                          |

| Data | Why it fits its test |
| --- | --- |
| Recorded submissions with results     | The replay needs whole submissions with an expected end state. Each case runs on a fresh copy of the seed, so 1 miss does not move the next case.                                                                   |

## Decisions

| Decision | Reason |
| --- | --- |
| The replay test runs the whole pipeline. | Mistakes add up between questions. The question sets do not show them. |
| The worker is deterministic code that asks narrow questions. No question has a tool. | Each question answers from the material that code gathered. The same material gives the same answer, and a test can measure it. |
| The submissions run in batches of 10, grouped by subject, with 1 judgment for each group (#60). | 2.3 times as fast as 1 request at a time, at the same accuracy. A group call sees the overlap of the claims of 1 subject. |
| The worker is its own process, 1 per wiki, under a lock. | The worker is 1 global job, and consumers come and go. |
| 1 change is 1 transaction with 1 sequence number. | A crash leaves no partial change. |
| The merge is its own change, before the judgment. | A claim cannot be judged against 2 facts. A crash after the merge leaves a repaired wiki. |
| A judgment and a draft are separate questions in separate steps. | Each question can be measured alone. |
| Code sets each justification. A model never writes one. | The submission is the only evidence that enters the wiki. |
| A deletion is a submission with a "negates" relation, and the worker writes no negated fact. | Stale facts do not build up. |
| A weak restatement of a deleted claim writes its negation as a live version. | The next consumer finds the answer, and the claim does not return. |
| The dependents loop runs before the write, to any depth. | Every fact that rests on a changed fact is checked once, and a crash leaves no trace. |
| The presets come from measurement. The default follows the cost of a wrong answer. | A wrong judgment is costly to repair, and a wrong draft is cheap. |
| No question is strict in the pass bar. | The merge repairs a duplicate, and the submission check stops a compound. |
| The worker stores the token counts of each model call in the wiki. | The cost signal of the console covers the whole life of the wiki, and the log rolls. |

## Open points

- "Request time" has no target. The requirement row is "To do".
- "Durable queue": after the death of the service, nothing starts it again until the next logon. The supervisor is a future feature ([deployment.md](deployment.md)).
- "Negation on return": the replay has no case with 2 submissions in a row. The case for a return starts from a seed that already holds the deleted fact. A replay with a list of requests per case is a future feature.
- "Question accuracy" and "No duplicates": the evals run by hand, and a failed bar does not block a ship.
- "Question accuracy": when no configuration passes the bar of a question, the preset takes the best one and flags it. The requirement then fails for that question, and the sources give no further design for this case.
