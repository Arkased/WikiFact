# Question tuning

Design layer. The requirements are in [../requirements/questions.md](../requirements/questions.md). The technical details are in [../technical/questions.md](../technical/questions.md).

## Approach

The update worker asks a model narrow questions. Each question has a fixed prompt and a structured answer, so each question can be measured alone. 1 question gives a wrong answer: the question test measures each question on its own labeled set. The other tests of the wiki are in [System evaluation](evaluation.md).

The model and the effort level of each question come from the measurements, as presets. The test sets grow from real use: the worker records each model call, and the developer labels real cases and adds them to the sets.

## The test data

| Data                                  | Why it fits its test                                                                                                                                                                                               |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1 labeled set for each question       | A narrow question has 1 correct answer for 1 input. A label is a judgment against the rule of the question. Cases from real use show inputs that the developer did not foresee.                                    |
| The dogfood wiki                       | Its consumers are real agents on a real repo. It makes the real inputs of the question sets.                                                                                                                       |
| The call log of the worker             | It holds the exact input, context and output of each real model call. The harvest tool reads cases from it.                                                                                                        |

## How the design meets each requirement

### Presets from measurements

The question test records the accuracy and the price of each question on each configuration. The summary mode reads all the result files and writes 2 files:

1. A summary file, which holds the measurements and the pass bars.
2. The presets file, which holds the model and the effort of each question, and the name of its summary file. It holds no measurement.

The presets file is the default model configuration. The code holds no copy of a preset table. A missing file or a missing question is an error at start. The presets file ships with the build, so a new measurement reaches every wiki at its next start.

There are 3 presets. The rule of each follows the cost of a wrong answer:

| Preset     | Rule                                                                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `budget`   | The cheapest configuration that passes the bar. When none passes, the best one, with a flag.                                                                  |
| `standard` | The best mean for the classification and the judgment questions. The budget rule for the drafting questions. The default.                                     |
| `premium`  | The best mean on every question.                                                                                                                              |

A wrong classification or judgment writes a duplicate, leaves a compound fact, or accepts a wrong claim. Its repair waits for a later request. A wrong draft is text that is a little off, and the next correction fixes it. The kind of each question is a field of its spec, the 1 source for the runner and the summary.

The question bar alone does not set the default. On the budget table, the replay found critical misses in a far larger share of cases than the question sets showed. The pipeline gives a question more material than its set, and the misses add up.

### Current prompt only

Each result entry records a hash of the prompt and the output schema of its question. The summary pools only the entries whose hash equals the hash of the current code. So a change to the text of a question starts its pool again, and no hand edit of a result file is necessary.

The pool joins all the runs of 1 configuration on the current text. The mean, the groups, the kinds and the pass rate of each case are pooled over all the runs. The scores of the held-out half and of the tuning half are pooled over the runs that hold the split, and the summary shows the count of these runs. So a summary never shows a held-out score without the number of runs behind it. A tie in 1 run is broken by the runs before it.

### Call record

A worker with a log folder writes 1 line for each question call to its call log. The line holds the request, the question, the model, the effort, the exact input, the context and the output. The call log has its own retention, larger than the other logs, so it keeps several thousand requests. See [deployment.md](deployment.md), "Log space".

### Unlabeled harvest

The harvest tool reads the call lines of 1 question from the call logs, current and rolled. It drops a line whose input is the same as an earlier line, or the same as a case in the set. It takes a random sample and writes it to a harvest file.

A harvested case holds the input in the short form of the set, the context, and the answer of the model as "observed". It holds no expected answer. A label is a judgment against the rule of the question, not a copy of what the model said.

A labeler writes the expected answer and moves the case into the set. The labeler is a person, or a model of a higher tier than the observed model. A case where the labeler is not sure goes into the set with the note "unclear".

### Groups by source

Each case of a set belongs to 1 group:

- `designed`: written by hand. This is the group when the case names none.
- `normal use`: built from a rebuilt wiki.
- `real use`: from a real request of a running wiki.

The runner reports the accuracy of each group of each configuration apart, next to the mean. The pass bar applies to the whole set. The groups show where a model fails. On October 14, 2026, the real-use cases were harder than the designed ones: on Q7, every model scored near the top on the designed cases and much lower on the real-use cases.

### Real-use cases

The sets grow from the dogfood wiki `wikifact`. Agents that work on the repo search it and send what they find. The worker records each call, the developer harvests and labels the cases, and the cases join the sets.

The sets of Q1, Q4, Q5 and Q7 hold real-use cases since October 14, 2026. The other sets hold none, so the requirement is partly met.

