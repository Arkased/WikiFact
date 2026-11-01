# Code standard

The rules for the TypeScript in `src/`, `eval/` and `tests/`. A rule here wins over a habit from another project.

Each rule carries 1 tag that says what checks it:

- `[lint]`: `npm run lint` (ESLint).
- `[script]`: a script of `npm run check`, or `npm run ship` where the rule says so.
- `[review]`: the skill `core:review`. The review checks only these rules.

A bullet with 2 tags has 1 part for each: the mechanical part (for example, that a tag is present) and the part that needs judgment (for example, that the tag says something true).

## 1. Names for fixed sets

A fixed set of names is a TypeScript `enum` with string values.

```ts
export enum Outcome {
  Accepted = "accepted",
  Rejected = "rejected",
  Duplicate = "duplicate",
}
```

- `[lint]` No type is a union of string literals.
- `[review]` No bare string at a use site is a member of a set. A one-off string that is not a member of a set (a header, a file name, a log message) stays a string.
- `[lint]` The enums of `src/` live in `src/domain/enums.ts`, a leaf module that imports nothing, so that no import cycle can form. The enums that only `eval/` or `scripts/` use live in `eval/lib/enums.ts`. No other file declares an enum.
- `[review]` One enum per set: no 2 enums hold the same set.
- `[review]` The string value is the value that goes to the database, the log, the JSON file and the model. The enum name is for the code.
- `[lint]` A zod schema takes the enum with `z.nativeEnum(Outcome)` (or `z.enum(Outcome)` on zod 4). No literal strings appear in the schema.
- `[lint]` A `switch` over an enum has no `default` branch, so that the compiler reports a missing case.

## 2. Module layout

```
config/
  presets.json      the default model settings per quality, written by the question runner
  prices.json       the price table in USD per million tokens, read by the console and the question runner
src/
  env.ts            every process.env read
  paths.ts          the project root
  constants.ts      the named numbers that src/, eval/ and scripts/ share (JSON indent, exit codes, decimals)
  log.ts            the typed log line and the stderr logger
  config/           wikifact.json, the schema and the presets
  cli.ts            the command line entry; cli/command.ts holds the Command type
  domain/enums.ts   every enum of src/
  store/            SQLite: schema, open, read, write, search, queue, scores, indexer, maintenance
  embed/            the embedding model
  mcp/              the MCP server, its tools, the HTTP mode, the management tools and the worker child
  service/          the wiki registry and the routes of service mode ([Service mode](technical/deployment.md#service-mode))
  console/          the operator console ([Mount in the service](technical/console.md#mount-in-the-service)): the route, pages/ with one handler per page, the layout, the health rules
  updates/          the worker, the lock, the pipeline under updates/agent/, the questions
  updates/questions/ one spec file per question, the caller, and transport/ for the transports
eval/               the tests of [Test plan](technical/evaluation.md#test-plan), each test in the technical file of its feature; thin entry files, eval/lib/ for shared helpers
scripts/            project and dev scripts only (ship, deploy, clean-temp, the demo wiki, the console screenshots and timing), not tests, and the check scripts of npm run check
plugin/             the Claude Code plugin ([The plugin](technical/publication.md#the-plugin)): src/ is its self-contained source (own enums.ts, env.ts, errors.ts; imports nothing from src/, eval/ or scripts/), dist/ its built bundles (tracked; `npm run build` makes them, `npm run check:plugin` compares), and the manifest, hooks and command files; its tests are in __tests__/plugin/
eslint-rules/       the local ESLint rules of the [lint] rules that no preset holds, with their tests
fakes/              stubs and fakes shared by the unit tests and the --stub modes of eval/; never in src/
__tests__/          the end-to-end tests, the requirement tests under requirements/, with setup.ts and helpers/
<module>/__tests__/ the unit tests of that module, next to it
wikis/<name>/       one wiki: wikifact.json and its database
```

