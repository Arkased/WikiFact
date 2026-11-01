# Operator console

Design layer. The requirements are in [../requirements/console.md](../requirements/console.md). The technical details are in [../technical/console.md](../technical/console.md).

## Approach

The console is a window on a wiki for the operator. The wiki corrects itself through its consumers. The operator watches, and acts rarely.

The console answers the 3 goals of the requirements with 3 pages, 1 page per goal:

| Page | Goal | Question |
|---|---|---|
| Overview | 1 | How good is the search, how is the wiki growing, how much do the agents adopt it, and what does it cost? |
| Service health | 2 | Does the service run? |
| Jobs | 3 | What runs by itself, and when? |

The tools of the requirements (the spot-check, the request pages, the export) are pages too. They have no metric. They are behind the "More" menu.

The console is a set of web pages in the service process. The server renders each page. A page is 1 request and 1 read-only connection to the store. Every number on a page comes from the store or from the service process. No page asks a model.

Each page answers 1 question. The answer is the first and widest block of the page. The detail comes after it. The rare tools come last, or behind a button.

The console writes in 2 ways:

1. A start of a job and the reindex become a request in the worker queue. The worker runs it in queue order, with no model question.
2. An edit of the name, the description or the config of a wiki is a direct write through the registry ([wikis.md](wikis.md)).

The console does not edit facts. The wiki corrects itself through its agents. The operator who sees a wrong fact is a consumer at that moment: the agent of the operator sends the change.

## The signals

Every number of the page "Overview" is 1 of 7 hard data. A hard datum is a count or a measurement from the store. The page shows each one with its exact definition.

