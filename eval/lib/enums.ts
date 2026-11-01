/** Enums that only `eval/`, `scripts/` and the root tests use. The enums of `src/` live in `src/domain/enums.ts`. */

/** The name of one eval test; also the name of its npm script and result folder. */
export enum EvalTestName {
  Questions = "questions",
  Relevance = "relevance",
  Replay = "replay",
  Corrections = "corrections",
  Speed = "speed",
  /** The benefit test: it runs last and only when its flags name a wiki (`--db`). */
  Benefit = "benefit",
}

/** What `eval/all.ts` reports for one test. */
export enum TestStatus {
  Ran = "ran",
  Skipped = "skipped",
  NotRun = "not run",
}

/** The form of a query of the relevance eval. */
export enum RelevanceQueryForm {
  /** A phrase of terms or a claim: the designed form. */
  Terms = "terms",
  /** A question: the tolerance group. */
  Question = "question",
}

/** What the question runner does. */
export enum RunnerMode {
  Run = "run",
  Summarize = "summarize",
}

/**
 * The stage of a question run: the full run, or stage 1 or 2 of the two-stage run.
 * The result files store the stage today as the number 1 or 2 or the string "full", so the
 * call sites must parse both until the files are regenerated.
 */
export enum ResultStage {
  Full = "full",
  One = "1",
  Two = "2",
}

/** Whether a run uses the stub or the real model. */
export enum RunMode {
  Stub = "stub",
  Real = "real",
}

/** The worker of a corrections run: `None` runs no worker. */
export enum WorkerMode {
  Stub = "stub",
  Real = "real",
  None = "none",
}

/** The kind of a critical replay case. */
export enum CriticalKind {
  Duplicate = "duplicate",
  Compound = "compound",
}

/** The agent that consumes the wiki in a corrections run. */
export enum ConsumerName {
  Claude = "claude",
  Sdk = "sdk",
}

/** The group of a case of a question set (technical/questions.md, "Test plan"): where the case comes from. An absent field means `Designed`. */
export enum CaseGroup {
  /** Written by hand for a failure mode. */
  Designed = "designed",
  /** Built from a rebuilt wiki. */
  NormalUse = "normal use",
  /** Harvested from the call log of a running wiki. */
  RealUse = "real use",
}

/** The kind of a hard negative case of a question set (technical/questions.md, "Hard negatives"): the trap that the case sets. */
export enum HardNegativeKind {
  /** The claim denies what the fact says. */
  Negation = "negation",
  /** The claim gives another value for the same scope. */
  ChangedValue = "changedValue",
  /** The claim names the new value and says that it replaces the old one. */
  Supersession = "supersession",
  /** The claim and the fact have the same attribute of another subject, or another attribute of the same subject. */
  ScopeDifference = "scopeDifference",
}

/** What a corrections task name matched in the counted request. */
export enum NameMatch {
  Target = "target",
  Header = "header",
  Terms = "terms",
}

/** The kind of a case of the benefit test (technical/evaluation.md, "The benefit test"). */
export enum BenefitKind {
  Question = "question",
  Task = "task",
}

/** What the wiki holds for a case of the benefit test. */
export enum BenefitGroup {
  /** The wiki has a fact that answers the question, or describes the area of the task right. */
  Held = "held",
  /** The wiki has no fact for the question. */
  Gap = "gap",
  /** The wiki holds a fact that is wrong on purpose (`staleFact`). */
  Stale = "stale",
}

/** The copy of the wiki that a row of the benefit test read (technical/evaluation.md, "The benefit test", "The preload"). */
export enum BenefitCopy {
  /** The copy after the preload rounds: the held and stale questions. */
  Preloaded = "preloaded",
  /** The copy as it was filled: the gap questions, the tasks, and every case when the preload is off. */
  Filled = "filled",
}

/** Why the preload of the benefit test ended. */
export enum PreloadStop {
  /** A round in which the worker accepted no change. */
  NoChange = "no change",
  /** The round count reached `--preload-rounds`. */
  MostRounds = "most rounds",
}

