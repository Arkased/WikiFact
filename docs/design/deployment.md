# Deployment and access

Design layer. The requirements are in [../requirements/deployment.md](../requirements/deployment.md). The technical details are in [../technical/deployment.md](../technical/deployment.md).

## Approach

1 long-running service holds every wiki of 1 wikis folder. It serves the MCP tools and the console over HTTP. It starts 1 update worker for each wiki as a child process. The worker is a separate process, because it is 1 global job for its database: it must see each change before the next. Consumers come and go, so no MCP server can own the worker. A lock file next to the database stops a second worker.

The config of each wiki has a mode: local or deployed. The mode changes 2 rules only:

1. The model credential of the worker.
2. The network address that the service can listen on.

Local mode is for 1 user, 1 account and 1 machine. The only consumers are the Claude Code sessions of that user. The terms of the Claude Code login allow this use as local experimentation. They do not allow the login in another product or service. A deployed worker is another service, so it needs an API key.

On Windows, a scheduled task starts the service at logon through a hidden PowerShell launcher. The deploy command installs a new version, stops the old service, and starts the new one.

## How the design meets each requirement

### Starts at logon

The deploy command creates a scheduled task that runs at logon. The task starts a PowerShell launcher with no console window. The launcher detaches the service from the task, so the service runs with no terminal open. The service writes its logs to files and not to a console, so nothing needs the window.

The launcher is a PowerShell file that the task starts as a file and not as a command string. A path with a space does not survive a command string through the task.

The creation of the task is the only step that needs elevation. The operator gives it with 1 UAC click. The deploy reads the action of the existing task first, and it creates the task again only when the action changed. An agent never creates the task by hand.

### One config entry

The service mounts 1 management endpoint. Its tools take the name of a wiki as an argument, so 1 connection reaches every wiki. The WikiFact plugin of this repo holds the entry for this endpoint in the Claude Code config of the user, and the deploy makes no entry. So each Claude Code session of the user reaches all the wikis.

The service also mounts 1 endpoint for each wiki. A project that works on 1 wiki can connect to that endpoint in place of the management endpoint.

The repo holds no project MCP entry. A second server on the demo database of the repo would start a second worker on the same file.

### Local only

In local mode, the HTTP transport binds to the loopback address only. The service refuses a host other than the loopback, with a message. So a wiki cannot reach other machines by accident.

The first log line of the service and of the worker names the mode, the transport and the condition of local mode: 1 user, 1 account, 1 machine.

### Key for deployed

The worker has 2 transports for its model questions:

- The SDK transport, which uses an API key.
- The CLI transport, which runs the Claude Code command in headless mode, with the login of the user.

When an API key is set, the SDK transport wins in every mode. When no key is set, the worker in local mode uses the CLI transport. The worker in deployed mode exits with a message, because the terms of the login do not allow use by another service. A developer can force the CLI transport by hand for a local run.

### Known consumers

There is no design that is built. Today nothing checks who connects to a deployed service.

The planned design is in [../future.md](../future.md), "Authentication on the deployed HTTP mode": a bearer token in the config of the wiki or in the environment, which the HTTP layer checks. Local mode stays on the loopback with no token. The trigger is a service on a host other than the loopback.

### Edits refused when deployed

In local mode on the loopback, the write routes of the console need no authentication. In deployed mode, every write route of the console answers "forbidden" until the bearer token above exists. An operator can still read every page.

In every mode, the console refuses a write that comes from another site or another origin. A browser sends a form from any site, so the loopback alone does not stop such a write.

### Safe upgrade

The deploy command does these steps in this order:

1. It creates or re-creates the scheduled task, when its action changed.
2. It stops the old service (see "Safe stop").
3. It waits for the port to be free. When the port stays busy after a set time, the deploy stops before it installs anything.
4. It builds, packs and installs the current checkout as a global package.
5. It creates the deployment folder, its wikis folder and the 2 launcher files, when they are absent.
6. It creates the task again with the current launcher, and it starts the task.

The stop comes before the install, because the install replaces files that a running service holds open.

The deployment folder is outside the repo. It holds the wikis and the credential file of the service. A new version replaces only the installed package, so no wiki is lost.

The service migrates a wiki when it opens it. So the release command of the developer copies each wiki whose stored format is older than the format of the code, before the deploy. The copy is read-only. The proof after the start checks 3 things:

1. The port answers.
2. The console names the new version.
3. Each wiki reports the format of the code.

The deploy command alone does not copy the wikis. Only the release command does. See [release.md](release.md).

### Safe stop

The deploy finds the process that listens on the port of the service. It stops that process and its worker children only when the command line of the process names WikiFact. Another program on the same port stays alive.

The deploy stops the service through its port and not through the task. The hidden launcher detaches the service, so an end of the task does not reach it.

### Early accept

The service binds its port before it loads the embedding model. A tool call that arrives during the load waits for the load to end. So a session that starts right after logon connects, and its first call gets an answer.

The worker child of each wiki starts after the embedding model is ready.

### Worker restart

The service watches the worker child of each wiki. When the child exits while the service runs, the service starts a new child. The restart waits a short delay, and the delay grows with each exit in a row, so a worker that exits at once on each start does not take the machine. The delay goes back to its start value after a child has run for a while.

