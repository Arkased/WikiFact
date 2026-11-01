# Technical

Technical layer. The third of the 3 layers of the docs ([../requirements/README.md](../requirements/README.md)): the schema, the contracts, the limits and the code paths that build the design.

Files, 1 per feature:

- [storage.md](storage.md): Storage: the tables, the indexes and the migrations.
- [lookup.md](lookup.md): Look up facts: the tools `search` and `getFact`, the retrieval pipeline and the scores.
- [submit.md](submit.md): Submit a change: the tools `requestChange` and `getRequest`.
- [ingest.md](ingest.md): Ingest documents: the command `npm run ingest`, its extraction call and its output.
- [wikis.md](wikis.md): Manage wikis: the management tools of the service, the wikis folder and the mounting.
- [updates.md](updates.md): Process submissions: the queue, the worker, the pipeline, the write transaction and the failure modes.
- [cleanup.md](cleanup.md): Cleanup: the finders, the questions and the repairs.
- [questions.md](questions.md): Question tuning: the question test plan and the quality presets.
- [evaluation.md](evaluation.md): System evaluation: the one command for every eval, and the benefit test.
- [deployment.md](deployment.md): Deployment and access: install, local mode, service mode, logging.
- [release.md](release.md): Release: the ship command.
- [publication.md](publication.md): Publication: the export to the public repo and the demo copy.
- [console.md](console.md): Operator console: the mount, the routes, the pages, the edits and the visual design.

The requirements ([../requirements/README.md](../requirements/README.md)) say what the wiki must do. The design ([../design/README.md](../design/README.md)) says what the system does. This layer says how.

## Stack and assumptions

