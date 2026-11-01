# Submit a change

Design layer. The requirements are in [../requirements/submit.md](../requirements/submit.md). The technical details are in [../technical/submit.md](../technical/submit.md).

## Approach

A consumer tells the wiki what it saw, and the wiki does the rest. The consumer does not write the fact, does not find the fact to change, and does not shape the wiki. As a user who files a bug report does not fix the bug, the submitter sends 1 message and goes on with its work.

The call puts the request in a durable queue and returns at once. The update worker applies the request later ([updates.md](updates.md)). The first step of the worker is a cheap check of the submission itself. A submission that fails the check is rejected with a reason before any costly step.

## How the design meets each requirement

### One call

A submission is 1 call of `requestChange` with 2 text fields:

- the change: what the consumer saw, in free text,
- the justification: how the consumer knows it, in prose, with no fact ids.

2 fields are optional:

- the targets: fact ids that the change is about,
- the prior query: the search text that the consumer ran and that did not find the fact.

The submitter writes no header and no fact id. The worker finds the facts that the change touches. A low cost per correction is 1 of the 3 levers that the wiki has over a consumer (see "Correction duty").

### Queue position

The call writes 1 row to the queue and returns at once. The answer holds the request id, the place of the request in the queue, and an estimated wait in seconds.

The answer also holds a warning when the worker cannot process the request: no worker has run on the wiki, the last model call failed on its credential, or the last calls failed again and again. The warning names the condition and its start time. The request is queued in every case, so the consumer can tell the user and go on.

### Bad input refused

The call checks the input before it queues anything:

- A field of only spaces counts as empty. An empty change or justification is a tool error.
- Each target id must be a fact. An unknown id is a tool error.

So the consumer learns of the fault at once, and no request with a bad field enters the queue.

### One claim, No beliefs

The first step of the worker is the submission check: 1 model question that reads only the change and the justification. It needs no material from the wiki, so it runs before any costly step. It answers 3 things:

1. Is the change 1 claim that a reader can act on alone?
2. When it holds 2 claims or more, what are they, each written to stand alone?
3. What support does the justification give: a first-hand observation, a second-hand report, or a belief?

The worker acts on the answer:

- 2 claims or more, with an observation or a report: the request is split. The worker queues 1 new request per claim, with the justification, the targets and the prior query of the submission, and ends the submission as "split". The consumer sends nothing again. Each new request (a child) goes through the whole process alone, so a claim that the justification does not support is rejected on its own, and the others land.
- A belief or an inference: the request ends as "rejected" with the reason "unsupported". The worker cannot repair a belief, so it does not split one.
- A change that no reader can act on alone and that does not hold 2 claims (a pronoun with no antecedent, half of a claim): the request ends as "rejected" with the reason "compound", as the consumer must write the claim again.
- A child is never split again. When the check finds a child still compound, the child ends as "rejected" with the reason "compound". So a split makes at most 1 level of requests and cannot loop.
- An observation or a report with 1 claim: the request continues. Hearsay is a report. The judgment step weighs it later against the wiki.

A fault in the submission is a rejection with a reason, never a failed attempt. A retry of a fault costs model calls and gives the same result. The first wiki showed the cost of a late check: a compound submission ran 3 attempts of the full pipeline and then failed.

A claim with its own condition is 1 claim. The question test of the claim check holds compound cases that it must split into the right claims, and single claims with context that it must pass.

