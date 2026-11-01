# Operator console

Requirements layer. The design is in [../design/console.md](../design/console.md).

User: operator. A web page at `/console/` on the service. The roles are defined in [README.md](README.md#roles).

## Goals

A wiki goes through 3 stages: new, growing and mature. The operator wants to:

1. **Know where the wiki is in this progression,** what it gives the agents, and what it costs.
2. **Know that the service runs.**
3. **See what runs by itself, and start it at once when needed.**

The wiki corrects itself through its agents. The operator watches and does not proofread facts, so the console has little to repair.

## Rules for every page

- **Useful, not cool.** An item is on a page only when its answer changes something that someone does.
- **Activity, not time.** A rate has a measure of use as its denominator: per search, or per agent session. A rate per day mixes the state of the wiki with how busy the agents were.
- **Hard data apart from interpretation.** Hard data is a count or a measurement from the database or the logs. An interpretation is what someone says the data means. A page shows which is which ([../design/console.md](../design/console.md#decisions)).

## Use cases

Each use case is a question that the operator asks.

Goal 1, where the wiki is:

1. **Which stage is the wiki in?** The additions and the corrections per search, against the count of searches so far.
2. **Does the search work?** The reads that follow each search (0, 1, 2, 3 or more), the searches with no read, and the facts the search missed: the change requests after a search whose target fact the search did not list, a duplicate or a correction of an unlisted fact (the owner's correction of October 16, 2026: a correction of a listed fact is the loop working). A fault of the search goes to the developer.
3. **What does it cost?** The cost in dollars per write, and the share of the cost spent on change requests that wrote nothing.

Goal 2, the service:

4. **Does the service run?** The worker (its state, the failed change requests, the queue length, the change requests processed and their rate) and the MCP endpoint (the tool calls per hour, the failed tool calls, and the time of a search; the owner's change of October 16, 2026). The status pill on every page shows the short answer. The operator can pause the queue and resume it (the owner, October 17, 2026).

Goal 3, the jobs:

5. **What runs by itself, and when?** Each job, with its trigger, its last run, its next run and its result. The operator can start a run at once.

Tools, with no metric:

6. Spot-check: search as a consumer does, read a random sample, read 1 fact with its history.
7. Check what the worker did with 1 request.
8. Open any page from a link, and export the facts for a reviewer.

The management of wikis (create, archive, rename, settings) is in [wikis.md](wikis.md). The console is 1 of its interfaces.

## Requirements

| Name                      | Contract                                                                                                             | Proof today                                                                                                                                                                                                                                                                    | Gap                                                                                  |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Fast page | A page loads in less than 1 second. | The requirement test. Eval: the console timing. | The requirement test proves the bar logic. Only the console timing, run by hand on a large wiki, measures the pages. |
| Reads not counted | A console read changes no usefulness and no confidence. | The requirement test. | None |
| No model call | The console asks no question of a language model. The search page embeds the query with the local embedding model, as the consumer search does. | The requirement test. | None |
| Plain words | A page says what the worker did in plain words. It shows no question number, step number or module name. | The requirement test. | None |
| Stored text | The console shows the text of the worker as it was stored, with no word changed. | The requirement test. | None |
| Local edits only | Edits work only in local mode on this machine. A form sent from another web site is refused, and nothing is written. | The requirement test. | None |
| Wiki growth | The console shows the trend of the wiki over the searches of the span that the page shows: the count of live facts after each search, and the rate of change, the additions and the corrections per search, in each stretch of searches, not counted from the start. The hover of a point shows the values of that point (the owner, 2026-10-20). | The requirement test. | The chart counts from the start of the span. |
| Search quality | The console shows the share of searches with 0, 1, 2, and 3 or more reads, the searches with no result, the searches with no read, and the facts the search missed, as the design defines them. | The requirement test. | None |
| Cost | The console shows the cost in dollars per write and the share of the cost spent on change requests that wrote nothing. | The requirement test. | None |
| Service health | The console shows, on 1 Operation page, the MCP endpoint beside the worker, each with its present and its history. The MCP endpoint: its reachability, the tool calls and the failed tool calls, and the time of a search in the last minutes, and the tool calls per hour above the search time per hour. The worker: its state, the queue length, the estimated wait, the current rate, the failed change requests, and the change requests processed per hour above the queue length per hour. | The requirement test. | None |
| Queue pause | The operator can pause the queue and resume it from the console. While the queue is paused, the worker starts no request, and `requestChange` still accepts requests. The pause stays after a restart of the worker or of the service. | The requirement test. | None |
| Jobs | The console lists each job with its trigger, its last run, its next run and its result, and the operator can start a run at once. | The requirement test. | None |
| Data and interpretation | A page shows which numbers are hard data and which text is an interpretation. | The requirement test. | None |

The edits of a wiki (name, description, settings) are in [wikis.md](wikis.md).

## Future

A graph view of the facts.
