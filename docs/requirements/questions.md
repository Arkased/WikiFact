# Question tuning

Requirements layer. The design is in [../design/questions.md](../design/questions.md).

User: the developer who changes a prompt or a model. The roles are defined in [README.md](README.md#roles).

## Goal

Before a prompt or a model of a model question changes, the developer knows with numbers that the change does not make that question worse, and what it costs. The kinds of change that this feature serves are the text of a question, and the model or the effort of a question.

## Use cases

1. Measure each model question on each model and effort level, for its accuracy and its cost.
2. Choose the model of each question from the measurements: the presets.
3. Take real cases from the record of model calls and add them to the tests.

Test data:

4. Grow the test cases of each question from real use: take the inputs of real model calls from the dogfood wiki `wikifact`, label the correct answer, and add them to the set.
5. Fill the dogfood wiki with real facts, so that it makes real inputs: agents that work on the repo search it and send what they find.
6. See, for each test set, how many cases it has and where they come from: written by hand, built from a rebuilt wiki, or taken from real use.
7. Keep a part of each set apart for the check of a prompt change, so that a prompt is not fitted to the cases that it is tested on.

The test data today:

| Data                                                                          | Used by                  | Size                                                                               | Source                                                                |
| ----------------------------------------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 1 set of cases for each model question                                        | The question test        | 20 to 33 cases for each question                                                   | Written by hand, some from a rebuilt wiki. No case from real use yet. |
| The dogfood wiki `wikifact`                                                   | The source of real cases | About 94 facts before the fill of 2026-10-14; about 105 submissions from that fill | Agents that work on the repo                                          |
| The record of model calls of the worker                                       | The harvest tool         | 1 line per model call, up to about 5,000 requests                                  | The running worker                                                    |

## Requirements

| Name                      | Contract                                                                                                                             | Proof today                                                                                                                                                        | Gap                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Presets from measurements | The presets file is the output of the summary of the measurements. | The requirement test. | None |
| Current prompt only | A measurement counts only for the current text of the question. A change to the text starts the count again. | The requirement test. | None |
| Call record | The worker keeps a record of the input, the context and the output of each model call, so that real cases can go into the test sets. | The requirement test. | None |
| Unlabeled harvest | A case from real use has no expected answer until the developer labels it. | The requirement test. | None |
| Groups by source | Each test case belongs to a group by its source, and the test reports the score of each group apart. | The requirement test. | None |
| Real-use cases | Each question set holds cases from real use. | To do in the requirement test. | Partly met: the sets of Q1, Q4, Q5 and Q7 hold real-use cases since October 14, 2026. The other sets hold none, so a test of the contract fails today. |
| Hard negatives | The sets of Q1 and Q4 hold at least 5 cases of each kind of hard negative: negation, changed value, supersession and scope difference. The test reports the score of each kind, and a 95% interval of each score. | The requirement test. | None |
| Held-out part | Each question set has a part that is kept apart. A prompt change is kept only when the score of that part does not drop. | To do in the requirement test. | Partly built: the set of Q7 has the held-out half. The other sets have none. |

## Open points

- The dogfood wiki needs real submissions on each day that agents work on the repo. This is a habit of work, not a contract of the code, so it has no test. The console rates show it.
- The first real-use cases (October 14, 2026: 30 each for Q1, Q4, Q5 and Q7) showed that the consumers sent compound claims: 46 of 105 submissions were rejected as compound, the claim check was right on them, and no consumer read the rejection.