- `[review]` A file is in the folder that the layout above gives for it.
- `[review]` A module has one concern. A file over 400 lines is a sign that it has 2, and it is split by concern, not by line count.
- `[lint]` Only `src/env.ts` reads `process.env`.
- `[lint]` `src/` never imports from `eval/`, `fakes/` or a `__tests__/` folder.
- `[lint]` `eval/` imports from `src/` through the module index files (`src/store/index.ts`, `src/updates/index.ts`, and so on) or the top-level files, never a deep path.
- `[lint]` Only `src/store/` runs SQL: no other file imports the SQLite driver. Every other module, `eval/` included, goes through the store API.
- `[review]` A unit test lives in the `__tests__/` folder of the module it tests. An end-to-end test, one that spawns a process, runs an entry point or drives the built app, lives in the root `__tests__/` folder. A requirement test (section 8) lives in `__tests__/requirements/`, whether it is a unit test or an end-to-end test. The build excludes every `__tests__/` folder. The unit tests of `plugin/src/` live in `__tests__/plugin/`, because Claude Code copies the whole `plugin/` folder to the machine of each consumer.
- `[review]` A stub, a fake or a fixture that the tests and `eval/` share lives in `fakes/`. A helper that only the tests use lives in `__tests__/helpers/`. Application code offers an injection point (a constructor argument, a factory option) and holds no stub and no environment hook "for tests".
- `[lint]` An index file exports the public surface of its folder and holds no logic.
- `[script]` No file in the repo carries an absolute local path. A path in a result file is relative to the project root with forward slashes.
- `[review]` A file that ships as configuration holds configuration only. The measurement that produced it goes in its own result file, and the config names that file in one `source` line.

## 3. Documentation

Every exported function, class, method, enum and type has a JSDoc block. The block states 3 things:

```ts
/**
 * Writes one version of a fact and its retrieval rows.
 *
 * @param store - the open store
 * @param draft - the version to write; `factId` names an existing fact or a new ULID
 * @returns the seq of the new version
 * @sideEffects one transaction on the store; the embedder runs for the content
 */
```

- `[lint]` `[review]` The block has a first line. The first line says what the function does, in the present tense, in one sentence.
- `[lint]` `[review]` `@param` for every parameter, `@returns` for every non-void return, `@throws` for every `throw`. The `@param` gives the meaning, units and ranges; the `@returns` gives the empty and null cases; the `@throws` gives the error class and when.
- `[lint]` `[review]` `@sideEffects` on every function: `none` for a pure function, else each effect in a short list (writes, reads of the clock or the environment, child processes, network calls, logs, files). The list is true and complete.
- `[lint]` `[review]` A type or an enum has the first line and, for an enum, one line per member when the name does not say it.
- `[review]` No JSDoc restates the signature. "The config" for a parameter named `config` is not a description.
- `[review]` A comment inside a function explains a reason, never a step.

## 4. Types

- `[lint]` No `any`. An unknown input is `unknown`.
- `[lint]` `[review]` No non-null assertion `!`. Handle the undefined case or throw a typed error with a message.
- `[review]` A row read from the database is typed at the read site with one `as` to the row type, because the schema owns its shape. The cast names the row type, never `any` or `unknown`. Every other value from outside the process (a JSON file, the model, an HTTP request) is parsed with zod or a type guard, never cast.
- `[lint]` A function has at most 4 positional parameters. More go in one options object with a named type.
- `[lint]` A return type is written on every exported function.
- `[lint]` An object type is an `interface`, not a `type` alias. A union, an intersection or a mapped type is a `type` alias.
- `[lint]` An array type is written `T[]`, not `Array<T>`.

## 5. Behavior