/** What a question asks. */
export enum QuestionType {
  /** Where something is. */
  Locate = "locate",
  /** How something works. */
  Explain = "explain",
  /** Why something is so. */
  Rationale = "rationale",
  /** What happens in a case. */
  Behavior = "behavior",
}

/** How many facts or files a question needs. */
export enum Complexity {
  /** The answer is in 1 fact or 1 file. */
  Simple = "simple",
  /** The answer needs 2 or more facts or files, joined. */
  Complex = "complex",
}

/** What a task of the benefit test changes. */
export enum TaskType {
  Bugfix = "bugfix",
  Feature = "feature",
  /** A change to the code and to the doc that states it. */
  CodeAndDoc = "codeAndDoc",
}

/** The two agents of the benefit test: the wiki tools are the only difference. */
export enum Arm {
  With = "with",
  Without = "without",
}

/** The judge's verdict on an answer or on a diff. */
export enum Verdict {
  Correct = "correct",
  Partial = "partial",
  Wrong = "wrong",
}

/** The label of the labeler on a search in the test of the reads per search (docs/design/console.md, "The test of the reads per search"). */
export enum ReadLabel {
  /** The listed results hold a fact that answers the query. */
  Found = "found",
  /** The listed results hold no fact that answers the query. */
  NotFound = "not found",
  /** The results looked right but are not, or the reads show that the query was not answered. */
  Misled = "misled",
}

/** The sample of the test of the reads per search: the count of reads of its searches. */
export enum ReadsSample {
  /** Searches with 0 reads. */
  None = "0 reads",
  /** Searches with 1 read. */
  One = "1 read",
  /** Searches with 3 or more reads. */
  ThreeOrMore = "3 or more reads",
}

/** Where the test of the reads per search writes its result file. */
export enum ReadsTargetKind {
  /** A new file: the path given, or the default in the results folder. */
  New = "new",
  /** The file of a stopped run, which the run continues. */
  Resume = "resume",
}

/** What the test of the reads per search says about one sample. */
export enum SampleVerdict {
  /** The agreement reaches the bar. */
  Passes = "passes",
  /** The agreement is under the bar. */
  Fails = "fails",
  /** The sample is too small to judge. */
  NoVerdict = "no verdict",
}

/** The value of `--arm` of the benefit test. */
export enum ArmChoice {
  With = "with",
  Without = "without",
  Both = "both",
}

/** The value of `--group` of the benefit test. */
export enum GroupChoice {
  Held = "held",
  Gap = "gap",
  Stale = "stale",
  All = "all",
}

/** The value of `--kind` of the benefit test. */
export enum KindChoice {
  Question = "question",
  Task = "task",
  All = "all",
}

/** The steps of a deploy, in the order they run. */
export enum DeployStep {
  /** Reads the action of the task when it exists, to skip the create when it is already current. */
  ReadTask = "read-task",
  /** Creates the task, or re-creates it with `/f`, before anything is stopped or installed (it can be refused). */
  CreateTask = "create-task",
  /**
   * Ends the scheduled task when it exists, then stops the process tree that listens on port 7777 (the launcher is
   * detached from the task, so ending the task does not stop the service); the install replaces files it holds open.
   */
  StopService = "stop-service",
  /** Packs the checkout; the `prepack` script builds `dist/` here, so nothing builds twice. */
  Pack = "pack",
  Install = "install",
  /** Writes the deployment folder and the launchers. */
  PrepareFolder = "prepare-folder",
  /** Starts the task and waits for the service to accept connections. */
  RunTask = "run-task",
}

/** The version bumps that `npm version` takes. */
export enum ReleaseKind {
  Patch = "patch",
  Minor = "minor",
  Major = "major",
}

