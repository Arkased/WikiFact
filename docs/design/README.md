# Design

The second of the 3 layers of the docs ([../requirements/README.md](../requirements/README.md)). For each feature, this layer says how the system meets each requirement, and why it does it that way. It holds no schema, no constant value and no code path: those are in the technical layer.

Each file has the name of its requirements file. In a file:

- "Approach" gives the idea of the feature in a few sentences.
- "How the design meets each requirement" has 1 section per requirement, under the name of the requirement.
- "Decisions" lists each choice with its reason, so that a later change can see what it would undo.

## Principles

These hold for every feature.

| Principle | Reason |
|---|---|
| Cheap and cost-efficient comes before perfect. | The consumer is an AI agent. An imperfect answer costs it 1 more call or a read of the shared system, which is cheaper than a slow search or a model call on every lookup. |
| Deterministic code orchestrates. A model is called only for a fuzzy judgment that code cannot make. | Code is cheap, fast and testable. A model is not. |
| Each model call is 1 narrow question, with a fixed prompt and a structured answer. No model gets a tool loop. | A narrow question can be measured alone on its own test set, and its model can be chosen for it. |
| Each question uses the cheapest model that passes its test set, except where a wrong answer is costly. | The presets come from measurements, not from a guess. |
| Only a read that a consumer chose counts toward usefulness and confidence. | A count of reads by the system would measure the system, not the consumers. |
| A check that needs no other step runs before any costly step. A fault in the input is a rejection with a reason, never a retry. | A retry of a fault costs model calls and gives the same result. |
| No flag, option, cache or feature without a present use. | A thing with no user has no test of its worth, and it costs upkeep on every change. |

## Features

Shared by every feature: [the data model](data-model.md) of facts, versions and references.

| Feature | Status |
|---|---|
| [Look up facts](lookup.md) | Accepted |
| [Submit a change](submit.md) | Accepted |
| [Process submissions](updates.md) | Accepted |
| [Cleanup](cleanup.md) | Accepted |
| [Ingest documents](ingest.md) | Accepted |
| [Manage wikis](wikis.md) | Accepted |
| [Operator console](console.md) | Accepted |
| [Deployment and access](deployment.md) | Accepted |
| [Question tuning](questions.md) | Accepted |
| [System evaluation](evaluation.md) | Accepted |
| [Release](release.md) | Accepted |
| [Publication](publication.md) | Accepted |