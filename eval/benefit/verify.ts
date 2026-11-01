// The proof of the cases (`npm run eval:benefit -- --verify-cases`): each proof line exists at the commit, and each hidden test
// fails on the setup of its task and passes with the reference patch, with the type check.
import { join } from "node:path";
import { BenefitKind } from "../lib/enums.js";
import { taskFolder, type BenefitCase, type TaskCase } from "./cases.js";
import { copyHiddenTests, type CheckResult, type TaskChecker } from "./task-check.js";
import { applyPatch, resetWorktree, type GitRepo } from "./worktree.js";

/** The proof of one question: each proof line exists at the commit. */
interface QuestionProof {
  id: string;
  /** The proof entries whose file is missing at the commit, or whose line is past the end of the file. */
  missing: string[];
}

/** What the checker found in one step of the proof. */
interface StepProof {
  testsPass: boolean;
  typecheckPass: boolean;
  /** The exit code of `npx vitest run <hidden tests>`. */
  testsExit?: number | null;
  /** The exit code of `npm run typecheck`. */
  typecheckExit?: number | null;
}

const stepOf = (c: CheckResult): StepProof => ({
  testsPass: c.testsPass,
  typecheckPass: c.typecheckPass,
  ...(c.testsExit !== undefined ? { testsExit: c.testsExit } : {}),
  ...(c.typecheckExit !== undefined ? { typecheckExit: c.typecheckExit } : {}),
});

/** The proof of one task. */
interface TaskProof {
  id: string;
  /** The hidden tests and the type check on the setup of the task (or on the commit, for a feature), with the exit codes when the checker gives them. */
  before: StepProof;
  /** The same with the reference patch applied. */
  after: StepProof;
  /** True when the tests fail before and pass after, and the type check passes after. */
  ok: boolean;
  /** The message of the error that stopped the proof of this task (a patch that does not apply); absent when the patches applied. */
  error?: string;
}

/** The result of the proof. */
export interface VerifyReport {
  questions: QuestionProof[];
  tasks: TaskProof[];
  ok: boolean;
}

/** The parts of the proof that a test replaces. */
export interface VerifyOptions {
  cases: BenefitCase[];
  casesPath: string;
  repo: GitRepo;
  commit: string;
  /** A worktree of the commit with its dependencies installed; the proof resets it between the steps. */
  worktree: string;
  checker: TaskChecker;
  log: (line: string) => void;
}

/** A patch of a task that `git apply` refused: the one error that the proof records as a failed task. */
class PatchError extends Error {}

/**
 * Applies a patch of a task.
 *
 * @param worktree - the worktree
 * @param patchPath - the patch file
 * @returns once the patch is applied
 * @throws {PatchError} when `git apply` refuses the patch
 * @sideEffects as `applyPatch`
 */
async function applyTaskPatch(worktree: string, patchPath: string): Promise<void> {
  try {
    await applyPatch(worktree, patchPath);
  } catch (e) {
    throw new PatchError(e instanceof Error ? e.message : String(e), { cause: e });
  }
}

async function proveTask(o: VerifyOptions, c: TaskCase): Promise<TaskProof> {
  const folder = taskFolder(o.casesPath, c.id);
  await resetWorktree(o.worktree);
  if (c.setupPatch !== undefined) await applyTaskPatch(o.worktree, join(folder, c.setupPatch));
  copyHiddenTests(folder, o.worktree, c.hiddenTests);
  const before = await o.checker(o.worktree, c.hiddenTests);
  await resetWorktree(o.worktree);
  if (c.setupPatch !== undefined) await applyTaskPatch(o.worktree, join(folder, c.setupPatch));
  await applyTaskPatch(o.worktree, join(folder, c.referencePatch));
  copyHiddenTests(folder, o.worktree, c.hiddenTests);
  const after = await o.checker(o.worktree, c.hiddenTests);
  const proof: TaskProof = {
    id: c.id,
    before: stepOf(before),
    after: stepOf(after),
    ok: !before.testsPass && after.testsPass && after.typecheckPass,
  };
  o.log(
    `${c.id}: before: vitest exit ${before.testsExit ?? "?"}, typecheck exit ${before.typecheckExit ?? "?"}; after the reference patch: vitest exit ${after.testsExit ?? "?"}, typecheck exit ${after.typecheckExit ?? "?"}; ${proof.ok ? "ok" : "NOT OK"}`,
  );
  return proof;
}

/**
 * Proves one task; the error of `git apply` (the setup or the reference patch) is recorded as a failed task, not thrown.
 *
 * @param o - the proof options
 * @param c - the task
 * @returns the proof of the task; `ok` false with `error` set when a patch did not apply
 * @throws {Error} the error of any other step (the reset of the worktree, the copy of the hidden tests, the checker): a fault of the machine stops the proof
 * @sideEffects as `proveTask`; logs one line for a task whose patch did not apply
 */
async function proveTaskSafely(o: VerifyOptions, c: TaskCase): Promise<TaskProof> {
  try {
    return await proveTask(o, c);
  } catch (e) {
    if (!(e instanceof PatchError)) throw e;
    const error = e.message;
    const failed: StepProof = { testsPass: false, typecheckPass: false };
    o.log(`${c.id}: NOT OK: ${error}`);
    return { id: c.id, before: failed, after: failed, ok: false, error };
  }
}

/**
 * Proves the cases at the commit: every proof file and line of a question exists, and every task fails its hidden tests
 * before the reference patch and passes them, and the type check, after it.
 *
 * @param o - the cases, the repo, the commit, an installed worktree and the checker
 * @returns the proof of each question and task, and whether all hold
 * @sideEffects resets and changes the files of `o.worktree`; runs the checker (child processes)
 */
export async function verifyCases(o: VerifyOptions): Promise<VerifyReport> {
  const questions: QuestionProof[] = [];
  const tasks: TaskProof[] = [];
  for (const c of o.cases) {
    if (c.kind === BenefitKind.Question) {
      const missing: string[] = [];
      for (const p of c.proof) {
        const lines = await o.repo.lineCount(o.commit, p.file);
        if (lines === undefined || p.line > lines) missing.push(`${p.file}:${p.line}`);
      }
      questions.push({ id: c.id, missing });
      if (missing.length > 0) o.log(`${c.id}: proof not found at the commit: ${missing.join(", ")}`);
    } else tasks.push(await proveTaskSafely(o, c));
  }
  return { questions, tasks, ok: questions.every((q) => q.missing.length === 0) && tasks.every((t) => t.ok) };
}
