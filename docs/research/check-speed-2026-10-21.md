# Speed of `npm run check`, 2026-10-21

The measurements of issue #41. All times are wall seconds on the owner's machine (12 threads, Windows), taken one step at a time with nothing else running on the repo. "Before" is `build` at v0.1.73; "after" is branch `fix-41`.

## Result

- The unit test step takes 59.8 s before and 45.0 s after (full run, 169 files, 1896 tests). The 4 slow files of the issue each take less than 5 s now.
- `npm run check -- --full` (every step at the same time) took 56.1 s on the measurement of `fix-41`, and 61.8 s and 72.7 s on the code of round 5 (the load of the machine varies the time by up to 2x).
- A scoped check of a change to 1 file under `src/` runs the tests that reach that file and every process test (a test whose value imports reach `child_process`, `execa` or a package of the repo that spawns by itself: the MCP SDK stdio client, `fkill`, `pid-port`, `ps-list`): 86 process tests of 170 test files, so 86 of 170 files run for `src/service/registry.ts`. The browser test does not run. On the code of round 6 the scoped check takes a median of 69.1 s against 83.3 s for `--full` (17% faster, not 25%): see "The scoped path, end to end" and "Round 6". The rule that keeps the scope safe (a process test can start any code, so none is left out) is the one that takes the saving.
- Typecheck, lint, format, the requirement check, the standard check and knip are unchanged by this work. Their cold-cache times differ by run-to-run noise (lint 39.6 s against 29.7 s; the code of those steps did not change). Lint has no cache.

## Time of each step, alone

| Step | Before (`build`), cold cache | Before, warm cache | After (`fix-41`), cold cache | After, warm cache |
|---|---|---|---|---|
| typecheck | 11.1 | 3.2 | 8.4 | 3.1 |
| lint (always in full) | 39.6 | none (lint has no cache) | 29.7 | none |
| format check | 8.7 | 1.5 | 6.9 | 1.5 |
| check:requirements | 1.5 | | 1.2 | |
| check:standard | 1.7 | | 1.4 | |
| check:dead (knip, 2 runs) | 3.4 | 2.8 | 2.8 | 1.9 |
| test (full) | 59.8 | | 45.0 | |
| test:ui (browser) | 28.0 | | 28.2 | |

Cold means `.cache/` was deleted before the run. Each cell is 1 run. The `after` test step ran with the JSON reporter, which does not change the time noticeably.

Knip stays at 2 runs. `knip --production --include dependencies,unlisted,binaries` is a different mode (only the production entry files count) and knip has no option that reports both modes in one run; the 2 runs take 1.9 s warm.

## The 4 slow test files

The "before" times are those of the full run in the issue (124 s of wall time, a loaded machine); the "after" times are of 1 full run on this branch (45 s of wall time, 6 workers).

| File | Before | After | Tests (before, after) |
|---|---|---|---|
| `eval/benefit/__tests__/run.test.ts` | 49.3 s | 2.0 s | 11, 9 |
| `__tests__/requirements/evaluation.test.ts` | 22.4 s | 4.2 s | 2, 2 |
| `__tests__/eval/corrections.test.ts` | 16.4 s | 3.4 s | 13, 14 |
| `eval/benefit/__tests__/verify.test.ts` | 8.7 s | 2.4 s | 5, 5 |

`evaluation.test.ts` stays the closest to 5 s: "Benefit measured" starts the real `eval/benefit.ts` through `tsx` (1.4 s of start-up alone), which is the process boundary that the requirement names ("1 command"), so it cannot go in process. Alone it takes 3.6 s. `corrections.test.ts` gained 1 test (a run with no `limit` covers every task of the data, with an idle consumer: 0.15 s).

## The 15 slowest test files after the change

The reading is from the test titles and, for the files that this work touched, from the bodies. No test was removed: none of the 15 repeats another test beyond what the table says, and all 4 slow files are already under 5 s.

