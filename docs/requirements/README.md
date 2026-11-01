# Requirements

Accepted by the owner on 2026-10-14. The design layer is in `docs/design/` and the technical layer in `docs/technical/`.

The docs have 3 layers, and each layer uses only the layer above it:

1. `requirements/` (this folder): what each feature must do, and for whom.
2. `design/`: how the system meets each requirement.
3. `technical/`: the schema, the contracts, the limits and the code paths that build the design.

Each layer has 1 file per feature, with the same file name in each layer. This folder lists every feature of WikiFact. The file of each feature gives:

- who uses it,
- what they do with it (the use cases),
- what it must do (the requirements),
- what it does not do (out of scope), and what waits for a trigger (future).

## Requirements are contracts

Each requirement is a contract that a change can break, so a test protects each one. A requirement row has 4 columns:

| Column      | Meaning                                                                                                                                                          |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name        | The key of the requirement. The test that protects it has the same name.                                                                                         |
| Contract    | What must stay true. A number that is a setting (a cap, an interval) is not in the contract: the contract states the mechanism, and the design gives the number. |
| Proof today | "The requirement test": the test with the same name in `__tests__/requirements/<feature>.test.ts`. "To do": that test is an `it.todo`, because nothing proves the contract yet. "Eval": the eval whose pass bar proves the part of the contract that only a model run can prove. |
| Gap         | What the proof does not cover. "None" when the proof covers the whole contract.                                                                                  |

The requirement tests live in `__tests__/requirements/`, 1 file per feature with the name of the feature file. `npm run check` runs `scripts/check-requirements.ts`, which fails when a requirement has no test with its name, when a test in that folder has no requirement with its name, or when a named eval does not exist. Unit tests that support the implementation stay beside their code, with no mapping.

## Roles

Every file of the 3 layers uses these terms with these meanings only.

| Role      | Human or AI                                      | Definition                                                                                                                                                                                                                                                                                                                            | Interface                                                  |
| --------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Consumer  | AI                                               | An AI agent that uses a wiki while it works on the shared system of that wiki. Examples: a Claude Code session, or a subagent of that session. A person never calls the tools. A person who works in a session with an AI agent reaches the wiki through that agent, so the agent is the consumer. All consumers have the same trust. | The MCP tools.                                             |
| Submitter | AI                                               | A consumer at the time when it sends a change. Not a separate agent.                                                                                                                                                                                                                                                                  | `requestChange`, `getRequest`.                             |
| Operator  | Human                                            | The person who runs the service on a machine and watches its wikis. 1 operator for each service. An AI agent can run an operator command only when the operator tells it to.                                                                                                                                                          | The console in a browser, and the commands of the service. |
| Developer | Human, or an AI agent that the developer directs | The person who changes the code, the prompts, the tests, the test data and the docs of WikiFact. The developer also writes the expected answer of each test case. An AI agent that does this uses a model of a higher tier than the model under test.                                                                                 | The repo: tests, evals, the ship command.                  |

Other terms:

| Term          | Definition                                                                                                                                         |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared system | The thing that a wiki is a model of: a repo, a product, a game. The shared system is the truth. The wiki can be wrong.                             |
| Update worker | Not a role. The process that applies each submission to the wiki. It calls a model for narrow questions. No person and no consumer is in its loop. |
| Dogfood wiki  | The wiki `wikifact`, whose shared system is the WikiFact repo. Its consumers are the AI agents of the developer.                                   |

1 person can hold more than 1 role. Today 1 person is the operator and the developer, and the AI agents of that person are the consumers of the dogfood wiki.

## The product as a whole

A wiki is a model of a shared system. The system is the truth, and the wiki can be wrong. The main loop: a consumer looks up a fact, gets no answer or a wrong answer, does its work on the system, and tells the wiki what it saw. A wiki starts empty and fills through this loop.

The consumer is an AI agent, so the wiki must be cheap and cost-efficient, not perfect. When a requirement can be met only at a large cost in time or model calls, a bar that the consumer can live with comes first: an imperfect answer costs the agent 1 more call, or a read of the shared system.

These requirements hold for the whole product. A feature requirement proves each one, so they have no test of their own.

| Requirement                                                                     | Proved by                                                           |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| AI agents add, correct and delete facts. No person approves a change.           | [updates.md](updates.md): "Crash safety", "No duplicates"           |
| A consumer can tell how much to trust each fact.                                | [lookup.md](lookup.md): "Confidence"                                |
| A submission costs the consumer 1 call. Consumers do not coordinate.            | [submit.md](submit.md): "One call"                                  |
| A lookup is fast.                                                               | [lookup.md](lookup.md): "Search speed"                              |
| Quality rises with use: wrong facts get corrected, and missing facts get added. | The correction test with a stub consumer. Not measured on real use. |
| Any consumer reaches the wiki through MCP.                                      | [wikis.md](wikis.md): "One connection"                              |

Out of scope for the whole product:

- Links between wikis. A consumer picks each wiki it needs.
- Facts that belong to 1 user.
- Trust per submitter. All submitters have the same trust.
- A consumer that keeps a fact id and reads that fact again in a later session. A consumer that wants a fact again searches for it.
- A reading interface for people other than the operator console.

## Features

| Feature                                | Users and tools                                                                                                  |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| [Look up facts](lookup.md)             | User: consumer. Tools: `search`, `getFact`.                                                                      |
| [Submit a change](submit.md)           | User: consumer. Tools: `requestChange`, `getRequest`.                                                            |
| [Process submissions](updates.md)      | User: none directly. The update worker does this for the consumer. The operator watches it.                      |
| [Cleanup](cleanup.md)                  | User: none directly. The worker does this between 2 requests when a check is due. The operator can start it at once. |
| [Ingest documents](ingest.md)          | User: operator. A command that reads files and submits their claims.                                             |
| [Manage wikis](wikis.md)               | Users: consumer and operator. Tools: `listWikis`, `createWiki`, `archiveWiki`, `unarchiveWiki`, and the console. |
| [Operator console](console.md)         | User: operator. A web page at `/console/` on the service.                                                        |
| [Deployment and access](deployment.md) | Users: operator and consumer. The local and the deployed kinds, and the operating systems.                       |
| [Question tuning](questions.md)        | User: developer, who changes a prompt or a model.                                                                |
| [System evaluation](evaluation.md)   | Users: developer and operator. Whether the wiki works.                                                           |
| [Release](release.md)                  | User: developer.                                                                                                 |
| [Publication](publication.md)          | Users: a reader from outside, and the developer. The public repo, its demo wiki and its README.                  |