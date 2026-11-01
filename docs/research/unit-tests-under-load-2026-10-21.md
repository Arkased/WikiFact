# Unit tests under CPU load (2026-10-21, issue #48)

Three runs of `npm run check` that ran while the PC had other load exited 1 and the failed test was not recorded ([check-speed-2026-10-21.md](check-speed-2026-10-21.md), "Round 6"). This note records the tests that fail under a made load, their causes and the fix.

## The load

`npx vitest run --reporter=json --outputFile=.cache/load-run-<n>.json` on a PC with 12 logical cores (vitest uses 50 percent of them, `maxWorkers`), with a node script beside it that keeps worker threads in a busy loop until the run ends. Each load process ends by itself after 5 minutes at most. 6 loaded runs in all.

| Run | Load threads | Result |
|---|---|---|
| 1 | 24 (more than the owner's limit; the script was then cut to 4 threads, and it ended with the run) | 9 tests and 3 more suites failed (below) |
| 2 | 4 | 1 test failed: `eval/speed.ts results file` |
| 3 | 4 | passed (code with the speed test fix) |
| 4, 5, 6 | 4 | passed (code with both fixes) |

## Failed tests, causes, fixes

1. `__tests__/eval/speed.test.ts`, "writes a JSON file with the shape the eval promises" (run 2, error `Command failed: node --import tsx eval/speed.ts 200 --fake ...`). `eval/speed.ts` exits 1 when the p95 of the searches is not under `SPEED_BAR_MS` (100 ms). The test ran it with `execFileSync`, which throws on exit 1, so the load that slows the search past the bar failed a test of the shape of the results file. This is a wall-clock verdict inside a unit test (code standard, section 8). Fix: the test reads the results file and no longer depends on the exit code (`spawnSync`); a crashed run writes no file, and the assertion that the file exists then fails with the `stderr` and the `error` of the run as its message. The bar itself stays in the eval, not in the unit tests.
2. `eval/lib/__tests__/pool.test.ts`, 5 tests of "the CLI transport reports rate limits and timing" and "a config directory of its own per child" (run 1 only; error `Test timed out in 5000ms`). Each starts real node child processes (`fake-claude.mjs`) and had the default 5 s test timeout. The start of a child is not a bound under test. Fix: the 2 describes use `PROCESS_START_TIMEOUT_MS` like every other process test.

3. `__tests__/eval/entry-points.test.ts`, "bulk-test with --wiki leaves the folder of the environment as it was" (run 1; the listing of `<home>/wikifact` differed from the listing before the run). A race between test files, not a time limit, so it can fail without load. All the files of a run share the run folder as `homedir()` (`__tests__/global-setup.ts`) and run at the same time. `eval/bulk/__tests__/args.test.ts` writes fake wikis under `<home>/wikifact/wikis` while `entry-points.test.ts` lists that folder before and after its child run. Fix, in 1 place: `__tests__/setup.ts` (it runs once per test file) points `HOME` and `USERPROFILE` to a fresh folder per file under the run folder; child processes inherit them. The tests that used the shared home need no change beyond that; `envs.test.ts` now asserts that the home lies inside the run folder, not that it is the run folder. The other test files that read `homedir()` (`eval/lib/__tests__/pool.test.ts`) only read it. Proof with no load: the 3 files together, 3 runs, all passed (16 tests each run).

The bar of #48 is the load of 4 threads. The 4 failures below happened at 24 threads on 12 cores, which is beyond what the owner allows; they are out of the scope of #48 and go to `docs/future.md`. This work did not change them and no cause was proven:

- `__tests__/requirements/console.test.ts` "Reads not counted" and `__tests__/requirements/updates.test.ts` "No duplicates" and `eval/questions/__tests__/sets.test.ts` "result file reads every result file": `Test timed out in 5000ms` (in-process work over the default timeout).
- `__tests__/console.test.ts`: `no listening line` (the child did not print its line within 60 s).

If one of these fails in a later check, the likely first step is the same: find the wait that the load breaks.

## Proof

Final code (all 3 fixes), `npm run check -- --full` with a new load of 4 busy threads beside each run (a node script that ends by itself after 5 minutes at most; after each run no load process was alive):

| Run | Load | `npm run check -- --full` |
|---|---|---|
| 1 | 4 threads | exit 0 |
| 2 | 4 threads | exit 0 |
| 3 | 4 threads | exit 0 (178 test files passed) |

The earlier loaded runs of the unit tests alone (runs 3 to 6 in the first table) also passed.
