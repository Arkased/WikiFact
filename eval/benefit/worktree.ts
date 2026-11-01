// The checkouts of the benefit test: one `git worktree` of the fill commit for each run that needs files
// (technical/evaluation.md, "The benefit test", Inputs and "One task run").
import { rmSync } from "node:fs";
import { execa } from "execa";
import PQueue from "p-queue";
import { RM_RETRIES, RM_RETRY_DELAY_MS } from "../../src/constants.js";

/** The time `npm ci` may take in a task worktree, in ms (10 minutes). */
const NPM_CI_TIMEOUT_MS = 10 * 60 * 1000;
/** The most characters of a failed command's output kept in an error. */
const ERROR_TEXT_CHARS = 600;
/** The identity of the commit that holds the setup of a task, so that the diff of the agent starts from it. */
const COMMIT_IDENTITY = ["-c", "user.name=benefit", "-c", "user.email=benefit@localhost"];
/** The pathspecs of the diff of an agent: everything but the settings file that the test writes. */
const DIFF_PATHSPEC = ["--", ".", ":(exclude).claude"];

/** One command that failed; the message carries the command and the start of its output. */
class CommandError extends Error {}

async function run(cwd: string, file: string, args: string[], timeout?: number): Promise<string> {
  const r = await execa(file, args, { cwd, reject: false, windowsHide: true, ...(timeout ? { timeout } : {}) });
  if (r.exitCode !== 0) {
    const output = r.stderr !== "" ? r.stderr : r.stdout !== "" ? r.stdout : (r.shortMessage ?? "");
    throw new CommandError(
      `${file} ${args.join(" ")} failed (exit ${r.exitCode ?? "none"}): ${output.slice(0, ERROR_TEXT_CHARS)}`,
    );
  }
  return r.stdout;
}

/**
 * A git repo that the test makes worktrees of. The commands that change the worktree list of the repo run one at a
 * time, because git locks its own files and 2 of them at once can fail.
 */
export class GitRepo {
  private readonly lock = new PQueue({ concurrency: 1 });

  /**
   * Opens a repo.
   *
   * @param path - the working directory of the repo, or of any of its worktrees
   * @sideEffects none
   */
  constructor(readonly path: string) {}

  /**
   * Resolves a commit name to its full id.
   *
   * @param commit - a sha, a branch or `HEAD`
   * @returns the 40-character sha
   * @throws {CommandError} when the repo has no such commit
   * @sideEffects runs `git rev-parse`
   */
  async resolve(commit: string): Promise<string> {
    return (await run(this.path, "git", ["rev-parse", "--verify", `${commit}^{commit}`])).trim();
  }

  /**
   * Counts the lines of a file at a commit.
   *
   * @param commit - the commit
   * @param path - the file, relative to the root of the repo
   * @returns the number of lines; undefined when the commit has no such file
   * @sideEffects runs `git show`
   */
  async lineCount(commit: string, path: string): Promise<number | undefined> {
    try {
      const text = await run(this.path, "git", ["show", `${commit}:${path}`]);
      return text.split("\n").length;
    } catch {
      return undefined;
    }
  }

  /**
   * Checks out a commit into a new detached worktree.
   *
   * @param commit - the commit to check out
   * @param dir - the folder of the worktree; it must not exist
   * @returns once the worktree exists
   * @throws {CommandError} when git refuses
   * @sideEffects `git worktree add --detach`: writes the folder and the worktree entry in the repo
   */
  async addWorktree(commit: string, dir: string): Promise<void> {
    await this.lock.add(() => run(this.path, "git", ["worktree", "add", "--detach", dir, commit]));
  }