| # | File | Time | What it proves | Does another test repeat it |
|---|---|---|---|---|
| 1 | `scripts/__tests__/check.test.ts` | 5.8 s | The lock waits and hands over in turn; a failed kill is reported only when the root is alive; a bad orphan record is logged and deleted; the scoped command line is built right; its test step runs for real through `npm exec -- run-p` (5.7 s of the 5.8 s, a vitest inside vitest). | No. `__tests__/check.test.ts` proves the same parts with real processes; this file proves the logic with a mocked `fkill`, and the record validation and the real command line only here. |
| 2 | `__tests__/check.test.ts` | 4.8 s | With real processes: a hard-killed holder frees the lock; the steps tree is killed on a stop; the record file lives and dies with the steps; an orphan is killed only when pid and start time match. | No. The process boundary is the proof. "Passes on the exit code" (0.1 s) is repeated by the exit-code asserts of the record tests, but costs nothing. |
| 3 | `src/console/__tests__/health-page.test.ts` | 4.2 s | The Operation page: each stat, color and status line of the MCP server, queue worker and batch panels (45 tests of about 90 ms each, a jsdom parse per test). | No. `__tests__/requirements/console.test.ts` "Service health" and "Queue pause" assert the contract of the requirement, not the stats and colors. |
| 4 | `__tests__/requirements/evaluation.test.ts` | 4.2 s | "Eval order": 1 command runs the evals in order and stops at the first failure. "Benefit measured": the command runs the same cases through 2 arms and reports the figures. | Partly. `__tests__/eval/all.test.ts` "does not run the benefit test after a failed test" proves the skip that "Eval order" also asserts; the requirement test must assert its contract, so both stay. |
| 5 | `__tests__/eval/corrections.test.ts` | 3.4 s | Seed data; the counts of a run with the stub consumer; parallel and sequential runs count the same; no limit runs every task; the stop hook. | No. The two runs of "counts" and "parallel" share a setup but assert different things. |
| 6 | `__tests__/eval/all.test.ts` | 3.3 s | The launcher `eval/all.ts` with fake children: `--only`, `--skip`, flag pass-through, `--continue`, the index file, benefit last. | Partly the failure stop of "Eval order" (row 4). The flags and the index file only here. |
| 7 | `eval/replay/__tests__/replay.test.ts` | 3.1 s | The replay harness: the results file, the pass flag, the partial flush, the parallel limit, a stub that answers the script. | No. |
| 8 | `__tests__/requirements/console.test.ts` | 3.1 s | One test per console requirement, at the contract level. | The pages are also asserted in `src/console/__tests__/*-page.test.ts`, with the details of the page; the requirement test asserts only the contract, and `check:requirements` demands it. |
| 9 | `src/console/__tests__/overview-page.test.ts` | 3.0 s | The Overview page: search quality, growth and cost blocks, the span control and the axes. | No. |
| 10 | `__tests__/console.test.ts` | 2.9 s | The real `serve --wikis` process: console routes, local edits, the Origin refusal, MCP still served beside the console. | No. `__tests__/mcp/service.test.ts` proves the MCP calls over HTTP; "still serves MCP" here proves the console mount does not break them. |
| 11 | `__tests__/mcp/stdio.test.ts` | 2.4 s | The real `serve` over stdio, driven by the `mcp-client` script, leaves 1 ended session row. | No. It is the only test of the stdio transport. |
| 12 | `eval/benefit/__tests__/verify.test.ts` | 2.4 s | The proof of the cases with a real git worktree: 4 verdicts and a clean tree for each step. | No. `run.test.ts` proves the run with a fake repo. |
| 13 | `src/mcp/__tests__/server.test.ts` | 2.4 s | The shape and the stored rows of each MCP tool, in memory. | No. The service and stdio tests prove the transport, not the shapes. |
| 14 | `__tests__/updates/cli-transport.test.ts` | 2.3 s | The CLI transport against a fake binary: arguments, retries, timeouts, each failure result. | No. `eval/lib/__tests__/pool.test.ts` uses the transport as a part of the pool. |
| 15 | `__tests__/requirements/updates.test.ts` | 2.1 s | One test per updates requirement; "Durable queue" kills a real child, "No duplicates" runs the real worker. | The unit tests of `src/updates` prove the pieces; these prove the contract. |

The reasons for the times are fixed costs, not repeated work: jsdom per page test (rows 3, 9), the start of a `tsx` process (rows 4, 10, 11), a git worktree (row 12) and the nested vitest (row 1).

## The scoped path, end to end

Measured on the code of round 5 of #41 (branch `fix-41b-r5`), on a clone whose branch `build` was set to the tip of the branch, with 1 change to a comment in `src/service/registry.ts`. The command was `npm run check`. It runs typecheck, lint (all files), format check, the requirement check, the standard check, knip (2 runs) and `test:related -- <files>` with the changed file and the 85 process tests; no browser test, no `test` (full).

| Measure | Value |
|---|---|
| Process tests | 85 of 169 test files (listed by `findProcessTests` in `scripts/lib/check-scope.ts`, 1.3 s to compute) |
| Scoped `npm run check`, change to `src/service/registry.ts` | 60.2 s, 113.5 s, 57.4 s (3 runs, exit code 0; the 113.5 s run had a loaded machine, vitest reported 104 s of its own duration against 44 s in the 57.4 s run). Median 60.2 s. 3 earlier runs on a loaded machine took 114 to 131 s, 2 of them with timeout failures of tests, and are not counted. |
| `npm run check -- --full` | 61.8 s, 72.7 s (exit code 0). Median 67.3 s. |
| `npm run check:standard` | 1.4 s, 1.5 s |