- `[review]` A library comes in when 2 things are both true: the problem is one every project of this kind has, with a de facto standard library (logging, log rotation, `.env` files, child processes, queues, retries, timeouts, ports, process trees, migrations, argv), and the hand-rolled code would be more than about 20 lines or carry behavior that is easy to get wrong (concurrency, process handling, rotation, a file format, cancellation). Hand-rolled code stays when the behavior is project policy that no library expresses, when it is under about 20 lines of plain logic, or when the library would change a measured result; the reason is written next to the code. A library is maintained and in wide use. A design or a brief that calls for a utility names the library.
- `[script]` `package-lock.json` pins each version. A library goes in `devDependencies` when only `eval/`, `scripts/` or the tests use it.
- `[lint]` A library module (`src/`) does not call `console`. It takes a `log` function or throws.
- `[lint]` `[review]` A magic number has a named constant with a comment on the unit.
- `[script]` No dead code: no unused file, export or dependency. No `TODO` without an issue reference.
- `[review]` No commented-out code.
- `[review]` One name per concept across the code base. The name in the design layer (`docs/design/`) wins.
- `[review]` No abstraction before a caller needs it (YAGNI). An interface, a helper, an option, a parameter, a config key, a flag or a test seam comes in for a caller that exists in the same change. A test seam is the smallest one that the test needs. Production code does not change its shape only to satisfy a test or a check.
- `[review]` Each behavior has 1 place (DRY). A step that each test, module or call site must remember to repeat is a defect of the design: 1 place applies it to all (a setup file, a wrapper, a default). Code that is the same in 2 or more places, beyond about 5 lines, is 1 function. Before new code, search the repo for a function that already does the job.
- `[review]` A design that makes a fault impossible wins over a check that detects it. A check comes in only when no simple design prevents the fault.
- `[review]` No swallowed error. A caught error is rethrown, or logged with its cause. A step that is allowed to fail logs its failure.
- `[review]` A retry names its transient cause in a comment. A retry count or a delay goes up only with a measurement. A retry does not hide a race that the design can remove.
- `[review]` Code handles only the states that can occur. No `try`/`catch` around code that cannot throw, no check of a value that the types already prove, and no fallback value that the design does not name.
- `[review]` A comment says why the code is as it is. It never says what changed, when, or who changed it: the commit message holds the history.
- `[review]` A rename or a move changes all callers in the same change. It leaves no alias, re-export or shim for compatibility.

## 6. Tools