The test "one part could be true and the other false" holds for any 2 parts, so alone it splits single claims ([research note](../research/claim-check-cases-2026-10-22.md), #21). The check uses 2 more rules:

1. **A reason or a consequence is part of the claim.** A clause after "because", "since" or "so" says why the claim holds, or what follows from it. A reader does not correct it apart.
2. **The configuration, the scope or the key of an attribute is part of it.** 2 attributes of 1 subject are 1 claim when the second gives the first its configuration, its scope or its key: a model and its effort, a table and its primary key, a decision and its scope. They are 2 claims when a reader would look up each one alone: "hostile" and "spawns at night".
A third rule was tried and is not used: "a list is 1 claim only when it holds 1 measure". It raised the tuning half and lowered the held-out half at both efforts (92.8 and 91.5 percent, against 94.1 and 92.8 percent with 2 rules), so it fit the set, not the rule.

The answer of the check gives its reason before its verdict, so that the verdict follows from the reason. A rule stays only when the held-out half of the question set does not drop (see "Held-out part" in [questions.md](questions.md)).

### Rejection reason

The worker stores the outcome and the reason on the request. `getRequest` returns the status, the outcome and the error text of the request. For a rejection by the submission check, the error text is the reason of the check. The consumer reads it and sends again, 1 claim per request. For a split, `getRequest` returns the outcome "split" and the ids of the child requests, and each child has its own outcome.

### Missed search repaired

The prior query says that a search did not find the fact. After the change is written, the worker makes sure that the same search finds it:

1. The worker runs the consumer search for the prior query on the new state of the wiki.
2. When the relevant fact is in the results, it stops.
3. When it is not, the worker queues a repair request for that fact and that query.
4. The repair request writes an equivalence fact ("skellies are skeletons") that references the relevant fact.
5. When a repair request still does not find the fact, the worker logs it and stops, so that a search that no fact can satisfy does not loop.

The relevant fact is the fact of the claim for an accepted change, and the existing fact for a duplicate. A rejection has no relevant fact, so the check does not run. The check runs after the change is written. A failure in the check is logged, and the change of the submitter stays.

### When to submit

The server instructions that carry the search trigger ([lookup.md](lookup.md), "When to search") also carry the submit trigger: when you observe something about the subject that the wiki does not have or gets wrong, send it with `requestChange` before you finish your task, with what you saw and how you know. The instructions reach the consumer at the start of its session, before it reads any tool text. The tool text of the read tools (`search`, `getFact`) ends with the same sentence, so the duty is said in the same words at the moment of the read.

A subagent gets no server instructions, so the duty also travels in the tool results: a tool result reaches every agent that calls. The result of `search` and of `getFact` carries a `note` with 1 fixed sentence: before you finish, send what you observed that the wiki lacks or gets wrong with `requestChange`, one claim per request, with how you know. A `search` with no result carries a second sentence instead: when you find the answer elsewhere, send it, so the next agent finds it here. The tools `search`, `getFact` and `requestChange` are also marked as always loaded, so the client shows their text from the start.

The text alone does not make an agent submit. In the usage tests of 2026-10-29, 0 of 10 agents sent a change request: 3 saw a gap, and 1 repeated a stale fact as current. The duty line in the context hook of [When to search](lookup.md#when-to-search) changed nothing ([research](../research/agent-usage-2026-10-29.md)). So the duty is asked at the end of the task, when the agent knows what it found. A `SubagentStop` hook reads the transcript of the subagent that stops. A subagent does 1 task, so its transcript is the task. The main session gets no such hook: `Stop` fires at the end of each turn, and its transcript marks no clear end of a turn, because skill loads, system reminders and compaction summaries are user entries too. The main session keeps the duty line of the context hook. The hook blocks when:

1. The transcript holds a call of `search` of the wiki, and no call of `requestChange`.
2. The input has `stop_hook_active` false, so the hook blocks 1 stop only.

When both are true, the hook blocks the stop with this reason: "You searched the `<name>` wiki. Compare the facts it listed with what you found in the files. If the wiki lacked or got wrong something that you saw, send it now with `requestChange`: what you saw, and how you know. Else stop." Else the hook lets the agent stop.

A background subagent of Claude Code ends with its report tool `SubagentHandback`, and `SubagentStop` fires after the report: the agent runs no more turns, so the block comes too late (the stop hook test, [research](../research/agent-usage-2026-10-29.md)). So the same check also runs as a `PreToolUse` hook on `SubagentHandback`. It denies the call of the report tool when rule 1 holds and the transcript holds no earlier call of the report tool. A denied call is still an assistant entry in the transcript, so only the first call can be denied, whatever shape the client gives the denial. The reason of the denial: "You searched the `<name>` wiki. Compare the facts it listed with what you found in the files. If the wiki lacked or got wrong something that you saw, send it now with `requestChange`: what you saw, and how you know. Then call `SubagentHandback` again with your report." The agent then sends its requests and calls the report tool again, and the second call passes. The hook reads the wiki name from the config key `wiki.name`, does nothing when the key is null, and is in the WikiFact plugin of this repo with the context hook ([Consumer plugin](publication.md#consumer-plugin)).

## Correction duty

A wrong fact leaves the wiki only when a consumer that sees a contradiction sends a correction. The confidence of a fact assumes the same. A lazy consumer breaks both. The wiki has 3 levers over a consumer:

- The tool text of the read tools states the duty in the words of the result note: before you finish your task, send what you observed that the wiki lacks or gets wrong.
- A correction costs 1 call with 2 free-text fields and no target.
- A search returns a short list, so the consumer can check each result.

More enforcement lives in the harness of the consumer: the stop hook of [When to submit](#when-to-submit). The correction test measures the duty with and without such a hook.

## How the feature is measured

The test of this feature. The system-wide rules are in [System evaluation](evaluation.md). The test has no bar: it reports the count of corrections that consumers send.

| Kind of change | Measurement | Why this measurement fits |
| --- | --- | --- |
| The tool text that the consumer reads      | The correction test              | The tool text is the only lever over a consumer at the time of the read. Only an agent run shows if consumers send corrections.                                                                                  |

| Data | Why it fits its test |
| --- | --- |
| 50 facts, some of them wrong, 20 tasks | A wrong fact that a task touches is the case where a consumer must send a correction. The count of corrections is the result.                                                                                    |

## Decisions

| Decision | Reason |
| --- | --- |
| The submitter sends what it saw, not the fact. | The consumer pays 1 message. The worker finds the facts and shapes the wiki. |
| The call queues the request and returns at once. | Consumers do not wait and do not coordinate. |
| Input faults are tool errors at the call. | The consumer learns at once, and the queue holds no bad request. |
| The submission check runs first, before any costly step. | A check that needs no other step costs 1 call. A late check cost 3 full attempts. |
| A compound submission is split at the first step, not late in the pipeline. | The check costs 1 call and finds the claims. The old path, a lint and a split late in the pipeline, cost 3 attempts and failed. The rejection that came after it lost the claims of every consumer that never read it (46 of 105 submissions in the fill of October 14, 2026). |
| A child is never split again. | A split cannot loop. A child that is still compound is rejected, as the claim list of the check was wrong. |
| A belief is rejected. | Only an observation is evidence about the shared system. The worker cannot repair a belief. |
| Every submission is judged alone. | The design keeps no link from a rejected claim to a later submission of it. Repeat detection is a future feature. |
| The worker repairs a missed search after the change. | The next consumer with the same words then finds the fact. |

## Future

These wait for a trigger, and are not built:

- A length cap on a submission. The trigger: a very long change or justification arrives and is judged in full at model cost. The design: a token cap on both fields at the call, with a tool error over it, the same cap as the search query.
- Detection of repeat submissions. The trigger: a rejected claim comes back from a second submitter. The design: the worker keeps an embedding of each change text and finds past requests of the same claim. A claim that was rejected as "unsupported" is accepted on a second independent observation. A claim that was rejected as "contradicted" is weighed again against the fact that won: 2 new observations beat a 1-time observation, and a repeatable check wins until a submitter reports that it fails.

## Open points

- The contract of `requestChange` in the technical design of today returns the request id, the status and a warning. It does not show the queue position and the estimated wait. A later decision added them. The sources do not say how the wait is estimated.
- The contract of `getRequest` in the technical design of today returns the status, the outcome, the error, the attempts and the finish time. A later decision added the id of the duplicate fact and the ids of the written facts. The contract does not show them.
- For a rejection by the judgment step ("unsupported" or "contradicted" after the claim check), the sources do not say that the reason reaches the error text that `getRequest` returns. The requirement "Rejection reason" covers every rejection.
- None of the 5 fill agents of 2026-10-14 called `getRequest`. In that fill, 46 of 105 submissions were rejected as compound, and no consumer read a rejection. The requirements file proposes to keep `getRequest`, and the split of a compound submission removes most of those rejections.
- A target id is refused at the call when it is not a fact. The gather step of the worker also drops an id that does not exist, with a log line. The sources do not say when the second case can occur.
