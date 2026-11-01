# Manage wikis

Design layer. The requirements are in [../requirements/wikis.md](../requirements/wikis.md). The technical details are in [../technical/wikis.md](../technical/wikis.md).

## Approach

1 service holds every wiki of 1 wikis folder. Each subfolder with a wiki config file is 1 wiki, with its own database and its own worker. The service mounts each wiki at its own endpoint.

A consumer uses 1 connection: the management endpoint. There, each wiki tool takes the name of the wiki as 1 more argument. The management tools list, create, archive and unarchive wikis.

No tool needs a human step outside the session. The permission prompt of the client is the button. The guardrails and the archive bound a call that goes through without a prompt.

The operator does the rest in the console: a rename, a new description, new settings.

## How the design meets each requirement

### One connection

The management endpoint has the 4 management tools and the 4 wiki tools. Each wiki tool takes 1 more required argument: the name of the wiki, from `listWikis`. So 1 connection serves every wiki, and a session names the wiki in each call. An unknown name is a tool error.

A project that works on 1 wiki can connect to the endpoint of that wiki instead. That endpoint has the 4 wiki tools without the name argument, and no management tool.

The service starts with no wiki. The first wiki comes from `createWiki`, or from a folder that the operator adds.

### Subject only

`createWiki` needs 2 inputs:

- a name: lower-case letters, digits and hyphens, with a set maximum length,
- a subject: 1 sentence that every model question of the wiki gets.

A quality preset is optional. The wiki gets the mode of the service.

`createWiki` writes the config file, creates the empty database, mounts the endpoint, starts the worker and returns the endpoint URL.

The guardrails stop a wiki that a session creates by mistake:

- The same name with the same subject returns the existing wiki, and creates nothing. So a repeated call is safe.
- The same name with another subject is an error that names the existing subject.
- A name close to an existing name is an error that names that wiki. Close means equal after lower case, with the hyphens and a final "s" removed.

### Wiki cap

The service has a cap on the count of wikis. `createWiki` at the cap is an error that says so.

The cap is a start option of the service. Only the operator starts the service, so only the operator raises the cap. No tool changes it.

### No loss

No tool deletes a wiki with content:

1. `archiveWiki` stops the worker of the wiki and unmounts it.
2. A wiki with no fact at all, live or deleted, and 0 queued requests is removed, because it holds nothing to lose. A deleted fact is content: it keeps its history, so the wiki that holds it moves to the archive.
3. Any other wiki moves to an archive folder in the wikis folder. The service never mounts a folder there.

`unarchiveWiki` moves the folder back, mounts the wiki and starts its worker. So an agent can undo its own archive. When 1 name has more than 1 archive, the newest comes back, and the answer says so. A live wiki with that name is an error.

A person can also restore an archive by hand: move the folder back.

The tool annotations tell the client which tools change state. `archiveWiki` is marked destructive, and `createWiki` and `unarchiveWiki` are marked idempotent and not destructive.
### Worker warning

`listWikis` gives, for each wiki, its name, its subject, its URL, its count of live facts, its count of queued requests and its worker state. The worker state says whether the worker runs, and gives the result of its last model call. So a session sees whether the model credential works before it submits.

`requestChange` returns a warning when the worker cannot process the request. The warning names the condition and its start time:

- no worker has run on this database,
- the last model call of the worker failed on its credential, or
- the last calls failed on another error more than the number of attempts in a row.

The request is queued in every case. The consumer reads the warning, tells the user and goes on.

The worker writes its state after each poll and after each model call. The tools only read it.

### Direct settings

The operator edits these fields of a wiki in the console. Each edit is direct, not through the queue, because the worker reads none of them in the pipeline:

| Field                                           | How the edit lands                                                                                                         |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Description                                     | The service writes the config file. No restart, because the worker never reads it.                                         |
| Name                                            | The service stops the worker, moves the folder, mounts the new name and starts the worker. The same name rules as `createWiki` apply. |
| Subject, quality preset, question overrides, caps, search weights, timeout | The service writes the config file and restarts the worker between 2 requests, because the worker reads the config at start. |
| Mode, embedding model                           | Refused.                                                                                                                   |

A rename changes the endpoint URL of the wiki. The answer tells the operator that a session that connected to the old URL must add the new one. The management endpoint does not change.

A restart waits for the current request to finish. A stop in the middle of a request is safe, but it repeats the model calls of that request.

The console form shows the keys as the config file holds them, not the resolved config. An absent key stays absent, so the preset keeps its role.

The description is a longer text for the operator. `listWikis` and the console show it. No model question gets it.

Mode and the embedding model stay out of the console. A mode change changes the host rules and the transport. A change of the embedding model needs a reindex, so it stays a hand step.

## Decisions

| Decision                                                                    | Reason                                                                                              |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 1 management endpoint, where each wiki tool takes the wiki name.            | 1 connection serves every wiki, and a session needs no new setup for a new wiki.                    |
| The client permission prompt is the only human step.                        | A tool that needs a step outside the session breaks the session. The guardrails bound the rest.     |
| Archive moves a wiki, and removes it only when it is empty.                 | A tool call by mistake loses no content, and an agent can undo it.                                  |
| The same name with the same subject returns the existing wiki.              | A repeated call is safe.                                                                            |
| A name close to an existing name is refused.                                | A session that misspells a name gets the existing wiki named, not a second wiki.                             |
| The cap is a start option of the service.                                   | Only the operator starts the service, so no agent raises it.                                        |
| `requestChange` queues the request also when no worker runs, with a warning. | The consumer learns that its submission waits, and loses nothing.                                   |
| The wiki name, description and settings are direct edits, not queue requests. | The worker reads none of them in the pipeline. A setting that it reads at start restarts it.        |
| Mode and embedding model are refused in the console.                        | A mode change changes the transport. A model change needs a reindex.                                |
| No links between wikis.                                                     | Out of scope. A consumer picks each wiki that it needs.                                             |
| No confirmation question inside `createWiki`.                               | Future. It waits for a client that creates wikis by mistake while it runs with no permission prompt. |

## Open points

1. "Worker warning" says that `requestChange` warns when no worker runs. The source names 3 conditions: no worker has run on the database, a credential failure, and repeated failures. It names no warning for a worker that ran once and then stopped. The code also warns when the last poll of the worker is old, but no design source states it.
2. Settled by the owner: a deleted fact counts as content. `archiveWiki` removes only a wiki with no fact, live or deleted, and no queued request (see "No loss").
3. Settled by the owner: "Direct settings" now names the 2 settings that the console refuses, the mode and the embedding model.