- `npm run lint`: ESLint with typescript-eslint (type-checked rules) and eslint-plugin-jsdoc. The config is the presets plus the `[lint]` rules of this file, and the overrides for tests and plain JS. A rule that a preset does not hold has a comment in `eslint.config.js` that names its section here. Lint runs clean on every commit.
- `npm run format`: Prettier with the repo config. Formatting is not reviewed by people.
- `npm run check:standard`: the `[script]` rules of this file that read the files of the repo.
- `npm run check:dead`: knip, for unused files, exports and dependencies, and for a dependency in the wrong group.
- `[script]` The names of the npm scripts (#101). A script with no group is a command of the daily work or of the operation, and only these have no group: `prepack` (the npm hook of `npm pack`), `build`, `test`, `typecheck`, `lint`, `format`, `check`, `ship`, `deploy`, `ingest`, `clean-temp` and `demo` (it starts the demo wiki of the public repo, beside the `demo:` group). Every other script is `<group>:<name>`, with the name in lower case and words joined by `-`. The groups are `test:` (a part of the tests), `check:` (a step of `npm run check`, also run alone), `eval:` (an eval, with `eval:all` for the suite), `console:` (a tool of the operator console), `demo:` (the demo wiki) and `export:` (the export to the public repo). An npm script that only another script calls has no place in `package.json`, except `check:step`, which `run-p` needs by name. `scripts/check-standard.ts` fails on a name outside this rule.
- The hooks, the gates, the work and review skills and the board tool of Claude Code are not in this repo: they are the plugins `core` and `github-pm` of `Arkased/claude-setup`. The plugin `wikifact` is product code in `plugin/` of this repo. The project values that the plugins read are in `.claude/setup.config.json`. `scripts/` imports its helpers from `src/` and `eval/lib/` (`must`, `errorMessage`, `errnoCode`, `ARGV_USER_OFFSET`, `isMain`, `lowerPriority`); `scripts/lib/pipe-lock.ts` is the check lock and `scripts/lib/project-name.ts` reads `projectName` from the config for the name of the lock pipe. The package ships no file of `.claude/`.
- Agent processes: `scripts/check.ts` and `scripts/ship.ts` call `lowerPriority` (`eval/lib/main.ts`) on themselves, and the eval entry scripts call it too, so that their work runs at low priority. The hooks of the plugin `core` lower the priority of the session and kill the orphans.
- `npm run check`: first takes the check lock, so only 1 check runs at a time over all worktrees of the repo (`scripts/check.ts`). The lock is a server that listens on a name derived from the hash of the absolute common git folder (`git rev-parse --path-format=absolute --git-common-dir`): the named pipe `\\.\pipe\wikifact-check-<hash>` (16 hex of the sha256). The project runs on Windows only: off win32 the check fails at once with a message. The OS frees the name when the process ends, however it ends, so the lock itself has no pid, no take-over and no stale state; a separate record of the steps (below) lets the next check kill an orphan tree. A check that finds the name held prints "waiting for the check of another worktree" and tries again every 3 s. The check closes the server when the steps end. The steps run as a process tree: `execa` starts `npm.cmd` through `cmd.exe`. On Ctrl+C (SIGINT) while the steps run, the check kills that tree (`fkill` with `tree`, `taskkill /T /F`), waits for it to end, and exits with 1 (when the steps exit first, it returns their exit code); it reports a fault of the kill on stderr only when the root of the tree is still alive after the kill, because Windows sends Ctrl+C to the whole console group and children are already ending. Node on Windows emits no SIGTERM, so a hard kill of the wrapper (Task Manager, `taskkill` without `/T`) leaves the tree running. For that case the check writes the pid of the steps and its start time (read with PowerShell `Get-Process`) to `wikifact-check-steps.json` in the common git folder while the steps run, and deletes the file when they end. The next check that takes the lock reads the file; when the pid is alive with the same start time, it kills that tree, prints 1 line, and then starts its own steps. A pid with another start time is not killed. A record that cannot be read, is not JSON, or is not `{pid: positive integer, start: digits}` is logged to stderr and deleted, and nothing is killed. A fault in writing the record is logged and the steps go on. A hard kill in the first second of the steps, before the start time is read and the record is written, leaves an orphan that the next check does not find. When no stop comes, the exit code is the exit code of the steps; a stop that arrives after the steps exited changes nothing. The steps are built by `scripts/check.ts` from the scope of the change (`scripts/lib/check-scope.ts`) and run at the same time with `run-p` of npm-run-all2: typecheck, lint, format check, the requirement check (`npm run check:requirements`, section 8), `check:standard`, `check:dead`, the unit tests and the browser test (`npm run test:ui`). No test reads the wall clock (section 8). The full check passes beside a CPU load of 4 busy threads on the 12 threads of the PC (#48); the tests that fail only at a load of 24 threads are in `docs/future.md`. The scope is the files that differ from the merge base with `build`, committed or not, plus the untracked files. The default check runs the unit tests that import a changed file (`npm run test:related`, `vitest related`) and every process test (below), and runs the browser test only when `src/console/` or `__tests__/console-ui.test.ts` changed. Every other step covers the whole repo (lint reads every file and has no cache; see below). A process test is a test file (a `*.test.ts` file in a `__tests__/` folder that vitest runs) whose value imports reach a module that imports `child_process`, `node:child_process` or `execa`, or a package that spawns by itself and that the repo uses (`PROCESS_MODULES` in `scripts/lib/check-scope.ts`: the MCP SDK stdio client `@modelcontextprotocol/sdk/client/stdio.js`, `fkill`, `pid-port`, `ps-list`). `scripts/lib/check-scope.ts` (`findProcessTests`) reads each project file with the TypeScript syntax tree and follows its value imports: a static `import`, an `export … from`, a `require("…")` and an `import("…")` with a string literal. It skips `import type`, `export type` and a declaration whose specifiers are all `type`, so a type-only import does not pull a module in. It follows every relative import to a project file, a `.js` or `.mjs` file as named too, with one resolver, `resolveImport` in `scripts/lib/check-scope.ts` (its only caller). A process test can start any code of the repo, so the default check runs every process test beside the tests that `vitest related` finds for the changed files, whenever at least 1 code file changed (a change with no code file, no data file and no deleted file, such as docs only, runs no unit test), and no file needs a header. `scripts/check.ts` builds the command line with `stepsArgs`; `scripts/__tests__/check.test.ts` proves the line, and the root `__tests__/check.test.ts` runs its test step for real on 1 small related file (a process tree, section 2). `npm run check -- --full` runs everything, and so does `npm run ship`. The check also runs everything when `package.json`, `package-lock.json`, `vitest*.config.ts`, a `tsconfig*.json` or the test setup changed, when a code file was deleted, when a data file under `src/`, `eval/`, `fakes/`, `scripts/`, `__tests__/` or `config/` changed (tests read it by path), when a `.js` or `.mjs` file changed (tests start those as processes), when the test paths of the line (the changed code files and the process tests) pass 7,000 characters, the room that the 8,191-character line of cmd.exe leaves, and when git cannot name the change. The limit of the default check: the rule reads imports, not the way a process is started, so it is a superset of the tests that start one (a test that imports a module with `execa` and never calls it runs too), and it misses a test that starts a process through a package that spawns by itself and is not in `PROCESS_MODULES`, or loads a module by a specifier built at run time (`import(path)`, a template with a variable): the rule cannot see such an import. A process test is found only if some module in its closure imports a process module by name. Only `--full` and `npm run ship` close that gap. Unit tests use at most half the threads (`maxWorkers: "50%"`). The typecheck (`tsc --incremental`), the format check (`prettier --cache --cache-strategy content`) and knip (`--cache`) keep caches in `.cache/`. Knip runs twice, once for the whole project and once with `--production` for the dependencies that production code uses: knip has no mode that reports both in one run. `npm run lint` (`eslint`) has no cache, and the scoped check and the full check run the same lint over the whole repo. The type-checked rules of a file read other files, so an edit in `a.ts` can cause an error in an unchanged `b.ts`; a cache would not lint `b.ts` again and the error would show only at the ship, which breaks "Lint runs clean on every commit". Lint takes about 40 s. It runs at the same time as the tests, so it adds no time to a check that runs tests. In a check that runs no test, lint is the longest step. This is the gate before a commit. The output of the check (#52): a step that passes prints 1 line, a step that fails prints its full output and then 1 `FAIL` line, and the last line counts the steps: `check: <n> passed, <m> failed, <k> not finished (<s> s)`. A step that wrote no result (run-p stopped it after another step failed, its wrapper died, or Ctrl+C stopped the check) counts as not finished, from the number of steps of the scope; the part `<k> not finished` shows only when `k` is more than 0. The exit code of the check: the exit code of run-p when it is not 0 (a failed step makes its wrapper and so run-p exit with a code other than 0); else 1 when a step is not finished; else 0. Each step writes its result to the fixed folder `wikifact-check-results/` in the common git folder, beside `wikifact-check-steps.json`. The check lock allows 1 check at a time, so a fixed name is safe. The check empties the folder after it takes the lock and before the steps start, so a check that a hard kill stopped leaves no folder in Temp and no stale result. `npm run check -- --verbose` prints the full output of each step as run-p gives it, prints no summary line, makes no results folder, and exits with the exit code of run-p.

## 7. Change process

The rules for a change as a whole.

- `[script]` `[review]` A behavior change has its sentence in the matching file of `docs/technical/` first (and of `docs/design/` or `docs/requirements/` when the design or a requirement changes), and the code cites the heading. Each cited `docs/…md#anchor` resolves to a heading.
- `[review]` A change does only what its issue says. A fault that the work finds outside that scope becomes a new issue.
- `[review]` A bug fix names its cause, reproduced by a test or a measurement. When the cause cannot be reproduced, the issue says "cause not confirmed", and the change adds no code for it.
- `[review]` A decision taken during the work has a record in `docs/decisions/`. Work set aside goes in `docs/future.md` with its trigger and its design.
- `[review]` A pipeline step, a model question or a reject reason is named by what it does in prose and documents, not by its code alone.
- `[review]` In a pipeline, a check that depends on no other step runs before any expensive step, and a fault in the input is a rejection with a reason, never a retried attempt.
- `[script]` `[review]` A behavior change has a unit test that fails without it, written by the rules of section 8. `npm run check` passes before every commit.
- `[review]` An eval or a long run writes a timestamped result file and flushes partial results during the run; a terminal print alone is not a result. Independent model calls run in parallel under a concurrency limit. The model candidates are config, a run is resumable, and one new model runs alone and merges into the prior results. The suite has one entry point, `npm run eval:all`, with the order of its parts in code.
- `[review]` A change to a prompt, a question set or the ranking comes with its measurement: the question runner for a prompt or a set, the relevance eval for the ranking, the replay for the pipeline, with the result file kept and the bar met. A change to a preset table comes from `summarize`, never from a hand edit.
- `[review]` A change to the pipeline runs the real replay at least once; a change to the scope match or the fact draft runs it 3 times.
- `[script]` An eval entry point spawns a server from source, never from `dist/`.
- `[script]` A change to the service, the deploy or the launcher is proved on the machine by `npm run ship`, which writes the proof into `reports/deploys.md` itself ([Ship a release](technical/release.md#ship-a-release)).
- `[review]` A persistence step (a task, a service) is created by the deploy script with the user's click, never by hand from an agent. A stop or a kill checks that the process is ours before it acts.
- `[script]` `[review]` README, `.env.example` and the usage text of the CLI match the code. Each npm script, environment variable and repo path named in README and `.env.example` exists. Each flag of the CLI usage text exists.
- `[review]` No agent reads or names the token file. No secret or token value appears in a log, a result file or a report.

## 8. Tests

`[review]` unless a bullet says otherwise.

A test proves behavior. A harmless change must not break it: a new CSS class, a reworded sentence, a new log field, a constant moved inside its range, a reordered attribute. A test that breaks on such a change is fixed or deleted in the same change.

Tests are of 2 kinds:

- A requirement test protects 1 requirement of `docs/requirements/`. It lives in `__tests__/requirements/<feature>.test.ts`, its name is the name of the requirement, and it asserts the contract of the requirement and nothing more. `[script]` `npm run check` fails when a requirement has no test with its name, or a test in that folder has no requirement with its name. A change that breaks a requirement test changes the requirement first, with the owner's approval.
- An implementation test supports the code beside it, in a `__tests__/` folder next to the code. It has no mapping to a requirement.

- A test asserts what a caller, a consumer, the operator or the next step sees: a return value, a stored row, an HTTP status, the text and the links that a reader of a page reads, the fields of a log line that a reader uses.
- A console page test parses the page (`jsdom`) and finds what it checks by the text, the link target, the label or the role that a reader sees. It never asserts markup, CSS classes, attribute order or the order of strings in the HTML. The test of a part ([Parts](technical/console.md#parts)) may assert the class names that the style sheet selects on, because those are the contract between the part and the sheet.
- A test never asserts the text of a prompt, the prose of a summary or a help text. The question sets measure a prompt. A summary is checked by the names and the numbers it carries, not by its sentence.
- A log line test checks the fields a reader uses with `toMatchObject`. It never checks the whole line, the set of keys or their order.
- A test never repeats a configured value: a limit, a threshold, a preset, a file size, the count of an enum or a list. A boundary test uses the constant by name, one under and one over.
- Exact assertions are for contracts only: the shapes of the MCP tool inputs and outputs, the HTTP statuses, a file that another program reads (checked by the parts that program needs), and the schema constraints, checked through the database (a value outside the enum fails the insert), not through the text of the SQL.
- A test reads no wall clock: no assertion on elapsed milliseconds and no real sleep. It uses fake timers or an injected clock. A test of real concurrency asserts the overlap or the order of events, not their time.
- Tests are of 2 stages:
  - A predeploy test is a test of `npm run check`. It runs before the build, is self-contained in the repo, and touches no deployed environment. `[script]` `__tests__/global-setup.ts` points `HOME` and `USERPROFILE` to the run folder, so code that finds a deployment from the home folder finds none.
  - A postdeploy test is an eval of `eval/` (the benefit test, the bulk test, the speed test and the other evals). It runs against 1 deployed environment that its `--env <name>` option selects from `eval/envs.json`; the default is `local`, the deployment on this computer. It reads a wiki of that environment through a read-only connection or a copy made with the SQLite backup API, and never changes the environment. An eval can also take a wiki file of the test data (`--db`).
- A test that repeats another test, or checks what the type checker already proves, is deleted.
- A test does not assert that a fake or a stub was called, unless the call is the contract: an outgoing message, a model call, a process that is spawned.
- `[script]` A test run uses 1 temp folder of its own, under `.cache/test-runs/` in the repo. `__tests__/global-setup.ts` makes it, points `TEMP`, `TMP` and `TMPDIR` to it, and deletes it at the end of the run. When a file in it is still locked, the delete logs a warning and the run does not fail. A test makes its temp folders with `mkdtempSync` under `tmpdir()` and does not delete them. Application code and the evals delete their own temp folders. A run that is stopped (a kill of `npm run check`, a timeout of the shell) never reaches its teardown and leaves its run folder (#53). So the global setup of each config (`npm test` and `npm run test:ui`) first deletes each run folder in `.cache/test-runs/` of its own checkout that is older than 1 hour. A slow run of the same checkout can take more than 10 minutes, so a shorter age is not safe. A delete that fails writes 1 warning line and does not fail the run. The delete is `cleanStaleRuns(root, now)` in `scripts/clean-temp.ts`, which calls `cleanTemp`; the global setup passes the `.cache/test-runs/` root, and its unit test passes a root of its own under `tmpdir()`. `npm run clean-temp` deletes the folders that older code left in the real Temp folder of the user, in 4 groups, each older than 1 hour: the folders with a prefix: each folder whose name starts with `wikifact-`, whatever the rest of the name is (#77: a fixed list misses the prefixes that a branch, an experiment or an agent adds), and each folder with a prefix of `TEMP_PREFIXES` (the other prefixes that the repo passes to `mkdtempSync`); the browser profiles `playwright_chromiumdev_profile-*` of the UI test, the Vitest folders (a 21-character name that holds only the subfolders `client` and `ssr`), and the folders of Claude Code `Temp\claude\C--Users-*-AppData-Local-Temp-wikifact-*` (#75).
  - `[script]` The cleanup runs by itself: the global setup of each test run calls it on the real Temp folder and logs 1 line with the count of each group. `scripts/run-vitest.ts` reads the real Temp folder before it redirects `TEMP`, `TMP` and `TMPDIR`, and hands it to the global setup in `WIKIFACT_REAL_TEMP`; when the variable is already set, it is used as the folder to clean (a test of the cleanup, or a development run, sets it to a fake folder). A test of the cleanup uses a fake Temp tree only.
  - `[script]` Vitest makes its own temp folder (`join(tmpdir(), nanoid())`, with the subfolders `client` and `ssr`) when it starts, before the global setup runs, and deletes it only when the run closes; a stopped run leaves it in Temp (#74). So `npm test`, `npm run test:related` and `npm run test:ui` run through `scripts/run-vitest.ts`. It makes the run folder under `.cache/test-runs/`, sets `TEMP`, `TMP` and `TMPDIR` to it for the Vitest process, and deletes it when Vitest ends. The global setup uses that folder when `TEMP` already points into `.cache/test-runs/`, and makes its own when Vitest is started by hand. A stopped run leaves only that folder, which the stale-run delete above removes.
