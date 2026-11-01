# Cleanup

Design layer. The requirements are in [../requirements/cleanup.md](../requirements/cleanup.md). The technical details are in [../technical/cleanup.md](../technical/cleanup.md).

## Approach

The cleanup repairs the shape of the wiki: it finds 2 live facts that state the same thing and merges them. It runs apart from the submissions. A submission runs no check, and most of what the cleanup finds is not urgent.

Each repair has 3 parts:

1. Code finds the candidates. A finder is 1 kind of error.
2. 1 narrow model question judges each candidate.
3. Code writes the repair.

There is 1 finder:

| Finder         | Code finds                                                                | Judge                                                      | Repair                                                                                               |
| -------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Duplicate fact | The nearest live facts of each live fact, by meaning. Closest pair first. | Q1: which of the nearest facts have the scope of the fact? | The merge step of the update worker: 1 merged version on the kept fact, and a deletion of the other. |

A finder queues 1 `cleanupRepair` request for each candidate. The worker runs these requests at once after the finder, in the cleanup step of [Free for submissions](#free-for-submissions).

### Duplicate fact

The duplicate fact finder is the later check that the requirement "High volume mode" asks for: a batch can leave a duplicate fact, and this finder finds and merges it (#22). It also repairs a duplicate that a Q1 miss leaves on the path of 1 request at a time (F1).

1. Code finds the candidates. For each live fact, its 3 nearest live facts under `neighborDistance` of the store config. A pair is 1 candidate, and the closest pair comes first.
2. Q1 judges each candidate. The claim is the header and the content of the newer fact of the pair. The candidates of Q1 are its nearest live facts. Q1 is the question that matches a scope on the path of 1 request at a time, so the finder needs no new question.
3. Code writes the repair. When Q1 returns a fact, the request runs the merge step of the update worker on the 2 facts ([Step 3. Merge](../technical/updates.md#step-3-merge)). When Q1 returns no fact, or Q2 of the merge step finds that the 2 contents are about another subject or attribute, the request records a verdict for the pair. Q1 reads headers only, so Q2 is the guard against a merge of 2 sibling facts: a wrong merge deletes a true fact, and a missed duplicate costs only a later run.

The rule of the interval reads the rate of duplicates from the repairs, so after a large batch the finder runs more often until it finds no duplicate. The Jobs page names the finder "Merge duplicate facts".

A finder also skips a candidate that a queued or running `cleanupRepair` request already holds.

A `cleanupRepair` request loads its candidate again before it asks the judge. When a fact of the candidate is gone, or the pair no longer fits the finder, the request finishes with no write.

## How the design meets each requirement

### Free for submissions

The queue is interruptible between 2 requests, and the interval is the schedule of the cleanup. So the worker looks for a due finder after each request ends, and after a poll that finds no queued request. The state of the queue does not decide whether a finder runs. The cleanup is 1 step between 2 requests:

1. The worker runs each queued repair, 1 at a time, in queue order.
2. It settles the intervals of the finders whose repairs have all ended.
3. When a finder is due, it runs the finder, then runs the repairs that the finder queued, as in 1.

Then the worker takes the next request. A submission waits at most for 1 run of a finder and its repairs: 20 repairs of 1 to 3 model calls each, about 1.5 to 4 minutes, 1 time in each interval. Under the fill load of 2026-10-17 to 2026-10-21, a rule of "only when the queue is empty" ran no check for 96.5 hours.

A stop, a pause or a rate limit ends the step. The repairs that did not run stay queued, and the next step runs them first. A crash leaves them queued in the same way.

A finder is not due while the repairs of its last run are still queued or running. The interval of the next run follows the repairs of the last run, and a repair that has not run yet cannot count.

Outside the cleanup step, the worker takes every queued submission before a queued repair. With the step, a repair waits in the queue only after a stop, a pause, a rate limit or a crash. A submission that arrives after a run does not wait behind its repairs. The order of the queue is:

1. The operator's edits (`operatorEdit`), because the operator waits for the console and an edit is short and has no model question.
2. The submissions and the lookup repairs (`lookupRepair`, which belongs to a submission), because a consumer waits for them.
3. The repairs (`cleanupRepair`).

Inside each group the order is the order of arrival. So the operator's queued edits keep their order, and so do the submissions. "Every change sees every change before it" holds in this order: a request sees every request taken before it. A repair is safe to run late, or after a submission that arrived later. It loads its candidate again when it runs and skips one that no longer holds, so a later submission that ran first only makes it stale, never wrong.

The trigger is a write, not a clock. Facts change only through writes. A clock runs on a quiet wiki for nothing, and it delays the repair after a busy one.

A worker that starts on a wiki with no record of an earlier run records the current position and runs nothing. So a worker on a wiki with an old backlog does not start it by itself. The operator starts that run (see "Operator start").

### Interval per check

Each finder has its own interval, counted in writes. A finder is due when the wiki has that number of new writes since its last run. Only the writes of submissions and operator edits count. A write of a repair does not count, because it brings no new content: when it counted, the cleanup fed itself (#64).

The interval follows the repairs of the last run of the finder. A run with no repair doubles it, a run with 3 or more repairs halves it, and a run with 1 or 2 keeps it, within a floor of 10 writes and a ceiling of 2,000 writes. The aim is that 1 run of the finder expects 1 or 2 real errors. A rare error is looked for less often, a common one more often. The operator's run counts as a run, and so does a run that the cap cut.

The base rate changes with the wiki and with the prompts, so the rule reads it from the repairs. The first interval is a seed.

The interval is the cost control. The finder stays wide, and the model question stays the judge. No distance limit separated the real duplicate pairs from the false ones, and no rule on names found them. A code rule that narrows a finder leaves misses that no run ever sees.

A candidate that changes 2 times before its finder runs is examined 1 time. The writes under an interval wait for the next writes, or for an operator run.

### Cap per check

1 run queues at most a set number of repairs for each finder. The finder ranks its candidates, and its cap cuts its list. So no distance band needs a calibration.

A finder whose cap cut its list runs again after the next write, when the cut run wrote 3 or more repairs (the number that halves the interval). Its interval does not apply then. So a real backlog drains run after run. The drain stops when the cap cuts nothing, or when the cut run writes fewer than 3 repairs; the interval then applies. A finder with a low yield waits for the interval, which is the cost control.

### No repeat check

When a judge finds that a candidate needs no change, the worker records a verdict for that candidate. The verdict holds the position of the wiki at that time. A finder skips a candidate while a verdict covers it and the candidate has not changed in a way that the judge reads.

The verdict of the duplicate fact finder covers 1 pair of facts. It ends when the header or the content of 1 of the facts changes. Any other new version of a fact does not end it. A rule that ended a verdict on any new version let each repair end the verdicts of its neighbors, and the finder found the same candidates again (#67).

### Operator start

The operator starts a cleanup run from the console. On the Jobs page ([console.md](console.md), "Jobs"), "Run" on the cleanup row runs the duplicate-fact finder now, also when its interval has not passed. This is the first run on a wiki with an old backlog. The Jobs page names the finder as a verb, "Merge duplicate facts". It also shows its interval, its last run, its next run ("in N writes") and the result of its last run.

The operator writes a note, sees a preview of the request, and confirms. The console then queues an `operatorEdit` request. The worker runs it in queue order, as every other request.

The console writes no table of the worker. The worker owns the tables that the pipeline reads and writes. So an operator run goes through the queue, and does not run in the service process.

## The cleanupRepair request

Every finder ends in the same request kind, `cleanupRepair`. 1 kind gives 1 path for the audit and for the console:

- A repair writes a change through the normal write transaction, with no dependents step, because no claim changes.
- A request that writes nothing finishes with no error. A log line gives the finder, the result and the reason.
- A queued repair of a check that the cleanup no longer has ends rejected as unsupported, with no write and no question.
- A model failure follows the normal retry rule of the worker.
- The console shows a `cleanupRepair` request as any other request, with its document in words and with links.

## Decisions

| Decision                                                                         | Reason                                                                                                                       |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| The cleanup runs in the worker between 2 requests when a finder is due, not as a scheduled task. | The queue is interruptible, and the interval is the schedule. A steady load does not stop the cleanup, and the deploy does not change. |
| A finder is not due while the repairs of its last run are queued or running. | The next interval counts the repairs of the last run. |
| The repairs of a run run at once after the finder, in the same cleanup step. | Under a steady load, the repairs behind the submissions waited for hours, and the duplicates stayed. |
| The trigger is a write, not a clock.                                             | Facts change only through writes. A clock runs on a quiet wiki for nothing and delays the repair after a busy one.           |
| The finder stays wide, and the model question stays the judge.                   | No distance limit and no name rule separated real errors from false ones. A narrow code rule leaves misses that no run sees. |
| Each finder has its own interval, set from the repairs of its last run.          | 1 run should expect 1 or 2 real errors. The rate of errors changes with the wiki.                                            |
| A finder that its cap cut runs again after the next write only when the cut run wrote 3 or more repairs. | A real backlog drains. A finder with a low yield waits for its interval (#64).                                       |
| Only the writes of submissions and operator edits count toward an interval.      | A repair brings no new content. When it counted, the cleanup fed itself (#64).                                               |
| A verdict stops a repeated question on a candidate that did not change.          | A repeated question costs a model call and gives the same answer.                                                            |
| A worker with no record of an earlier run runs nothing.                          | A worker on a wiki with an old backlog does not start it by itself. The operator starts it.                                  |
| The other fact finders (compound facts, missing references) wait.               | They are future features. They fit the same run: a finder, a question, a repair and a verdict.                               |

## Open points

1. Settled: "Free for submissions" is met by the cleanup step: a due check and its repairs run between 2 requests, 1 time in each interval; see that section.
2. The interval comes from 1 rebuild of 1 wiki (86 facts). The [open settings](../technical/README.md#open-settings) list the limits of the cleanup as unmeasured (O9), with the first runs on the dogfood wiki as the trigger to measure them.
3. "Operator start" says "at once". The operator run goes through the queue, so it starts after the requests before it. The console design gives a delay of up to 1 request, about 30 seconds.
4. Settled by the code: a `cleanupRepair` request that writes nothing has the status `done` and no `error`, and its process outcome is `Skipped` (no `changes` row).