/** The kinds of problem the check reports. */
export enum ProblemKind {
  /** No doc holds a requirement row: the folders are empty or the wrong ones were read. */
  NoRequirements = "no-requirements",
  /** A doc has requirement rows and `__tests__/requirements/<feature>.test.ts` does not exist. */
  MissingTestFile = "missing-test-file",
  /** A test file has no doc with the same feature name. */
  MissingDoc = "missing-doc",
  /** A requirement has no test with its name. */
  MissingTest = "missing-test",
  /** A test has no requirement with its name. */
  MissingRequirement = "missing-requirement",
  /** A requirement name appears twice in one doc. */
  DuplicateRequirement = "duplicate-requirement",
  /** A test name appears twice in one test file. */
  DuplicateTest = "duplicate-test",
  /** A Proof cell starts with "To do" and the test file has no `it.todo` or `test.todo` with the name. */
  MissingTodo = "missing-todo",
  /** A Proof cell does not start with "To do" and the test file has no real `it` or `test` with the name. */
  UnexpectedTodo = "unexpected-todo",
  /** An "Eval:" cell names none of the known evals. */
  UnknownEval = "unknown-eval",
  /** An "Eval:" cell names an eval whose file does not exist. */
  MissingEval = "missing-eval",
}

/** Where the line parser is in the markdown. */
export enum TableState {
  /** Outside a table. */
  Outside = "outside",
  /** A requirement header matched and the separator line is next. */
  Header = "header",
  /** In the rows of a requirement table. */
  Rows = "rows",
  /** In a table that is not a requirement table. */
  Other = "other",
}

/** The kinds of problem that `npm run check:standard` reports. */
export enum StandardProblemKind {
  /** A file carries an absolute path of a local machine (a user home folder). */
  LocalPath = "local-path",
  /** A to-do marker has no issue reference (`#N`) on its line. */
  TodoWithoutIssue = "todo-without-issue",
  /** An eval file starts a server from `dist/`. */
  EvalSpawnsDist = "eval-spawns-dist",
  /** README or `.env.example` names an npm script that `package.json` does not have. */
  MissingNpmScript = "missing-npm-script",
  /** README or `.env.example` names an environment variable that no source file mentions. */
  MissingEnvVar = "missing-env-var",
  /** README or `.env.example` names a repo path that does not exist. */
  MissingPath = "missing-path",
  /** A `…md#anchor` link points to a file that is not in the repo. */
  MissingDocFile = "missing-doc-file",
  /** A `…md#anchor` link points to an anchor that no heading of the file gives. */
  MissingAnchor = "missing-anchor",
  /** A script name of `package.json` is outside the naming rule (docs/code-standard.md, section 6). */
  BadNpmScriptName = "bad-npm-script-name",
}

/** The groups of the npm scripts that are not daily or operation commands: a name is `<group>:<name>`. */
export const NPM_SCRIPT_GROUPS: readonly string[] = ["test", "check", "eval", "console", "demo", "export"];

/** The npm scripts that have no group: the daily and operation commands. */
export const NPM_UNGROUPED_SCRIPTS: readonly string[] = [
  "prepack",
  "build",
  "test",
  "typecheck",
  "lint",
  "format",
  "check",
  "ship",
  "deploy",
  "demo",
  "ingest",
  "clean-temp",
];

/** The two paths of the bulk test (technical/updates.md, "High volume mode"). */
export enum BulkPath {
  /** The requests one at a time, as the worker runs them under the threshold. */
  Sequential = "sequential",
  /** The requests as batches of the high volume mode. */
  Batch = "batch",
}

/** Why a bulk test run ended before both paths finished. */
export enum BulkStop {
  /** The model answered with a rate limit; the run keeps its rows and does not wait. */
  RateLimit = "rate limit",
}

/** The architectures that the result files of #60 name; the reader keeps them to read those files, and no run writes one. */
export enum BulkArch {
  /** B: groups first. Code groups the requests, the groups run side by side and each group runs 1 request at a time. */
  Groups = "groups",
  /** A: the batch path with the 3 fixes of the conflicts inside a batch. */
  BatchFixed = "batch-fixed",
  /** C: the groups of B, with 1 model call that judges the claims of a group. */
  GroupJudge = "group-judge",
}

