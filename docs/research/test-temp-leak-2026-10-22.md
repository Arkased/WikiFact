# Leftover run folders of test runs, 2026-10-22

The measurements of issue #53. All numbers come from the owner's machine (Windows 10) on 22 October 2026, from the code of `build` at v0.1.79.

## Result

- A stopped run leaves its run folder. This is the cause of the leftover folders (cause A). It is confirmed by experiment.
- A failed delete (cause B) did not occur in 2 runs of `npm run check -- --full`. It is not confirmed. No process held a leftover folder.
- Each `npm run check` starts 2 vitest runs (`npm test` and `npm run test:ui`), and each run makes 1 run folder. A stopped check therefore leaves up to 2 folders.
- Since commit 6ae6609 (21 October 20:40) the run folder is in `.cache/test-runs/` of the worktree, not in Temp. The leftover folders now collect in each worktree, and `npm run clean-temp` run in one checkout cleans only that checkout's `.cache/test-runs/` and Temp.

## The run folders found

Temp (`os.tmpdir()`) held 100 folders `wikifact-run-*`, with 9,849 entries at the top level of Temp. All 100 were created on 21 October between 16:18 and 21:56, so all are older than 2 hours. None was deleted by this work.

| Entries in the folder | Folders |
|---|---|
| 0 (empty) | 13 |
| 1 to 99 | 46 |
| 100 to 699 | 11 |
| 700 or more (up to 790) | 30 |
| Total | 100 (26,624 entries) |

Observations on the 100 folders:

- The modification time of 13 empty folders equals their creation time. A failed delete cannot give this, because a delete removes the content first and changes the modification time. An empty folder is a run that was stopped after `global-setup.ts` made the folder and before the first test file made its home folder.
- Many folders were created in pairs, 0.1 to 0.3 s apart (for example 21:12:24.43 and 21:12:24.79, 17:22:11.68 and 17:22:11.80). A pair is the `test` step and the `test:ui` step of one check (`vitest.ui.config.ts` has the same `globalSetup`).
- The folders with 1 to 7 entries match the `test:ui` run: the 3-entry folders found in worktrees hold `playwright_chromiumdev_profile-*`, `wikifact-console-js-*` and `wikifact-console-ui-*`. The folders with 700 to 790 entries are the `test` run, stopped late.
- 19 folders were in the `.cache/test-runs/` of 10 worktrees under `.claude/worktrees/` (counts from 0 to 958 entries). 8 of them were younger than 2 hours and belong to running checks of other agents. They were not touched.

## Experiments

### A1. Stop of `npx vitest run`

I started `npx vitest run` in the worktree, waited 20 s, and killed the tree with `taskkill /T /F`. During the run the folder `wikifact-run-Ox6lcH` held 123 entries. 4 s after the kill it held 126 entries (the last workers were still writing while they died), and it stayed. No process named the worktree afterwards. The teardown of `global-setup.ts` did not run. Result: cause A is confirmed.

### A2. Stop of `npm run test:ui`

I killed `npm run test:ui` 25 s after the start in the same way. The folder `wikifact-run-jU7A3I` (7 entries) stayed. No process named it after the kill (the browser was killed with the tree). Result: the same as A1.

### B. Two runs of `npm run check -- --full`

Both runs passed (179 test files, 1,987 tests, and 20 UI tests). Neither printed `EPERM` or the warning "the run temp folder ... is not deleted". After each run the only folder in `.cache/test-runs/` was the folder of A1 (and the folder of A2 after the second run). The run folders of the checks were deleted. Result: no failed delete was seen, so there is no process to name. The `EPERM` of 21 October is not reproduced.

I deleted my 2 stopped folders at the end of the work.

## The log of the orphan cleanup

`process-cleanup.log` in the common git folder has 3 lines. 2 lines are kills of `load-test-51.js` of another worktree (pid 8052 and pid 27996). 1 line is a `set-priority` line. No line names a test run, vitest or a run folder. The orphan cleanup has not killed a test tree so far, so it is not the source of the 100 folders.

## Causes

### Cause A: the run is stopped before its teardown (confirmed)

The teardown is the function that `globalSetup` returns, and it runs only when vitest ends by itself. `taskkill /T /F` ends vitest, its workers and the browser without a teardown, so the folder stays with the content made so far. `scripts/check.ts` kills the whole tree on a stop (`killTree`) and on the next check (`killOrphan`), and an agent or a Bash timeout that stops a check causes the same. A stopped check leaves 2 folders (`test` and `test:ui`). A folder that is stopped late holds up to 790 entries at its top level (the issue counts about 4,000 entries with the nested ones).

Proposed fix: at its start, `global-setup.ts` deletes the run folders in `.cache/test-runs/` that are older than 1 hour (by modification time), so the next run cleans the stopped ones and no manual step is needed. The cleanup must run for the `test` and the `test:ui` config, must not fail the run when a delete fails, and section 8 of the code standard changes first.

### Cause B: the delete fails (not confirmed)

The teardown deletes with `rmSync` and 5 retries of 100 ms, and it logs a warning and does not fail on an error. 2 runs left no folder. A folder that a failed delete leaves is not empty in practice: the delete removes content first, and the empty folders found have an unchanged modification time, so they are cause A. The `EPERM` of 21 October was seen once, in code that is older than the move to `.cache/test-runs/`; the files that can be locked at the end are the browser profile of `test:ui` (a closing browser) and the SQLite files of a test server that closes late. I did not see any of them locked.

Proposed fix: none now. The fix of cause A also removes a folder that a failed delete leaves, because the next run deletes it after 1 hour. When the warning "the run temp folder ... is not deleted" appears in a log, name the file in the warning and look for the holder then.

## Facts for the fix of cause A

- The cleanup must cover `.cache/test-runs/` of the worktree only. A run in another worktree has its own folder, so no run deletes a folder of another running check.
- The folders in Temp (the 100 above) come from code older than 6ae6609. `npm run clean-temp` deletes them (it matches the prefix `wikifact-run-` in Temp too).
- The done condition of #53 (10 runs of `npm run check`, 1 stopped, no run folder older than 1 hour) holds only if the run after the stopped one starts more than 1 hour later or the age limit is lower for folders whose run is dead. A folder of a stopped run is old by its modification time only 1 hour after the stop; a shorter limit is not safe for a slow run in the same worktree.
