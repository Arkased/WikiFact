# Manage wikis

Requirements layer. The design is in [../design/wikis.md](../design/wikis.md).

Users: consumer and operator. Tools: `listWikis`, `createWiki`, `archiveWiki`, `unarchiveWiki`, and the console. The roles are defined in [README.md](README.md#roles).

## Goal

1 wiki for each shared system, all of them through 1 connection, and no loss of content by mistake.

## Use cases

1. See the wikis of the service, their subjects, their size, and whether a worker runs for each.
2. Create a wiki for a new subject.
3. Archive a wiki that is no longer used, and bring it back.
4. Rename a wiki, or change its description or settings (operator only, in the console).

## Requirements

| Name            | Contract                                                                                                                                                                            | Proof today                                                                                                                                                                                                                                                  | Gap                                      |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| One connection | 1 MCP connection reaches all the wikis. | The requirement test. | None |
| Subject only | A new wiki needs a name and 1 sentence: its subject. | The requirement test. | None |
| Wiki cap | A service holds a capped number of wikis. Only the operator raises the cap. | The requirement test. | None |
| No loss | No tool deletes a wiki that has facts, live or deleted, or queued requests. Archive moves it. An agent can undo its own archive. | The requirement test. | None |
| Worker warning | `listWikis` shows whether a worker runs for each wiki. `requestChange` warns when no worker runs, so the consumer knows that its submission waits. | The requirement test. | None |
| Direct settings | The operator changes the name, the description or the settings of a wiki directly, not through the queue, except the mode and the embedding model, which the console refuses. A change to a setting that the worker reads at start restarts the worker. | The requirement test. | None |

## Future

A confirmation question to the user before `createWiki` writes, when a client creates wikis by mistake.
