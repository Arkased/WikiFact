# System evaluation

Design layer. The requirements are in [../requirements/evaluation.md](../requirements/evaluation.md). The technical details are in [../technical/evaluation.md](../technical/evaluation.md).

## Approach

System-wide evaluation answers one question: is an agent on the repo right more often, and cheaper, with the wiki than without it? The benefit test answers it, for the developer and for the operator on their own system. 1 command runs every eval, in an order that its code holds. The rules of measurement hold for every eval. Each feature measures itself in its own files: [Question tuning](questions.md#how-the-feature-is-measured) for the question test, [Process submissions](updates.md#how-the-feature-is-measured) for the replay test, [Look up facts](lookup.md#how-the-feature-is-measured) for the relevance test and the speed test, and [Submit a change](submit.md#how-the-feature-is-measured) for the correction test.

## How the design meets each requirement

### Eval order

1 command runs all the evals. The order and the dependencies live in the code of that command, not in the commands that a user types. The order is: the question test, the relevance test, the replay test, the correction test. The speed test runs beside the question test, because it makes no model call.

The reasons for the order:

- The replay test and the correction test read the model choice that the question sets produce.
- The relevance test and the replay test both load the embedding model, so they do not overlap.

The command stops at the first failed test. It writes 1 index file for each run, which points at the result file of each test. The developer can run 1 test alone, or skip a test.

## The benefit test

The test answers 1 question: is an agent on the repo right more often, and cheaper, with the wiki than without it?

**How it runs.** Each repo question runs twice, with the same model, the same checkout of the repo, the same file tools and the same prompt. The first run has the wiki tools. The second run has no wiki tools. Nothing else differs. The agent gets no instruction about the wiki in either run, because the test measures the wiki and not an instruction.

**The wiki it reads.** The run with the wiki reads a copy of a wiki, served by its own server. So the test writes nothing into the live wiki and counts in none of its signals. The checkout is the commit of the fill, so the facts and the files agree. The developer runs it on the dogfood wiki and this repo. An operator runs it on their own wiki, their own repo and their own question file: the command takes all 3 as arguments.

**A mature wiki (the owner, October 20, 2026).** The benefit of a wiki shows when the wiki is mature, not after 1 fill. So the held and stale questions run on a copy that is preloaded: before the measured runs, the arm with the wiki runs the question set several rounds, and the worker of the copy processes the change requests of each round before the next one starts. The preload stops after a round in which the worker accepts no change, or after 3 rounds. A round asks only the questions of the preload, so its changes are on their subjects. The measured runs then read that mature copy, and a stale case gets its wrong fact after the preload, so the test asks whether the agent catches a wrong fact in a mature wiki. Every measured run reads the preloaded copy: the gap questions and the tasks too (the owner, 2026-10-30: "we really only care about the former"). A result without the preload is not a result of the benefit test. The report says after how many rounds the preload stopped.

**The cases.** 2 kinds: 24 questions and 8 tasks (the owner, October 19, 2026: questions alone do not show the effect on real work, and the questions must vary in type and in complexity).

**The questions.** 24 questions in 3 groups of 8. Each question is 1 sentence that an agent on the repo asks. Each has a labeled answer, the terms that a right answer must contain, and the file and line that prove the label. Each group of 8 has 2 questions of each type, and in each type 1 simple and 1 complex question:

| Type | Asks | Example |
|---|---|---|
| Locate | Where something is | Which function decides that a request failed? |
| Explain | How something works | How does a read link to its search? |
| Rationale | Why something is so | Why does an operator edit go through the queue? |
| Behavior | What happens in a case | What does the worker do after a rate limit? |

A simple question has its answer in 1 fact or 1 file. A complex question needs 2 or more facts or files, joined.

**The tasks.** 8 tasks: 4 bug fixes, 2 small features, and 2 changes that need the code and its doc together. Each task is a short issue text, as a developer writes it, on the checkout of the fill commit. A bug fix starts from a patch that the test applies first: the patch puts a known bug into the code. A feature starts from the checkout as it is. Each task has a hidden test, which the agent does not see: the test copies it in after the run, and the task is done when the hidden test and the type check pass. A model judge then reads the diff against the reference change, and says right, partly right or wrong, so that a fix that passes the test by a hack does not count. 6 tasks are in an area that the wiki describes right. 2 tasks are in an area where the test writes a wrong fact first, as in the "stale" group. A task measures what a question cannot: whether the wiki makes the agent find the right place sooner, change less by mistake, and spend fewer tokens on the whole job.

| Group | The wiki has | A right result with the wiki |
|---|---|---|
| Held | A fact that answers the question | Right, and cheaper: 1 search and 1 read in place of file reads |
| Gap | No fact for it | Right, at about the same cost. The extra cost is 1 search with no use. |
| Stale | A fact that is wrong, on purpose | Right only when the agent checks the files. This group measures the risk of a wrong fact. |

The test writes the wrong facts of the "stale" group into the copy before the runs. The first questions come from the 7 that agents asked on October 16, 2026 ([research](../research/agent-usage-2026-10-16.md)).

**How an answer is judged.** Twice. First by the terms it must contain. Second by 1 model question that sees the labeled answer and the proof, and says right, partly right or wrong. When the 2 judges disagree, the label is reviewed first.

**How the cost is measured.** Claude Code headless reports the tokens (input, output, cache read, cache write), the dollars, the turns and each tool call of a run. The test reads them from that report. The tokens show what the wiki costs (its tool definitions in every turn, the search results) and what it saves (the file reads).

**Repeats.** An agent run varies. The runs of 2026-10-27 measured the noise: the arm without the wiki moved by 4 runs in a cell of 24 between 2 runs with the same input. 3 runs of each case cannot show a difference of that size. So each question and each task runs 10 times in each arm: 480 question runs and 160 task runs, all at 1 commit in 1 result file.

**The interval.** For each cell, the report gives the share right with a 95% Wilson interval, and the difference between the arms with a 95% Newcombe interval. For the dollars, it gives the difference of the means with a 95% interval. A difference counts only when its interval does not hold 0. Otherwise the result is "no difference", and no conclusion is drawn from it (the owner, 2026-10-30: "if theres a major delta in two runs then you cannot be drawing concuslions from it").

**The bar.** The first runs have no bar. They set it. After them, the bar on the "held" group is: with the wiki, the share of right answers is not lower by a difference that counts, and the cost per question is lower by a difference that counts. The bar on the tasks in a right area is the same: the share of tasks done is not lower by a difference that counts, and the cost per task is lower by a difference that counts. The report gives each result per type and per complexity too, so that a gain on simple questions cannot hide a loss on complex ones.

## Measurement rules

These rules hold for every eval:

- An eval writes a result file with a timestamp, and flushes partial results during the run. A print to the terminal alone is not a result.
- Independent model calls run in parallel, under a limit.
- A run can resume. A new model runs alone and merges into the earlier results.
- An eval starts its server from the source, never from the build output.

## Decisions

| Decision                                                                       | Reason                                                                                                                         |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| 1 command runs all the evals, with the order in code.                           | The replay and the correction test read the output of the question sets.                                                       |
| The benefit test runs 2 arms on a copy of the dogfood wiki, with no instruction about the wiki. | The benefit is the difference between the arms, so the arms must differ in the wiki alone. A copy keeps the runs out of the live signals. An instruction would measure the instruction, not the wiki. Spec of October 18, 2026. |

## Open points

- Settled: the tests are in the eval order of the command ([Eval order](#eval-order)). The technical file of each feature names its tests ([Test plan](../technical/evaluation.md#test-plan)).
