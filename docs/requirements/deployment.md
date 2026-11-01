# Deployment and access

Requirements layer. The design is in [../design/deployment.md](../design/deployment.md).

Users: operator and consumer. The roles are defined in [README.md](README.md#roles). The release of a new version by the developer is in [release.md](release.md).

## Goal

The wikis are available to their consumers with no attention from the operator, on the machine where they run. The operator installs a new version safely in 1 step.

## Deployment kinds

| Kind     | Who uses the wikis                                      | Where they run                                                     | Model credential                                                                         | Status                                                                                                              |
| -------- | ------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Local    | 1 user: the AI agents of that user, on the same machine | The machine of the user. The service listens on this machine only. | The Claude Code login of the user, or an API key                                         | Built. The only kind in use.                                                                                        |
| Deployed | The AI agents of more than 1 user or machine            | A host that other machines reach over the network                  | An API key only. The terms of the Claude Code login do not allow use by another service. | Partly built. The service runs in deployed mode, but nothing checks who connects, so the console refuses all edits. |

## Operating systems

| OS      | Status                                                                                                                                                                                            |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows | The only OS where the service, the deploy and the tests run today. The deploy uses a Windows scheduled task, a PowerShell launcher and a UAC prompt.                                              |
| Linux   | The usual OS of a deployed host. The service code uses Node.js and SQLite, which run on Linux, but nothing was run or tested on Linux. The deploy has no Linux form (for example a systemd unit). |
| macOS   | The usual OS of a local developer machine. Nothing was run or tested on macOS. The deploy has no macOS form (for example a launchd agent).                                                        |

## Use cases

Local:

1. Install the service so that it starts at logon and runs with no terminal open.
2. Connect every Claude Code session of the user to all the wikis with 1 entry in the user's config.

Deployed:

3. Run the service on a host, and let the agents of other users or machines connect to it.
4. Allow only known consumers and the operator to connect.

Both kinds:

5. Install a new version with 1 command, with no loss of a wiki.
6. Find the cause of a failure from the logs.
7. Repair: check the search index, build the search index again.
8. Run the service on Windows, Linux or macOS.

## Requirements

| Name                        | Contract                                                                                                                                                            | Proof today                                                                                                                                                                                                                                                                                                     | Gap                                                                                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Starts at logon | Local: the service starts at logon and runs with no terminal open. | To do in the requirement test. | Proven only by each real deploy. Windows only. |
| One config entry | Local: 1 entry in the user's Claude Code config (held by the plugin `wikifact`) reaches all the wikis, and the deploy adds no second entry. | The requirement test: no deploy step registers an MCP server. | None |
| Local only | Local: the service listens on this machine only. | The requirement test. | None |
| Key for deployed | Deployed: the worker needs an API key. | The requirement test. | None |
| Known consumers | Deployed: only a consumer or an operator with a credential connects. | To do in the requirement test. | Not built. |
| Edits refused when deployed | Deployed: the console refuses every edit until the check of credentials exists. | The requirement test. | None |
| Safe upgrade | 1 command installs a new version: it copies each wiki whose database format changes, stops the old service, installs, starts, and proves that the new version runs. | The requirement test. | The tests use a fake for each step. Local kind and Windows only. The copy of the wikis runs only in the release command of the developer, not in the deploy command. |
| Safe stop | The upgrade stops only a process of WikiFact. | The requirement test. | None |
| Early accept | The service accepts connections before the search model is loaded. A call waits for the load. | The requirement test. | None |
| Worker restart | When the worker of a wiki stops while the service runs, the service starts it again with no action of the operator. | The requirement test. | None |
| Log space | Each log file rolls at a set size and keeps a set number of files, so the logs use a fixed space. | The requirement test. | None |
| Any OS | The service and its install run on Windows, Linux and macOS. | To do in the requirement test. | Windows only. Nothing was run on Linux or macOS. |
## Open points

- The deployed kind and the support of Linux and macOS have no present user. Proposed: keep both in the requirements as "not built", and build them when a user needs them. The first step is a test run on Linux, because a deployed host is most often Linux.

## Future

A restart of the service after a crash (needs a supervisor, which differs on each OS); a status command.