A stopped worker is a fault of the service, so the service repairs it. The operator sees the count of restarts since the service started on the Service health page of the console ([console.md](console.md), "Service health"), and each exit is 1 error line in the log. The restart button of the console goes.

A stop that the service itself asks for (a config edit, a rename, an archive, a stop of the service) is not an exit of this kind, and starts no new child.

### MCP sessions

The MCP endpoint of each wiki, and the management endpoint, give each client a session. A session is 1 connection of 1 client. The service holds 1 small record for each open session, and ends a session that made no call for a while. The sessions are a record of the connected processes ([lookup.md](lookup.md), "Search log and sessions"). No page of the console counts them.

The endpoint is also a counter for the Service health page: the calls per hour by tool, the calls that failed and the time of a search, over the last 24 hours in the memory of the service process ([console.md](console.md), "Service health").

### Log space

Each process writes 1 JSON line for each event, with a level. In service mode, each process writes to files in a log folder, and not to a console. Each file rolls at a set size and keeps a set number of files. The oldest file goes when the count is full. So the logs use a fixed space, and a quiet service uses very little of it.

Retention is by space and not by time. A failure stays in the logs while its lines are inside the window of the full log. The files are:

| File                 | Holds                                       | Why it is apart                                                                                |
| -------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Full log             | Every line.                                 | The context of a failure.                                                                      |
| Error log            | Every error and warning line.               | It keeps more space than the full log, so an error stays after its context rolls out.               |
| Call log of a worker | Each model call: its input, context, output. | 1 call line is large. In the full log, call lines would push the context of a failure out.      |

Each worker child writes its own full log and error log in the same folder, under the same rules. The call log is the source of the test cases from real use, so it keeps more files than the other logs. See [questions.md](questions.md).

### Any OS

There is no design for Linux or macOS. The service code uses Node.js and SQLite, which run on Linux and macOS. The deploy has a Windows form only: a scheduled task, a PowerShell launcher and a UAC prompt. Nothing was run or tested on Linux or macOS.

## Repair from the logs

The operator finds the cause of a failure in the error log, and then reads the context in the full log. 3 repair commands act on 1 wiki:

- `requeue` lists the failed requests, or puts 1 back in the queue.
- `check` compares the search index with the facts.
- `reindex` builds the search index again and embeds every fact again.

## Decisions

| Decision                                                                      | Reason                                                                                                                                       |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| The worker is a separate process, 1 for each database, under a lock file.      | The worker must see each change before the next. Consumers come and go, so no MCP server can own it.                                         |
| 1 service holds all the wikis of 1 folder and starts their workers.          | 1 entry in the config of the user reaches every wiki.                                                                                         |
| The mode changes only the credential rule and the host rule.                  | The terms of the Claude Code login allow local experimentation only. Everything else is the same in both kinds.                             |
| Local mode binds to the loopback only.                                        | A wiki in local mode cannot reach other machines by accident.                                                                                |
| A deployed worker with no API key exits.                                       | A deployed worker is another service, and the terms of the login do not allow it.                                                           |
| The console refuses edits in deployed mode.                                    | Nothing checks who connects until the bearer token exists.                                                                                   |
| A hidden launcher detaches the service from the task.                          | The service runs with no console window and no terminal.                                                                                     |
| The deploy stops the service by its port, and only a process of WikiFact.      | The task does not reach the detached service. A check of the command line keeps another program alive.                                     |
| The deploy stops the service before the install.                               | The install replaces files that the running service holds open.                                                                             |
| The service binds its port before it loads the embedding model.               | A session that starts at logon connects at once.                                                                                             |
| Log retention is by space, not by time.                                        | The logs use a fixed space on disk.                                                                                                          |
| The call lines go to their own log.                                           | 1 call line is large and would push the context of a failure out of the full log.                                                            |
| A restart setting on the task does not restart a crashed service.             | The launcher detaches the service, so the task ends at once and does not see a crash. A restart needs a supervisor ([../future.md](../future.md)). |
| The service starts a worker child again when it exits, with a delay that grows. | A stopped worker is a fault of the service, and the operator should not have to see it. The delay keeps a worker that exits at once from a loop. Decided by the owner on October 16, 2026. |
| The MCP endpoint gives each client a session.                                  | The sessions count the use of the wiki and link each read to its search, and the agent passes nothing. Decided by the owner on October 16, 2026. |

## Open points

- Known consumers: not built. The planned design is a bearer token ([../future.md](../future.md)). It waits for a service on a host other than the loopback.
- Any OS: no design for Linux or macOS. The deploy has a Windows form only, and nothing was run on Linux or macOS. The requirements propose a test run on Linux first.
- Safe upgrade: the deploy command alone does not copy the wikis whose format changes. Only the release command of the developer does.
- Starts at logon: no requirement test yet. Only each real deploy proves it.
- The deployed kind has no present user. The requirements propose to build it when a user needs it.
- A restart of the service after a crash: no design that is built. It needs a supervisor, which differs on each OS ([../future.md](../future.md)).
- A status command, and a test of a deployed host: future, with a trigger, in [../future.md](../future.md).