/** The kinds of queued submission in the data of the bulk test wiki (`fakes/bulk-submissions.ts`). */
export enum SubmissionKind {
  /** A true claim that the seed wiki does not hold. */
  New = "new",
  /** A claim that a seed fact already holds, in other words. */
  Duplicate = "duplicate",
  /** A true claim that replaces the value of a seed fact that is out of date, with a justification that shows it. */
  Correction = "correction",
  /** A false claim whose justification is a weak observation (an older draft), against a seed fact with a strong one. */
  Contradicted = "contradicted",
  /** Two or more claims in one submission. */
  Compound = "compound",
  /** A claim whose justification is a belief or an inference, with no observation. */
  Unsupported = "unsupported",
  /** A false claim against a seed fact whose justification is hearsay: a report that step 1 lets through, and Q4 weighs against the seed fact. */
  Hearsay = "hearsay",
  /** One of 2 or 3 submissions on the same new subject, so that the reconciliation of a batch has work. */
  SameSubject = "sameSubject",
}

/** The kind of the justification of a submission of the bulk test wiki: step 1 judges it before the claim. */
export enum JustificationKind {
  /** The submitter read, counted or ran something: the claim has a source. */
  Observation = "observation",
  /** The submitter was told: no observation. */
  Hearsay = "hearsay",
  /** The submitter holds the claim true without a check: no observation. */
  Belief = "belief",
  /** The submitter reasons to the claim from other things: no observation. */
  Inference = "inference",
}

/**
 * One acceptable end of a submission of the bulk test wiki, on a path that judges it right (`fakes/bulk-submissions.ts`).
 * A submission carries a non-empty set of them: it is judged right when it ends as any member.
 */
export enum ExpectedOutcome {
  /** The claim is written as a new fact. */
  AcceptedNew = "accepted as new",
  /** The claim restates a seed fact: the outcome is duplicate, with the seed fact as the duplicate of. */
  DuplicateOfSeed = "duplicate of a seed fact",
  /** The claim restates an earlier submission of the queue: the outcome is duplicate of the fact that submission wrote. */
  DuplicateOfEarlier = "duplicate of an earlier submission",
  /** The claim is written as a new version of the out-of-date seed fact. */
  CorrectionAccepted = "correction accepted",
  /** The claim is rejected with the reason unsupported (step 1: a justification with no observation, whatever the claim). */
  RejectedUnsupported = "rejected unsupported",
  /** The claim is rejected with the reason contradicted. */
  RejectedContradicted = "rejected contradicted",
  /** The claim is rejected with the reason compound. */
  RejectedCompound = "rejected compound",
  /** The claim says what an earlier submission says and the reconciliation merges them: the wiki holds 1 fact for both. */
  MergedWith = "merged with another submission",
  /** The pipeline splits the compound submission at step 1 into single-claim requests, which end by their own claims. */
  Split = "split into single claims",
  /** The claim conflicts with an earlier submission whose observation is stronger: the reconciliation keeps the earlier value. */
  LosesInReconciliation = "loses in the reconciliation",
}

/** The installed browsers Playwright can drive, in the order the test tries them. */
export enum BrowserChannel {
  Edge = "msedge",
  Chrome = "chrome",
}

/** What git says happened to a file in the change that `npm run check` covers. */
export enum ChangeKind {
  /** Added, copied, modified or untracked: the file exists. */
  Present = "present",
  /** Deleted or renamed away: the file is gone, and the tests that imported it cannot be found from it. */
  Gone = "gone",
}

/** The groups of a cleanup of the Temp folder (`scripts/clean-temp.ts`); the value is the name in the log line. */
export enum LeftoverGroup {
  /** Each folder that starts with `wikifact-`, and the folders with a prefix of `TEMP_PREFIXES`. */
  Prefixes = "prefixes",
  /** The browser profiles of playwright. */
  PlaywrightProfiles = "playwright profiles",
  /** The Vitest folders: 21-character name, only `client` and `ssr` inside. */
  VitestFolders = "vitest folders",
  /** The folders of Claude Code in `<temp>/claude` for the working folders `wikifact-*`. */
  ClaudeFolders = "claude folders",
  /** The run folders of stopped test runs in `.cache/test-runs/`; only `npm run clean-temp` counts them. */
  TestRunFolders = "test run folders",
}
