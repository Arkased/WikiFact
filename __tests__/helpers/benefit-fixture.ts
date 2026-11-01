// A small git repo, a cases file with a task, and a stub wiki, for the tests of the benefit test. No model call.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";
import { StubQuestions } from "../../fakes/stub-questions.js";
import { makeStubWiki, stubAgent, stubChecker, stubJudge, type StubKnowledge } from "../../fakes/stub-benefit.js";
import { BenefitGroup, BenefitKind, Complexity, QuestionType, TaskType } from "../../eval/lib/enums.js";
import type { BenefitCase, QuestionCase, TaskCase } from "../../eval/benefit/cases.js";
import type { BenefitDeps } from "../../eval/benefit/run.js";
import { GitRepo } from "../../eval/benefit/worktree.js";

async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await execa("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd });
  return r.stdout;
}

/**
 * A repo that makes plain folders instead of git worktrees, for the tests that prove the run of the benefit test and
 * not git: it keeps the list of the folders it made and never starts a process. A task run needs a real worktree
 * (`git apply`, a baseline commit); use it for question cases only.
 */
export class FakeGitRepo extends GitRepo {
  /** The folders that were added and not yet removed. */
  readonly live = new Set<string>();

  /**
   * Opens the fake repo.
   *
   * @sideEffects none
   */
  constructor() {
    super("fake-repo");
  }

  /** The number of calls of `pruneWorktrees`. */
  pruned = 0;

  /**
   * Counts the call.
   *
   * @returns once counted
   * @sideEffects none
   */
  override pruneWorktrees(): Promise<void> {
    this.pruned++;
    return Promise.resolve();
  }

  /**
   * Makes the folder of a worktree.
   *
   * @param _commit - ignored
   * @param dir - the folder to make
   * @returns once the folder exists
   * @sideEffects makes the folder
   */
  override addWorktree(_commit: string, dir: string): Promise<void> {
    mkdirSync(dir, { recursive: true });
    this.live.add(dir);
    return Promise.resolve();
  }

  /**
   * Deletes the folder of a worktree.
   *
   * @param dir - the folder
   * @returns once the folder is gone
   * @sideEffects deletes the folder
   */
  override removeWorktree(dir: string): Promise<void> {
    rmSync(dir, { recursive: true, force: true });
    this.live.delete(dir);
    return Promise.resolve();
  }
}

/** The repo, the full sha of its only commit and the file that the tasks change. */
export interface FixtureRepo {
  repo: GitRepo;
  commit: string;
  dir: string;
}

/** The file of the fixture repo that the task changes: its first line is the "bug". */
export const BUG_FILE = "src/value.txt";
/** The content of `BUG_FILE` with the bug. */
export const BUGGY = "buggy\n";
/** The content of `BUG_FILE` once fixed. */
export const FIXED = "fixed\n";

/**
 * Makes a git repo with one commit: a source file and a `.gitignore`.
 *
 * @param dir - the folder to make it in; created
 * @returns the repo and its commit
 * @sideEffects runs git; writes the folder
 */
export async function makeRepo(dir: string): Promise<FixtureRepo> {
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, BUG_FILE), FIXED);
  writeFileSync(join(dir, ".gitignore"), "node_modules\n");
  await git(dir, "init", "-q");
  // No line-end conversion: the patches of the fixture are written with LF.
  await git(dir, "config", "core.autocrlf", "false");
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "-m", "fill");
  const commit = (await git(dir, "rev-parse", "HEAD")).trim();
  return { repo: new GitRepo(dir), commit, dir };
}

/** The ids of the fixture cases. */
export const IDS = { held: "q-held", gap: "q-gap", stale: "q-stale", task: "t-bug" };

const question = (id: string, group: BenefitGroup, extra: Partial<QuestionCase> = {}): QuestionCase => ({
  id,
  kind: BenefitKind.Question,
  group,
  type: QuestionType.Locate,
  complexity: Complexity.Simple,
  question: `Question of ${id}?`,
  answer: `The answer of ${id}.`,
  answerContains: [`answer of ${id}`],
  proof: [{ file: BUG_FILE, line: 1 }],
  ...extra,
});

/**
 * Makes the cases and the files of the task. The task plants a bug with a setup patch and has a reference patch that fixes it.
 *
 * @param dir - the folder of the cases file; the task files go under `<dir>/cases/tasks/<id>/`
 * @param repoDir - the fixture repo: its file is changed for a moment to make the patches
 * @returns the path of the cases file and the cases
 * @sideEffects writes the cases file, 2 patches and 1 hidden test file
 */
export async function makeCases(dir: string, repoDir: string): Promise<{ casesPath: string; cases: BenefitCase[] }> {
  const folder = join(dir, "cases", "tasks", IDS.task);
  mkdirSync(join(folder, "hidden", "src"), { recursive: true });
  // The patches come from git itself, so that they apply to the fixture repo.
  writeFileSync(join(repoDir, BUG_FILE), BUGGY);
  const setup = await git(repoDir, "diff", "--no-color");
  const reference = await git(repoDir, "diff", "--no-color", "-R");
  await git(repoDir, "checkout", "-q", "--", BUG_FILE);
  writeFileSync(join(folder, "setup.patch"), `${setup}\n`);
  writeFileSync(join(folder, "reference.patch"), `${reference}\n`);
  writeFileSync(join(folder, "hidden", "src", "value.test.ts.hidden"), "// hidden test\n");
  const task: TaskCase = {
    id: IDS.task,
    kind: BenefitKind.Task,
    taskType: TaskType.Bugfix,
    group: BenefitGroup.Held,
    issue: "The value is buggy. Make it fixed.",
    setupPatch: "setup.patch",
    hiddenTests: ["src/value.test.ts"],
    referencePatch: "reference.patch",
  };
  const cases: BenefitCase[] = [
    question(IDS.held, BenefitGroup.Held),
    question(IDS.gap, BenefitGroup.Gap),
    question(IDS.stale, BenefitGroup.Stale, {
      staleFact: { header: "Wrong stub fact", content: "The stub wiki claims a wrong thing." },
    }),
    task,
  ];
  const casesPath = join(dir, "cases.json");
  writeFileSync(casesPath, JSON.stringify(cases, null, 2));
  return { casesPath, cases };
}

/**
 * The deps of a test run: the stubs, with the log kept.
 *
 * @param known - the cases and the cases file, which the stub agent needs
 * @param over - the parts to replace
 * @returns the deps and the lines they logged
 * @sideEffects none
 */
export function stubDeps(known: StubKnowledge, over: Partial<BenefitDeps> = {}): BenefitDeps & { lines: string[] } {
  const lines: string[] = [];
  return {
    agent: stubAgent(known),
    judge: stubJudge(),
    checker: stubChecker(),
    makeQuestions: () => new StubQuestions(),
    install: () => Promise.resolve(),
    log: (l) => lines.push(l),
    ...over,
    lines,
  };
}

/**
 * Makes the stub wiki database.
 *
 * @param dir - the folder
 * @returns the path of the database
 * @sideEffects writes the database
 */
export const makeWiki = (dir: string): Promise<string> => makeStubWiki(dir);