### Held-out part

The rule:

1. Grow the set first, with cases from real use.
2. Split the set into a part for tuning and a part kept apart.
3. Keep a prompt change only when the score of the part kept apart does not drop.

The reason: the sets are small, so a further prompt change risks a fit to the set.

The split: a case of a set file holds the optional field `heldOut`. The held-out half is the cases with an even number, so the split is fixed before any score is read, and both groups of source are in it in the same share. The runner reports the score of each half next to the mean. The sets of the claim check (Q7) and of the draft (Q5) are split. The other sets get the field when a prompt change of their question starts.

When a set has a held-out part and its cases name a `family` (below), the cases of 1 family stay on the side of the case of that family with the lowest number. 2 cases of 1 family share most of their text, so a split of a family puts the same test on both sides.

### Hard negatives

A hard negative is a case where 2 facts look the same, but are not the same fact, or do not say the same thing. Q1 (the scope match) and Q4 (the relation of a claim to a fact) decide the merges, and a wrong merge loses a fact. So their sets hold at least 5 cases of each kind:

| Kind | Example |
| --- | --- |
| Negation | "The worker retries a failed request" and "The worker does not retry a failed request". |
| Changed value | "The cap is 20 repairs" and "The cap is 30 repairs". |
| Supersession | A fact with the old value, and a claim that names the new value and says that it replaces the old one. |
| Scope difference | The same attribute of 2 different subjects, for example the interval of 2 different finders. |

The expected answer of a case follows the rule of its question; the kind only names the trap. Each such case names its kind and its family (the cases built from 1 pair of facts). New cases come from real facts of the dogfood wiki where they exist.

The runner reports the accuracy of each kind next to the groups, and a 95% interval of each score. The sets hold 20 to 80 cases, so 1 miss moves a score by 1 to 5 points. The interval shows when a difference between 2 scores is smaller than the error of the set.

## How the feature is measured

The kinds of change that the question test covers. The data is in "The test data" above.

| Kind of change | Measurement | Why this measurement fits |
| --- | --- | --- |
| The text of a question                     | The question test of it          | The text changes only that question. Its set measures it alone, on each model, fast and at low cost.                                                                                                             |
| The model or the effort of a question      | The question test, then presets  | The accuracy and the price of the new choice are new measurements. The presets come from the summary of all measurements, never from a hand edit.                                                                 |

## Measurement rules

These rules hold for the question test, beside the rules of every eval in [evaluation.md](evaluation.md#measurement-rules):

- A miss is first a label review, because a person or a model wrote the label without a model run.
- A question with no preset yet starts on the cheapest candidate, so it can be measured before its first summary.

## Decisions

| Decision                                                                       | Reason                                                                                                                         |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Each question has its own labeled set.                                         | A narrow question can be measured alone, and its model can be chosen for it.                                                   |
| The default preset is `standard`, not `budget`.                                | The replay found critical misses on the budget table that the question sets did not show.                                       |
| The preset rule follows the cost of a wrong answer.                            | A wrong classification or judgment is costly to repair. A wrong draft is cheap to correct.                                     |
| There is no economy preset.                                                    | An economy bar differed from the budget bar on 1 question alone.                                                                |
| The presets come only from the summary.                                         | A hand edit would hold numbers that no measurement supports.                                                                    |
| The summary pools only the runs of the current prompt.                          | A pool that mixed runs of old prompts with new ones gave wrong presets.                                                          |
| The call lines go to their own log.                                             | They are large, and they feed the test sets.                                                                                   |
| A harvested case has no label until a labeler writes it.                         | A copy of the answer of the model would measure the model against itself.                                                      |
| The runner reports each group apart.                                            | Real-use cases are harder than designed ones, and a mean hides that.                                                            |
| The real-use cases of October 14, 2026 changed the presets.                     | Those cases showed misses that the designed cases did not show.                                                                 |

## Open points

- Held-out part: built for the set of Q7 only: its even-numbered cases are kept apart, and the runner reports the score of each half. The other sets have no split yet.
- Real-use cases: only the sets of Q1, Q4, Q5 and Q7 hold real-use cases. The other sets hold none.
- The dogfood wiki needs real submissions on each day that agents work on the repo. This is a habit of work, so no test proves it. The console rates show it.
- The first real-use cases showed that consumers send compound claims, and no consumer reads the rejection. The split of a compound submission is built since October 15, 2026 ([submit.md](submit.md)); the first fill after it shows how many children are still rejected as compound.