The scoped run is about 10% faster than `--full` by the median (60.2 s against 67.3 s), and by the best runs it is 57.4 s against 61.8 s (7%): it is not 25% faster. The test step alone shows the saving (44 s against 59 s in the vitest reports, 26%), but the wall time is set by lint (about 30 s) and by the slowest test files, which are process tests and run in both. Half of the test files are process tests, because the rule reads imports and the `src/console/` and `src/updates/` tests import modules that import `execa`. The runs vary by 2x with the load of the machine, so a difference of 10% is inside the noise.

The line of the scoped command carries the 85 process tests (about 3,700 characters), so the limit of the paths on the line is a number of characters (`MAX_SCOPED_LINE`, 7,000) and not 80 files.

The first run of the clone failed in knip (`src/cli.ts` unused) because the clone was reached through the short Windows path (`KEVINL~1`); with the long path it passes. This is a property of the folder, not of the check.

## What this work changed

- Lint reads every file on every check and has no cache. Round 6 added an ESLint cache to the scoped check; it was removed, because the type-checked rules read other files.
- A process test is a test whose closure of value imports (the TypeScript syntax tree; `import type`, `export type` and type-only specifiers skipped; every relative import followed with `resolveImport` in `scripts/lib/check-scope.ts`) reaches a module that imports `child_process`, `node:child_process` or `execa`, or one of the packages in `PROCESS_MODULES` (`@modelcontextprotocol/sdk/client/stdio.js`, `fkill`, `pid-port`, `ps-list`: their sources import `execa` or `child_process`). `findProcessTests` in `scripts/lib/check-scope.ts` finds them and the scoped check runs all of them when at least 1 code file changed. No file carries a header (the `// spawns:` headers of rounds 1 to 4 failed review twice: a header on a generic wrapper is false, and the walk counted type-only imports). The limit: a package of the repo that spawns by itself and is not in `PROCESS_MODULES`, and a specifier built at run time, are not seen; only `--full` closes that.
- `scripts/__tests__/check.test.ts` runs the test step of the scoped command line for real, and `stepsArgs` of `scripts/check.ts` builds the line.

## Round 6

The lint cache that round 6 added was removed (lint has no cache). The lint rows below that name a cache were measured with it; the numbers of the scoped check include its cache, and the lint row without a cache (39.8 s) is the lint of the check now.

Measured on the code of round 6 of #41 (branch `fix-41b-r6`), with the method of round 5: a clone whose branch `build` is the tip of the branch, 1 change to a comment in `src/service/registry.ts` (a different comment text for each run, so the file is new to the caches), `npm run check`, 3 runs, median. One untimed run came first to fill `.cache/`. The docs-only change is a word in the first line of `docs/future.md`, on a tree with no other change. Every run exited 0.

| Measure | Runs | Median |
|---|---|---|
| Scoped `npm run check` (change to `src/service/registry.ts`; 1 code file and 86 process tests) | 78.7 s, 69.1 s, 59.4 s | 69.1 s |
| `npm run check -- --full` | 83.3 s, 85.7 s, 81.2 s | 83.3 s |
| `npm run lint` alone, warm cache, tree unchanged | 4.0 s, 3.5 s, 3.5 s | 3.5 s |
| `npm run lint` alone, warm cache, 1 changed file | 8.8 s, 8.8 s, 8.7 s | 8.8 s |
| `npm run lint` alone (no cache, as today) | 39.8 s (1 run) | 39.8 s |
| Docs-only `npm run check` (no unit test, no browser test) | 14.0 s, 9.7 s, 9.6 s | 9.7 s |

- The scoped check is 17% faster than `--full` by the median (69.1 s against 83.3 s), with the lint cache working on the scoped side only. The saving of the cache on the lint step is 39.8 s to 8.8 s for 1 changed file.
- A first batch of the same measurement ran while other jobs loaded the machine: the scoped runs took 255 s, 186 s and 267 s and exited 1 (not reproduced; the next run on the same code passed with 86 test files; the failed test was not recorded, so these 3 runs are not diagnosed: issue [#48](https://github.com/Arkased/WikiFact-dev/issues/48) tracks them), and `--full` took 185.6 s, 166.0 s and 115.3 s. Those runs are not counted, and show again that the load of the machine varies the time by 2x or more. Their docs-only runs (61.7 s to 138.2 s) also kept the code change in the tree, so they were not docs-only runs.
- The ESLint cache does not see the code of a local rule or a plugin version by itself. A test with `eslint-rules/no-magic-numbers.js` changed gave 0 new errors from the cached run and 258 from the run with no cache; with the hash of the local rules, the lock file and the tsconfig files in the `settings` of `eslint.config.js` (`lintCacheKey`), the cached run gives the 258 errors.
- The cached lint can miss an error of an unchanged file whose type-derived result changed through an edit in another file. `--full`, `npm run ship` and a check that cannot read git lint with no cache.