| Data | Definition |
|---|---|
| Additions per search | The count of additions divided by the count of searches so far. An addition is a change request that wrote at least 1 fact version that is the first of its fact. |
| Corrections per search | The count of corrections divided by the count of searches so far. A correction is a change request that wrote a version of a fact that already had one, or a deletion. |
| Reads per search, as a distribution | For each search with results, the count of reads that link to it by a minted id ([How a read links to its search](#how-a-read-links-to-its-search)). The share of those searches with 0, 1, 2, and 3 or more reads. A search that returned no result is not in the histogram. A search from before the minted ids (October 18, 2026) has no minted id, so no read can link to it: it is not in the histogram and not in "Searches with no read" ([research](../research/no-result-searches-2026-10-19.md): 939 of 949 searches had no minted id and counted as 0 reads). |
| Searches with no result | The count of searches that returned no result (`result_count` 0), out of the count of searches. |
| Searches with no read | The count of searches with results and a minted id that led to 0 linked reads, out of the count of searches with results and a minted id. A read links to a search by the rule of the histogram. |
| Facts the search missed | The change requests that name a search (`searchId`) whose target fact that search did not list: a duplicate of an unlisted fact, or a correction of an unlisted fact. A correction of a listed fact is the loop at work and does not count. A change request that names no search is in neither count. |
| Cost per write | The cost in dollars of all model calls of the worker, divided by the count of change requests that wrote a fact. Also: the share of this cost spent on change requests that wrote nothing. The cost comes from the tokens of each call and the price table of the service; a model with no price counts at $0. |

A search is a call of the `search` tool by a consumer. A search from the console is not a search: the console records nothing ([Reads not counted](#reads-not-counted)). A read is a call of `getFact` by a consumer. A write is a change request that wrote at least 1 fact version. A change request that adds and corrects counts once in each; one that wrote nothing (rejected, duplicate, split) is neither.

An interpretation is what someone says the data means. Each interpretation has a status: "assumed" until its test passed, then "tested". The status lives in the code list only, as the developer's record: the page does not show it (the owner's verdict of October 16, 2026: the word "unverified" had no purpose, because the info mark and the sentence already say that the line is a reading and not data). An interpretation that fails its test goes. Its data stays.

An interpretation reads the current numbers: the page shows 1 sentence about the data of the moment, never a note that stands the same under every number. The sentence is not a line on the page: it is the hover and focus text of the number it reads ([Data and interpretation](#data-and-interpretation)). A reading leads with a verdict word (Growing fast, Growing, Mature, Good, Poor, Weak) and then says what the data means for the operator. It does not restate the data: the number stays out of the sentence, because the stat beside it shows it (the owner's correction of October 16, 2026). When the data cannot say anything (no searches, no sessions, no change request after a search), the page shows no sentence. Each threshold is a named constant in `src/console/signals.ts` and a first guess.

| Interpretation | Of | Reading rule | Status (the developer's record) | Test |
|---|---|---|---|---|
| The wiki growth | Additions per search (A) and corrections per search (C), over all searches | A over `STAGE_NEW_MIN` (1.0): "Growing fast. Agents add far more than they find: quality should rise as the gaps fill." A under `STAGE_MATURE_MAX` (0.2) and C at or over A: "Mature. Agents correct more than they add: quality holds, and the wiki has what they search for." Otherwise: "Growing. Agents add and correct in step: quality should rise slowly." | Assumed | None yet. |
| The poor searches | Facts the search missed, over the span | The share of missed facts among the change requests after a search over `SEARCH_MISS_SHARE` (0.2, a first guess): "Poor. The search misses facts the wiki has, and agents find them another way." Else, when a change request followed a search: "Good. The search finds the facts the wiki has." No reading when none did. A correction of a listed fact is the loop at work, not a fault of the search. | Assumed | None yet. |

**The color of a number.** The numbers of Overview that have a reading rule show their level in color, as on Service health: green for ok, amber for warning, red for failing (the owner's verdict of October 16, 2026). The rule is the threshold of the reading, and 1 function per signal, beside its reading in `src/console/interpretations.ts`, gives both, so the color and the reading never disagree. A number with no data (a divisor of 0) has no color. The chart stays as it is.

| Number | ok | warning | failing |
|---|---|---|---|
| Facts the search missed | at or under `SEARCH_MISS_SHARE` | none | over `SEARCH_MISS_SHARE` |
| Searches with no result | 0 | over 0 | none |

The growth numbers (additions and corrections per search), the reads per search, "Searches with no read" and the cost numbers have no rule and stay in ink.

**The number carries its reading.** The verdict is the color; the sentence explains it on hover and focus of the number (the owner's verdict of October 16, 2026: the reading lines left the page). The reading of "Facts the search missed" is the sentence of its row of the table of readings. "Searches with no result" has a color and no reading. "Wiki growth" has no good or bad, so its reading ("Growing fast. ...") is the hover text of "Additions per search", with no color. A number with no reading rule has no hover text of its own. The label keeps its definition on hover, as before.

### The test of the reads per search

The count of reads after a search does not tell whether the search found the answer, so the reads per search have no reading. The test of 2026-10-29 (#6) labeled samples of real agent searches with a model of a higher tier: found, not found, or misled. Of 20 searches with 0 reads, 9 were found. Of 20 searches with 1 read, 6 were not found or misled. Only 2 searches had 3 or more reads, and both were found ([note](../research/reads-per-search-2026-10-29.md)). The bar for a reading was 80% agreement in each sample. The distribution and the count of searches with no read stay on the page as data.

`npm run eval:reads-per-search` runs the test again on a copy of a store ([evaluation.md](../technical/evaluation.md)). A new reading of the reads per search needs a sample that passes this bar first. A run writes 1 result file: a new file, or the file of a stopped run that it continues. The options of the run hold 1 of the 2, so a run with both cannot be written, and only the command line rejects both flags.

## How a read links to its search

A search mints an id (`ref`) for each result and returns it with the result, and the id of the search (`searchId`). A read passes the `ref` of the result it opens, and a submission passes the `searchId` of the search it follows ([lookup.md](lookup.md), "Minted ids"). So the link is exact: the read names its search, and the submission names its search. A read by fact id, or a submission with no `searchId`, is unlinked. It counts in no distribution.

The first design (October 16, 2026) linked a read to the last search of its MCP session that listed the fact, because the agent passed nothing. The subagents of a process share its session, so that link crossed context windows: a read of 1 subagent could link to a search of another. The owner replaced it on October 17, 2026 with the minted ids.

## How the design meets each requirement

### Fast page

The design keeps the work of a page small:

- The server renders the page in the service process. No second process and no network call take part.
- A page reads through the functions of the store, on 1 read-only connection.
- A page asks no model. So no page waits for a model.
- A list reads its rows in bulk and pages them. Confidence is computed for all rows in 1 pass, not 1 fact at a time.
- A page reads only what it shows. The signals of "Overview" come from counts over indexed columns, and the page keeps no per-day series.
- The health of the MCP endpoint comes from counters in the service process, not from a scan of the log files.

A page works without the browser script. The script only adds the automatic refresh, the dialogs, the chart tooltip and a key to reach the search box.

The timing run measures every page on a seeded wiki of 10,000 facts.

### Reads not counted

Usefulness and confidence measure the reads that consumers choose. A read by the operator is not a consumer event.

The console reads through other functions of the store than the MCP tools. These functions write no read row, no search row and no session. The connection of a page is read-only, so it cannot write a row by mistake. The search page runs the consumer search, and that search writes no row either.

### No model call

Every number and every text on a page comes from the store or from the service process. A page has no path to the model questions of the worker.

The search page computes the vector of the query with the embedding model in the process. The consumer search does the same. This is not a question to a model.

### Operator actions in the queue

The worker owns every table that the process reads or writes. A direct write to one of these tables can land between 2 steps of a submission.

So the reindex and a start of a job each become a request of kind "operator edit". The worker takes the request in queue order. It builds the change in code, with no model question.

The operator writes a note with each action. The change row of the action holds the note as its reason. The console checks the action before it sends it. A check that fails in the worker is a race with another change, and the request ends as rejected with the reason.

The cost is a delay of up to 1 request. The page shows the request as queued until then.

### Plain words

The operator keeps a wiki and does not develop WikiFact. So a page names each step by what it does, in the words of the design documents. Examples:

- The kind of a request shows as words: submission, lookup repair, operator edit, cleanup.
- The model questions on the settings page show by what they ask.
- The document of an operator edit or a cleanup request is data that code wrote. A page shows it in words, with links to its facts.
- A job shows by a verb phrase: "Merge duplicate facts", "Rebuild the search index" (owner, October 16, 2026: the page names stay clear to a reader who does not know the code).

### Stored text

The operator checks what the worker did. A paraphrase hides what the worker did. So a page shows the stored text with no change: the justification, the change text, the reasoning, the summary and the reject reason. The page escapes the text for the browser and changes no word.

On the page of a fact or a request, a long text is never cut. A list cuts a long text, and the full text is on the page of the object.

A rejected request shows its reject reason and the summary of the judgment. The change row stores no other text of a rejection.

### Local edits only

1 function decides whether the console may write. It reads the mode and the host of the service. The edits are on only in local mode on this machine. There, the MCP endpoint beside the console already accepts submissions and new wikis from any local process. In every other case the pages show no form, and the service refuses each form.

A browser sends a form from any web site. So a page on another site could send a console form to the port of the service. Each form passes a check of its origin:

- A form that the browser marks as cross-site is refused.
- A form whose origin names another host or port is refused.
- A form with neither mark passes, for example a form from a terminal client.

A refused form writes nothing.

### Wiki growth

The page "Overview" opens with the search quality (the primary metric) and shows the wiki growth after it: growth is the expected change in quality over time (owner, October 16, 2026; "Stage" was not a clear label). The block "Wiki growth" shows the trend, so it shows rates of each stretch, never values counted from a start (the owner, October 20, 2026: "the whole point of this is to see trends"; the running value from the start of the span hid the trend and looked like the start of a wiki). It has 2 charts stacked on 1 x axis, the count of searches of the wiki so far, over the span of the page ([The span of the signals](#the-span-of-the-signals)):

1. **Live facts:** a line of the count of live facts after each point. It shows the size of the wiki and whether it still grows.
2. **Change per search:** 2 series of bars, additions and corrections. The span is cut into stretches of a round size (1, 2, 5, 10, 20, 50 ... searches, at most 50 stretches). Each stretch ends at a multiple of the size in the count of searches of the wiki, so the x labels fall on round counts; the first and the last stretch of a span can hold fewer searches. Each bar is the additions (or the corrections) received during that stretch divided by the searches of the stretch. A growing wiki shows high addition bars that fall; a mature wiki shows low bars, with corrections at or over the additions.

The hover of a point shows the values of that point or stretch. Beside the charts stand 3 stats: the live facts now (with the change over the span under it), and the additions per search and the corrections per search over the whole span. A wiki with a long log keeps a bounded count of points. The x axis is a count, not a date, so a quiet week leaves no gap ("Activity, not time").

The data comes from the search log and the request rows. The reading of the growth is the hover text of the number "Additions per search" beside the chart.

### Search quality

The first block of "Overview" shows the distribution of the reads per search (4 bars: 0, 1, 2, 3 or more) on the left. On the right is the subsection "Poor searches" with 3 counts, each with its share. The block shows no reading line: the reading of "Poor searches" is the hover text of "Facts the search missed" (owner, October 16, 2026). The reads per search have no reading ([The test of the reads per search](#the-test-of-the-reads-per-search)). The 3 counts:

- **Searches with no result:** the searches that returned nothing, shown as "A of B searches". They are not in the histogram: a search with no result has nothing to read. The usage research of October 16, 2026 (finding 4) showed that "0 reads" mixed 2 causes: a search that returned nothing, and a search whose results the agent did not open.
- **Searches with no read:** the searches with results and a minted id that led to 0 linked reads, shown as "A of B searches with a minted id".
- **Facts the search missed:** the change requests received after a search whose target fact the search did not list (the owner's correction of October 16, 2026: a correction of a fact the search listed is the loop working, not a search fault; only a request whose target the search did not list shows a miss). The search of a request is the search that its `searchId` names ([lookup.md](lookup.md), "Minted ids"); a request that names no search is not counted. The target fact is the fact a duplicate points to, or the fact of each new version or deletion the request wrote. A request that wrote only a first version of a new fact has no target and is not a miss; a request that is both a new fact and a correction is a miss only through its corrected fact. A split request is not counted; its children are. Shown as "A of B change requests after a search".

The owner replaced "Duplicates per change request" with these 2 on October 16, 2026: the old figure confused. Both measure whether the search finds what the wiki has.

A fault of the search goes to the developer. The operator cannot fix the search index. A reading on the page names no role.

### Cost

The third block shows the cost in dollars per write and the share of the cost spent on change requests that wrote nothing. A token count is not comparable across models, so the signal is in US dollars, from the price table of the service (`config/prices.json`, in USD per million tokens, shared with the question runner). A model with no price counts at $0, and the block says how many calls that is. The tokens come from a store of the token counts of each model call of the worker ([updates.md](updates.md)). The log line of a change holds the counts today, but the log rolls, and a page does not scan log files ([Fast page](#fast-page)).

The cost of a model call is its input tokens at the input price, its cache write tokens at the input price times the cache write factor (1.25, the 5-minute cache), its cache read tokens at the input price times the cache read factor, and its output tokens at the output price. A split by kind is a detail for the request page, not for the signal.

### The span of the signals

Every rate on "Overview" is over a span of use, not a span of days. The page has 1 control with 2 values:

| Value | Span |
|---|---|
| Last 200 searches | The last 200 searches. The change requests in the time between the first and the last of these searches. |
| All | Every search and change request of the wiki. |

The growth chart follows the span too. Over "Last 200 searches" it starts at the first search of the span, so it shows the recent progression in place of a line that the whole history keeps flat.

### Service health

The page "Service health" answers the questions that the operator asks, in the order he asks them (the owner's verdict of October 16, 2026: the page had random statistics in panels and served no use case). It keeps the present apart from the history, and it shows data with levels, not verdicts: the page has no verdict line. The requirement "Data and interpretation" is about the readings of Overview; this page holds data, and the color of a number is the level of its rule, not a reading. Top to bottom:

1. **Is anything wrong?** No panel: the status line under the heading. 1 line per row that is not ok, in the color of its level, with its detail and since when ("Failing. The worker has not polled for 3 min."). When every row is ok, nothing is under the heading: no "All good." (the owner's verdict of October 16, 2026). The verdict badge stays on the heading.
**The Operation page.** The console has 2 pages: the Overview, the state of the wiki, and the Operation page, the state of the service. The page "Service health" becomes "Operation", and the page "Jobs" becomes its last section, so the top bar has 2 tabs. The page puts the 2 parts of the service side by side, each with the present above its history:

| | MCP server (left) | Queue worker (right) |
|---|---|---|
| Now | Reachability: the time of the last tool call. The tool calls and the failed tool calls of the last 15 minutes. The search time, p95 and p50, of the last 15 minutes, against the bar of 100 ms. | The state, with the pause control at the right of the title. The queue length and the estimated wait. The current rate: the change requests processed in the last hour. |
| History, 24 hours | The tool calls per hour, above the search time per hour, on 1 time axis. The failed tool calls of the 24 hours. | The change requests processed per hour, above the queue length at the end of each hour, on 1 time axis. Under the charts: the failed change requests, the restarts and the time per change request. |

"Processed" counts the requests that ended as accepted, duplicate, rejected or failed. A split is not counted: its children are. The chart says so in its caption. The 15 minutes of "now" show a change at once; the hour of the earlier design hid a fault for up to 1 hour. The 2 charts of a column share their x axis, so a peak of the calls lines up with the search time of the same hour, and a peak of the queue lines up with the rate that drains it. The jobs table follows the 2 columns at full width, as on the page "Jobs" today. The route of Jobs sends the operator to that section.

The text below describes the blocks that the Operation page keeps: the status line, the levels, the pause and the jobs.

2. **The present**, a row of 2 panels with no note beside the title; the titles say what the panel holds and the window, never a question (the owner's verdict of October 16, 2026). "Reachability, last hour" holds the stats Tool calls (the tool calls of the last hour, "N failed" under it; a failed tool call is a call the service could not answer: an unexpected error or a timeout, and a call the service refused with a reason is answered, not failed, the owner's verdict of October 16, 2026) and Search time (the p95 of the searches of the last hour, "p50 N ms, bar 100 ms" under it). "Queue worker, now" holds the stats State (running, paused or stopped, "polled N s ago" under it) and Queue (the count, in ink, "no wait" or "N min wait" or "N h wait" under it), and, at the right of its title, the control of the queue: 1 compact button, "Pause" or "Resume", that opens a dialog ([The pause of the queue](#the-pause-of-the-queue)). The State stat beside it shows the state, so the button carries the verb only. The queue is load, not a fault (the owner's verdict of October 16, 2026: on the live service 606 queued requests read "Failing. A submission waits about 5 h" while the worker was fine and busy): it has no row, no level and no line in the status line. The search time and the tool calls have the same window: the rolling last hour. When the endpoint fails, the agents lose the wiki and nothing else tells the operator.
3. **The history**, a row of 2 panels (the owner's verdict of October 16, 2026: "Last 24 hours" was 2 things, the failures and the performance). "Failures, 24 hours" holds the stats Failed change requests, Failed tool calls and Restarts (by the service since it started, "since start" under it, [deployment.md](deployment.md), "Worker restart"). Under the stats, the failed change requests with their error in a table, only when there is at least 1; else nothing more in the panel (the zeros say it). "Worker performance, 24 hours" holds Change requests processed ("N per hour" under it) and Per change request. There is no requeue button and no restart button: the service starts a stopped worker again, and a failed change request stays as a record for the developer. The pause toggle of "Queue worker, now" is the only control of the worker.
4. **How busy is it?** The panel "Load and response time, 24 hours": 3 charts of 1 series each, side by side: the tool calls per hour, the p95 of the search time per hour against the bar of 100 ms, and the change requests that the worker processed per hour. There is no split by tool and none by outcome: that is activity and the quality of the agents, and belongs on Overview (owner, October 16, 2026). Every chart names its axes: "hour" with "calls", "ms" or "requests" here.

**The scale of "Search time per hour" (issue #11).** The chart keeps every search in it, the first search after a restart too: that search loads the embedding model and takes seconds, and it is a true fact about the service that the operator must see. A log axis would not do: the p95 values are read against the bar of 100 ms, a log axis makes a 100 ms hour and a 400 ms hour look near, and its middle label is no round number. The axis is capped instead: its top is the smallest nice top (as for every chart) that holds the bar and 2 times the median of the hours that have a search, so the normal hours of about 100 ms use the plot and stand apart from the axis. An hour over the cap is clipped: its point sits on the top edge of the plot, with a triangle marker and its true value written beside it, and the tooltip of the hour keeps the true value. The line goes up to the marker and down again, so the slow hour reads as a spike that leaves the chart. A chart with no hour over the cap looks as before. The cap lives in the line chart (the option `capMultiple`), not in the page, so another chart can take it.

**Levels in color.** A stat whose number has a rule shows the number in the color of its level: green for ok, amber for warning, red for failing. The stats with a rule are State (the worker row; a worker that waits out a rate limit of the model shows "paused" in amber with "rate limit, until" and the time of the reset under it, with the date when the reset is on a later day, because a session limit is a wait, not a fault; a worker that the operator paused shows "paused" in amber with "operator" and the time of the pause under it, so that the operator does not forget the pause),  Search time (ok under the bar, warning over it), the "N failed" under Tool calls (the failed tool calls row, the last hour), Failed change requests (the failed change requests row), Failed tool calls of the 24 hours (by its own count: ok at 0, warning over 0, not by the rule of the last hour) and Restarts (ok at 0, warning over 0). The stats with no rule, Tool calls, Queue, Change requests processed and Per change request, stay in ink. The color carries the level: no level word shows under a stat, and the status line names the row.

The data of the endpoint comes from the calls that the store keeps, 1 row per call, over the last 24 hours in buckets of 1 hour. A restart of the service does not reset them, so the page is not empty after a deploy. The store keeps the rows for 7 days.

#### The pause of the queue

The operator pauses the queue to stop the work of the worker by hand, for example before a measurement or during a fault of the model. The button opens a dialog that says what the pause does and asks for a note. The dialog is the confirmation: a pause is undone with 1 click, so no preview page follows. While the queue is paused, the Queue stat says "on hold" in place of a wait that would be false. The pause is 1 key in the store of the wiki, so it stays after a restart of the worker or of the service. The worker reads the key before it takes a request. A request that runs finishes first. Then the worker starts no request, no cleanup and no job. The worker stays alive and polls, so the pause is not a fault. `requestChange` still queues each request, and its answer has a `warning` that the queue is paused. "Resume the queue" removes the key, and the worker takes the next request at its next poll.

#### The batch

The requirement "Batch visible" ([requirements/updates.md](../requirements/updates.md)): the Operation page shows the progress of the batch and the state of its reconciliation. The worker processes the submissions in batches. A batch is staged, then promoted: its changes are in a staging set that no reader sees, until 1 promotion writes them to the wiki. So the panel "Batch, now" is 4 stats: the requests done of those taken, the changes staged and not yet promoted, the stale reruns, and the state of the reconciliation and the promotion as pending, running, promoting or done; after a failed promotion, one more line with the error (see "The batch, a panel"). A batch starts when it is full or when its oldest submission waited 60 s. The operator can also start a batch at once, for example before a measurement.

- **The button "Run a batch now", in "Queue worker, now".** A second compact button beside "Pause" at the right of the title. It has no dialog: a batch only runs earlier the work that the worker runs anyway, so there is nothing to undo. The click writes 1 key in the store, and the worker starts a batch with the queued submissions at its next poll. With no queued submission, the button is disabled. The pause is the stop: it stops the batches too.
- **The batch, a panel "Batch, now".** It shows the newest batch, at full width under the row of the present, because it is the work of the worker now. It has 4 stats: "Done", the requests done of those taken ("9 of 10", under it "requests"); "Staged changes", the changes in the staging set ("14", under it "in the staging set"), which the promotion writes to the wiki; "Stale reruns", the requests whose first write was refused as stale and that run again after the promotion; and "Reconciliation", as pending, running, promoting or done. It has no table: a staged change is not on the wiki, so the page lists none. With no batch run yet, the panel is gone. When the promotion of a batch failed, the panel also has 1 line under the 4 stats, in amber (a warning, as a rate limit: the worker recovers by itself, so it is not red): "The last batch was dropped at" the time, with the date when it is not today's, and the error, then "Its requests run one at a time." The line shows only while those requests run one at a time. It is gone when that run ends, or when a batch ends, because it would then say what the worker no longer does.

The page has no check of the index, the schema or the database, and no log tail. No use case of the requirements names them, so the page holds neither.

The status pill on every page shows the short answer. It reads the worker state, the failed change requests and the failed tool calls of the last hour. The queue is load, not a fault, so a long queue does not change it. The verdict of a wiki, the status line and the pill rest on these 3 rows. It links to Service health.

### Jobs

The page "Jobs" lists each job in 1 table: the name, how often it runs, the last run, the next run and the result. The jobs today:

| Job | Every | Next run |
|---|---|---|
| Cleanup, 1 row per check (there is 1), named as a verb: "Merge duplicate facts" | The check has its own number of writes since its last run, and the repairs of its last run have ended ([cleanup.md](cleanup.md)); the lead says so once, and the column shows the number of writes. | The condition: "in N writes". |
| Rebuild the search index (the reindex) | Manual. | None. |

Both triggers are dynamic. So "next run" shows the condition, not a time. The operator cannot change a schedule.

The operator can start a run at once. "Run" on the cleanup row queues a full cleanup run; "Run" on the reindex queues the reindex. Each start is an operator edit request in the worker queue ([Operator actions in the queue](#operator-actions-in-the-queue)), with a note. The result column links to the request of the last run. The requirement "Operator start" of [cleanup.md](cleanup.md) is met on this page.

### Data and interpretation

A reading of the data can be wrong. The operator must see at a glance which part is measured and which part is a reading, and how sure the reading is. The method, left to the orchestrator by the owner:

- A number shows in the style of data. Its exact definition shows on hover or focus of its label, in the words of [The signals](#the-signals).
- An interpretation is 1 sentence that reads the current numbers. The verdict is a color: the number that has a rule shows its level color, and the sentence is the hover and focus text of that number, the same mechanism as the definition of a label (owner, October 16, 2026: the reading lines left the page; the chip "assumed" was unclear, and then the word "unverified" had no purpose). The color is the data's level, the hover text is the reading, so the operator sees at a glance which part is measured and can read why on demand. The hover shows no status. A number whose data cannot say anything, or that has no rule, has no hover text. Where a block has no good or bad ("Wiki growth"), the reading is the hover text of its number with no color. A static note under a number is not an interpretation (owner, October 16, 2026).
- All interpretations are in 1 list in the code, each with its status and its test, as the developer's record. A test result changes 1 entry.
- An interpretation whose test fails goes. Its data stays.

## Pages and the shell

The server renders every page. The reasons:

- The console shows tables and text to 1 operator.
- Each address is a whole page. A link in a chat or a report opens the object with no state in the browser.
- The cost is 1 round trip for each control change, on the local machine.

Each object has its own address. The address holds the filters and the sort.

The shell is the same on each page of a wiki:

- The wiki switcher.
- The 2 tabs: Overview and Operation (the jobs are the last section of Operation).
- The status pill.
- The "More" menu with the tools: Search, Requests, Settings and Export.

The tools and the pages that serve them:

| Tool | Pages |
|---|---|
| Spot-check: search as a consumer does, read a random sample, read 1 fact with its history | Search, Fact. |
| Check what the worker did with 1 request | Requests, Request. A fact's history entry links to its request. |
| Open any page from a link, and export the facts | Every page has an address. Export is in the More menu. |

The Wikis and Settings pages serve [wikis.md](wikis.md).

Removed from the console, because they answer no question of the requirements: the Structure and Pulse pages; the Facts list, Change and Compare pages; the histograms of age, confidence and versions; the links between facts, the hubs and the isolated facts; the flags of the shape; the usefulness column; the chart of the reads of a fact; the ranking view of the search; the rates per day and the series per day; the time per request; the patterns; the fact edit forms; the requeue button and the restart button; the checks of the index, the schema and the database, and the log tail.

## Look

The data is the loud thing. Lines, borders and headings stay 1 step off the surface. The rules:

- 1 style sheet holds the look, and 1 script holds the behavior. A page adds markup only through shared parts.
- Each color has a light and a dark value.
- A page reads first and acts second. A write form opens in a dialog from a button. Settings is the only page with open forms, because its job is the edit.
- Each job has 1 pattern. Examples: a dialog for a write, a menu for a list of links, a fold for rare detail, a chip for a status.
- Type reads comfortably: small text (table text, labels, notes, markers, stat lines) 14 px, body 15 px, the content of a result 16 px, the search box and the content of a fact 18 px, the panel title 16 px, the page heading 20 px, a stat value 28 px (the owner's verdict of October 16, 2026: the type was too small). [technical/console.md](../technical/console.md), "Tokens", holds the scale.
- A page works on a narrow window. Only a table scrolls sideways.
- The scroll bar gutter is always reserved (`scrollbar-gutter: stable`), so the top bar and the content stay put between a short page and a tall one (the owner's verdict of October 16, 2026).
- Each control works from the keyboard and shows its focus.

## Decisions

| Decision | Reason |
|---|---|
| The server renders every page, in the service process. | 1 operator reads tables and text. Each address is a whole page. The service already holds the stores. |
| A console read writes no read row, no search row and no session, and asks no model. | Usefulness, confidence and the signals measure consumers. A page must cost nothing. |
| The console does not edit facts. | The wiki corrects itself through its agents. The operator reaches the wiki through an agent, as every person does. Decided by the owner on October 16, 2026. |
| A job start and the reindex go through the worker queue. | The worker owns the tables of the process. A direct write can land between 2 steps of a submission. |
| No requeue button and no restart button. | The service starts a stopped worker again by itself. A failed request is a record for the developer. Decided by the owner on October 16, 2026. |
| A toggle pauses and resumes the queue. | The owner wants to stop the queue by hand. Decided by the owner on October 17, 2026. |
| The pause of the queue is a direct write of 1 key of `meta`, not a queued request. | A queued pause waits behind the queue that it must stop. The worker reads the key only between 2 requests, so the write cannot land inside a request. |
| A page shows the stored text of the worker, with no word changed. | The operator checks the worker. A paraphrase hides what it did. |
| A page names each step in plain words. | The operator keeps a wiki and does not develop WikiFact. |
| Edits work only in local mode on this machine, and each form passes an origin check. | The MCP endpoint beside the console already takes writes from local processes. A browser sends a form from any site. |
| A page works without the browser script, except the refresh and the dialogs. | The script adds only what a round trip cannot give. |
| An item is on a page only when its answer changes something that someone does. | The wiki corrects itself through its consumers. A feature with no action repeats that loop. Decided by the owner on October 16, 2026. |
| Every rate divides by use: per search, per session, per change request, per write. Never per day. | A rate per day mixes the state of the wiki with how busy the agents were. Decided by the owner on October 16, 2026. |
| A page distinguishes hard data from interpretation, by the method of [Data and interpretation](#data-and-interpretation). | A reading of the data can be wrong. The operator must see which part is measured and how sure the reading is. Decided by the owner on October 16, 2026; the method is the orchestrator's. |
| A read links to its search through an id that the search minted for the result, and a submission through the id of the search. | A link through the MCP session crossed the context windows of 1 process. A minted id is exact and needs no setup. Decided by the owner on October 17, 2026; replaces the link through MCP sessions of October 16, 2026. |
| The console does not show the adoption of the wiki by the agents. | The service sees 1 session per Claude Code process, and the subagents share it, so no count of the console measures adoption. The usage test measures it. Decided by the owner on October 17, 2026. |
| The health of the endpoint comes from the tool calls in the store (`tool_calls`), over 24 hours. | A page does not scan log files. The counters were in the memory of the process, and a deploy restarts the service several times a day, so the panel was empty after each one and useless. Decided by the owner on October 16, 2026. |
| The span of a signal is the last 200 searches or all. | 200 searches is about the count of agent searches outside the fill on 2026-10-29 (216), so the recent span shows the current use, and 1 search moves a share by 0.5 points. |
| The token counts of the worker are stored in the wiki, not read from the log. | The log rolls. The cost is a signal over the whole life of the wiki. |

## Open points

- The count of 200 searches of the recent span is a first guess. They are settings in the technical layer, and the first 1,000 searches of the dogfood wiki decide them.
