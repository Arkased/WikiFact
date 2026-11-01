# System evaluation

Requirements layer. The design is in [../design/evaluation.md](../design/evaluation.md).

User: developer. The operator uses 1 test, the benefit test, on their own system. The roles are defined in [README.md](README.md#roles).

## Goal

Before a change ships, the developer runs every eval with 1 command. The developer and the operator each run the benefit test on their own system, and see whether their agents are right more often, and cheaper, with the wiki than without it. The test of each feature is in the files of that feature.

## Use cases

1. The operator runs the benefit test against their own wiki, with their own repo, their own questions and their own tasks, and reads the right answers and the cost per question, and the tasks done and the cost per task, with the wiki and without it.

## Requirements

| Name | Contract | Proof today | Gap |
|---|---|---|---|
| Benefit measured | 1 command runs the same repo questions and repo tasks through 2 agents, 1 with the wiki and 1 without it, and nothing else differs between them. The questions vary in type and in complexity, and a task is real work on the repo, such as a bug fix. It reports, for each of the 2: the share of right answers, the share of tasks done, and the tokens and the dollars per question and per task. Each share and each difference between the 2 has a 95% interval, and a difference counts only when its interval does not hold 0 (the owner, 2026-10-30). It takes any wiki, any repo and any case file, so an operator runs it on their own system. Every case runs on a mature wiki: a copy preloaded by earlier rounds of the same agents, with their change requests processed (the owner, 2026-10-20 and 2026-10-30). | The requirement test. Eval: the benefit test. | Built. The first run (192 runs) is in [research/benefit-first-run-2026-10-20.md](../research/benefit-first-run-2026-10-20.md): with the wiki, the agents were right less often than without it in every group (the held questions are the closest: 79% against 83%), and cost less per run only there. That run stored no answer text, so its 22 disagreements were reviewed from the judge's reasons, not re-judged; a second run with the answers stored is open. |
| Eval order | 1 command runs every eval, each after the evals that it needs, and stops at the first failure. | The requirement test. | None |

## Out of scope

- A test of the read weight in confidence. It waits for a correction run whose tasks carry no observation ([future.md](../future.md)).