  /**
   * Removes a worktree and its folder, whatever state it is in. It never throws: a folder that cannot be removed is
   * left for the cleanup of the run folder.
   *
   * @param dir - the folder of the worktree
   * @returns once the worktree entry and the folder are gone, or the removal failed
   * @sideEffects `git worktree remove --force`, `git worktree prune`, and a recursive delete of the folder
   */
  async removeWorktree(dir: string): Promise<void> {
    await this.lock.add(async () => {
      try {
        await run(this.path, "git", ["worktree", "remove", "--force", dir]);
      } catch {
        // The entry may be missing or the folder locked; the delete and the prune below finish the job.
      }
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: RM_RETRIES, retryDelay: RM_RETRY_DELAY_MS });
      } catch {
        // left for the cleanup of the run folder
      }
      try {
        await run(this.path, "git", ["worktree", "prune"]);
      } catch {
        // nothing to prune
      }
    });
  }

  /**
   * Drops the worktree entries whose folder is gone.
   *
   * @returns once git has pruned the entries
   * @throws {CommandError} when git refuses
   * @sideEffects `git worktree prune`: writes the worktree list of the repo
   */
  async pruneWorktrees(): Promise<void> {
    await this.lock.add(() => run(this.path, "git", ["worktree", "prune"]));
  }

  /**
   * Lists the folders of the worktrees of the repo.
   *
   * @returns the paths, with forward slashes, as git prints them
   * @sideEffects runs `git worktree list --porcelain`
   */
  async listWorktrees(): Promise<string[]> {
    const out = await run(this.path, "git", ["worktree", "list", "--porcelain"]);
    return out
      .split("\n")
      .filter((l) => l.startsWith("worktree "))
      .map((l) => l.slice("worktree ".length).trim());
  }
}

/**
 * Applies a patch file to a worktree.
 *
 * @param dir - the worktree
 * @param patchPath - the patch file
 * @returns once the patch is applied
 * @throws {CommandError} when the patch does not apply
 * @sideEffects `git apply`: changes the files of the worktree
 */
export async function applyPatch(dir: string, patchPath: string): Promise<void> {
  await run(dir, "git", ["apply", "--whitespace=nowarn", patchPath]);
}

/**
 * Commits everything in the worktree as its baseline, so that the diff of the agent starts from this state.
 *
 * @param dir - the worktree
 * @returns once the commit exists
 * @sideEffects `git add -A` and `git commit` on the detached head of the worktree
 */
export async function commitBaseline(dir: string): Promise<void> {
  await run(dir, "git", ["add", "-A"]);
  await run(dir, "git", [...COMMIT_IDENTITY, "commit", "-q", "--allow-empty", "--no-verify", "-m", "baseline"]);
}

/** The change an agent made in its worktree. */
export interface WorktreeDiff {
  /** The unified diff against the baseline, without the settings file. */
  diff: string;
  /** The files that changed, with forward slashes. */
  files: string[];
}

/**
 * Reads what changed in the worktree since its baseline.
 *
 * @param dir - the worktree
 * @returns the diff and the changed files; both empty when nothing changed
 * @sideEffects `git add -A` (stages the changes of the worktree)
 */
export async function diffOf(dir: string): Promise<WorktreeDiff> {
  await run(dir, "git", ["add", "-A", ...DIFF_PATHSPEC]);
  const diff = await run(dir, "git", ["diff", "--cached", "--no-color", "HEAD", ...DIFF_PATHSPEC]);
  const names = await run(dir, "git", ["diff", "--cached", "--name-only", "HEAD", ...DIFF_PATHSPEC]);
  return { diff, files: names.split("\n").filter(Boolean) };
}

/**
 * Puts a worktree back to its checked-out commit and removes the files that are not tracked, but keeps `node_modules`.
 *
 * @param dir - the worktree
 * @returns once the worktree is clean
 * @sideEffects `git reset --hard` and `git clean`: discards every change in the worktree
 */
export async function resetWorktree(dir: string): Promise<void> {
  await run(dir, "git", ["reset", "--hard", "-q"]);
  await run(dir, "git", ["clean", "-fdq", "-e", "node_modules"]);
}

/**
 * Installs the dependencies of the worktree without running install scripts.
 *
 * @param dir - the worktree
 * @returns once `npm ci --ignore-scripts` ended
 * @throws {CommandError} when it fails or takes over 10 minutes
 * @sideEffects `npm ci --ignore-scripts`: writes `node_modules` in the worktree and reads the npm cache and registry
 */
export async function npmCi(dir: string): Promise<void> {
  await run(dir, "npm", ["ci", "--ignore-scripts"], NPM_CI_TIMEOUT_MS);
}

/**
 * Runs a command in a worktree and reports its exit code, never throwing for a failed command.
 *
 * @param dir - the working directory
 * @param file - the program
 * @param args - its arguments
 * @param timeoutMs - the time limit in ms
 * @returns the exit code (null when the process did not start or timed out) and the tail of the output
 * @sideEffects runs the command
 */
export async function exitCodeOf(
  dir: string,
  file: string,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number | null; output: string }> {
  const r = await execa(file, args, { cwd: dir, reject: false, windowsHide: true, timeout: timeoutMs, all: true });
  const output = (r.all ?? "").toString();
  return { code: r.exitCode ?? null, output: output.slice(-ERROR_TEXT_CHARS) };
}