| # | Assumption | Reason |
|---|---|---|
| A1 | TypeScript on Node.js 22, with `better-sqlite3`. | The MCP reference SDK is TypeScript. `better-sqlite3` loads the `sqlite-vec` extension and ships FTS5. |
| A2 | One wiki is one SQLite file. | The [lookup design](../design/lookup.md) picks SQLite. One file per wiki keeps wikis separate with no extra code. |
| A3 | The update worker is one process per database, separate from the MCP server. Any number of MCP server processes serve consumers. | The worker is one global job: it must see every change before the next. Consumers come and go, and more than one connects to one wiki, so the MCP server cannot own the worker. A lock file next to the database stops a second worker at start. Local mode ([Local mode](deployment.md#local-mode)) keeps this split: `serve --with-worker` starts the worker as a child process, and the lock file decides which server's child runs. |
| A4 | The update agent is deterministic code. It calls Claude for narrow questions only, one question per call. Model and effort per question are open ([O6](README.md#open-settings)). | Code can orchestrate every step. A model is needed only for a fuzzy judgment, and a narrow question is cheap and testable alone. |
| A5 | The embedding model runs in-process. | Retrieval works offline and gives the same vectors on each run. See [O4](README.md#open-settings). |

Principles behind the assumptions, which every later section follows: deterministic code orchestrates, and a model is called only for a fuzzy judgment that code cannot make; each model call is one specific question with a fixed prompt and a structured output, and no model gets a tool loop where a sequence of narrow questions covers the task; each question defaults to a cheap model, and a test picks the model per question ([Test plan](questions.md#test-plan), [O6](README.md#open-settings)); a read that the system makes for its own maintenance records no usage metric, and only a read that a consumer chose counts ([Store API reads for the update agent](updates.md#store-api-reads-for-the-update-agent), [Usefulness](lookup.md#usefulness)); a check that depends on no other step runs before any expensive step, and a fault in the input is a rejection with a reason, never a retried attempt ([Queue and worker](updates.md#queue-and-worker), [Step 1. Claim check and gather](updates.md#step-1-claim-check-and-gather)).

## Components

| Component | Module | Duty |
|---|---|---|
| Environment | `src/env.ts` | The only file that reads `process.env`. Parses the variables once and loads the `.env` files. |
| Config | `src/config/` | `wikifact.json`, its schema and the quality presets (`config/presets.json`). |
| MCP server | `src/mcp/` | The 4 consumer tools. Validates input. Records retrieval events. Also the HTTP mode and the worker child process. |
| Store API | `src/store/index.ts` | The one door to SQLite, and the only module that runs SQL. `search`, `getFact`, `getDependents`, `applyChange`. |
| Index | `src/store/indexer.ts` | Keeps FTS5 and the vector tables in step with `fact_versions`, inside the write transaction. |
| Embedder | `src/embed/` | `embed(texts: string[]): Promise<Float32Array[]>`. |
| Change queue | `src/store/queue.ts` | A table in SQLite. `requestChange` inserts a row and returns. |
| Update worker | `src/updates/worker.ts` | Its own process, one per database, held by a lock file (`lock.ts`). Takes one request at a time (`run-once.ts`). Runs the update agent. Commits. |
| Update agent | `src/updates/agent/` | Deterministic steps with narrow model calls ([Pipeline](updates.md#pipeline)). Assembles one change set. |
| Questions | `src/updates/questions/` | One file per model question under `specs/`: prompt, output schema. The caller, the transports and the model table sit beside them. |
| Eval harness | `eval/` | The speed test, the correction test, the question sets, the replay test. Imports `src/` through its index files. |

## Open settings

Defaults until a test decides.

| # | Decision | Default | Set by |
|---|---|---|---|
| O1 | Confidence weights and half-life | `W_UPDATE = 1.0`, `W_CONFIRM = 1.0`, `W_READ = 0`, 30 days. The correction test of October 9, 2026 gave about 1 correction per read at every cap, but each task handed the consumer its observation, so every read came with a reason to correct. The test cannot show whether an uncorrected read is a signal. `W_READ` stays 0 until a run with tasks that carry no observation. | Correction test, second form |
| O2 | Rank weight and usefulness half-life | `W_USE = 0.01` as a bounded multiplier, `USE_BOUND = 0.1`, 30 days. The first wiki (75 facts, October 10, 2026) showed the additive `0.01` put any fact with 1 read above every unread fact on every query; the bounded multiplier put the right fact first on 5 of 6 answerable queries against 3 of 6. The F17 probes found a new fact in 4 of 10 cases at caps 10 and 20, and in 0 of 10 at cap 5. The confirm event is the repair for the other 6, as [System failures](updates.md#system-failures) says. | Relevance, speed and correction tests |
| O4 | Embedding model | `Xenova/bge-small-en-v1.5` through `@huggingface/transformers`: 384 dimensions, 512-token input window | Replay test: it fails when the candidates miss a same-scope fact |
| O5 | Enforcement of corrections in the consumer harness | Tool descriptions alone. The correction test gave 18 to 20 corrections in 20 tasks without the hook and 20 of 20 with it, which is inside the noise of one run. The example stop hook stays in `eval/` and is not required. | Correction test |
| O6 | Model and effort per question | Set by the question sets of October 9, 2026, after the label and prompt review, through the CLI transport, with `claude-haiku-5-5` (released October 7, about $0.10 input and $0.50 output per million tokens) as a candidate, and decided by the replay ([Quality presets](questions.md#quality-presets)). The summarize mode pools every run of a configuration over all result files, 3 to 15 runs per configuration. The `standard` preset, the default, takes the best mean for the classification and judgment questions and the budget rule for the drafting questions ([Quality presets](questions.md#quality-presets)): Q1 Opus 5.5 medium, 94.0 percent over 6 runs; Q2 Opus 5.5 medium, 100 over 3; Q3 Haiku 5.5 low, 95.0 over 3; Q4 Sonnet 5.5 high, 98.7 over 3; Q5 Haiku 5.5 low, 96.1 over 6; Q6 Haiku 5.5 low, 98.3 over 3; Q7 Sonnet 5.5 medium, 92.9 over 6; Q8 Opus 5.5 medium, 100 over 3; Q9 Haiku 5.5 low, 100 over 3; Q10 Haiku 5.5 low, 100 over 3. The `budget` preset is `claude-haiku-5-5` on Q3, Q5, Q6, Q9 and Q10 at low and on Q1, Q2 and Q8 at medium, with Q4 on Sonnet 5.5 high and Q7 on Sonnet 5.5 low, 90.0 percent (Q1) to 100 percent, no question under the bar. The standard table differs from budget on Q1 (Opus 5.5 medium), Q2 (Opus 5.5 medium), Q7 (Sonnet 5.5 medium) and Q8 (Opus 5.5 medium). The `premium` preset takes the best mean on every question: it differs from standard on Q3 (Sonnet 5.5 low, 100 over 3; Opus 5.5 low also scores 100, and Sonnet is cheaper), Q5 (Opus 5.5 medium, 100 over 3) and Q6 (Sonnet 5.5 low, 100 over 3; Opus 5.5 low also scores 100, and Sonnet is cheaper). The tests of #66 added Sonnet 5.5 low and Opus 5.5 low to Q6, Q9 and Q10, 3 runs each: Q6 Sonnet 100 and Opus 100 against Haiku 98.3; Q9 Sonnet 96.8 and Opus 100 against Haiku 100; Q10 100 for all 3. The tests of #66 then added 3 runs of 2 more configurations to each of Q2, Q3, Q4 and Q8, at the effort of the earlier pick: Q2 at medium, Haiku 98.0 and Opus 100; Q3 at low, Sonnet 100 and Opus 100; Q4 at high, Sonnet 98.7 (Haiku 5.5 takes no high effort, so it ran at medium: 85.7, under the bar); Q8 at medium, Sonnet 98.0 and Opus 100. Every question now has at least 2 pooled configurations, and no pick carries `singleConfiguration`. One call of every question costs about 1.8 cents at budget, 4.8 cents at standard and 7.1 cents at premium (the sum over Q1 to Q10 of the cost per case and run of the pick of each question, from [`summary-2026-10-27T18-48-53.000Z.json`](../../eval/questions/results/summary-2026-10-27T18-48-53.000Z.json)). No replay has run on the current `budget` and `premium` tables. The `budget` pick of Q1 fails 8 cases in every run and 2 more cases in some runs. Haiku 4.5 takes no adaptive thinking, no effort and no fallback, and is no longer a default anywhere. The tables live in `config/presets.json` ([Quality presets](questions.md#quality-presets)). | Question sets, then replay. A prompt change to a question reruns its whole matrix, because the cheapest passing model moves with the prompt. The `standard` picks of Q2, Q3, Q4, Q6, Q8, Q9 and Q10, the `premium` picks of Q3, Q5 and Q6 and the `budget` pick of Q1 rest on 3 runs, so a tie there is thin evidence. |
| O7 | Result cap of `search` | 10. Cap 5 hid every new fact from the F17 probes. Cap 20 gave the same corrections and the same F17 hits as cap 10 at a larger result size. | Correction test, with caps 5, 10, 20, October 9, 2026 |
| O8 | Vector candidates before the rescore, `VEC_CANDIDATES` | 100. Recall against the exact top 10 is 0.84 on synthetic facts at 100k, and 0.96 at 200 for about 10 ms more. | Replay test: raise it when the 1-bit index drops a same-scope candidate |
| O9 | Limits of the cleanup ([Cleanup](cleanup.md#cleanup)) | `CLEANUP_CAP` 20 requests per finder per run, `CLEANUP_EVERY` of the duplicate fact finder (50 writes), 3 nearest facts per fact. | The first cleanup runs on the dogfood wiki: the count of verdicts with no change per finder, and the model cost per run |
