// technical/publication.md, "The export command": the git steps on the source repo and on the target clone.
import { realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { execa } from "execa";
import { DEMO_DIR } from "./export-demo.js";
import { ScriptError } from "./shell.js";

/** The branch that the export copies. */
const EXPORT_BRANCH = "build";
/** The identities that a commit takes, as `git var` names them. */
const COMMIT_IDENTITIES = ["GIT_AUTHOR_IDENT", "GIT_COMMITTER_IDENT"];
/** The time stamp that ends the output of `git var GIT_AUTHOR_IDENT`: seconds since the epoch, then the zone. */
const IDENT_STAMP = / \d+ [+-]\d{4}$/;

/**
 * Runs git in a folder.
 *
 * @param cwd - the folder
 * @param args - the git arguments
 * @returns the stdout without the trailing newline
 * @throws {ScriptError} with the stderr of git when it exits with another code than 0
 * @sideEffects runs a git child process
 */
async function git(cwd: string, args: string[]): Promise<string> {
  const r = await execa("git", args, { cwd, reject: false, stdin: "ignore" });
  if (r.exitCode !== 0) throw new ScriptError(`git ${args.join(" ")} failed in ${cwd}: ${r.stderr}`);
  return r.stdout;
}

// The real path of a folder, folded to lower case on Windows and macOS, where 2 spellings of a case can name 1 folder.
function canonical(path: string): string {
  let real: string;
  try {
    real = realpathSync.native(path);
  } catch {
    throw new ScriptError(`the folder ${path} does not exist`);
  }
  return process.platform === "win32" || process.platform === "darwin" ? real.toLowerCase() : real;
}

// True when `inner` is `outer` or lies under it; both are canonical. A folder named `..x` lies under; a path on
// another drive has an absolute relative path and lies outside.
function isUnder(outer: string, inner: string): boolean {
  const rel = relative(outer, inner);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Stops unless the source repo is clean and on the export branch.
 *
 * @param root - the source repo
 * @throws {ScriptError} when the tree has changes or the branch is another one
 * @sideEffects runs git
 */
export async function requireSource(root: string): Promise<void> {
  const branch = await git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch !== EXPORT_BRANCH) throw new ScriptError(`the export runs on the branch ${EXPORT_BRANCH}, not ${branch}`);
  if ((await git(root, ["status", "--porcelain"])) !== "") {
    throw new ScriptError("the working tree is not clean: commit your changes first");
  }
}

/**
 * Stops unless the target is the top folder of a git repo with no uncommitted change, and a repo other than the
 * source: not the source folder in another spelling, not a folder inside the source or holding it, and not a worktree
 * of the source (the same git common folder).
 *
 * @param target - the local clone of the public repo
 * @param root - the source repo
 * @throws {ScriptError} when the target is not such a repo, is dirty, or is the source
 * @sideEffects runs git; resolves the paths on disk
 */
export async function requireTarget(target: string, root: string): Promise<void> {
  const [from, to] = [canonical(root), canonical(target)];
  if (from === to) throw new ScriptError("the target is the source repo");
  if (isUnder(from, to) || isUnder(to, from)) {
    throw new ScriptError("the target and the source repo lie one inside the other");
  }
  if ((await git(target, ["rev-parse", "--is-inside-work-tree"])) !== "true") {
    throw new ScriptError(`${target} is not a git working tree`);
  }
  if ((await git(target, ["rev-parse", "--show-prefix"])) !== "") {
    throw new ScriptError(`${target} is a folder inside a repo, not its top folder`);
  }
  const common = ["rev-parse", "--path-format=absolute", "--git-common-dir"];
  if (canonical(await git(target, common)) === canonical(await git(root, common))) {
    throw new ScriptError("the target shares its git folder with the source repo: it is a worktree or the same repo");
  }
  if ((await git(target, ["status", "--porcelain"])) !== "") {
    throw new ScriptError(`the target ${target} has uncommitted changes`);
  }
}

/**
 * Lists the files that git tracks.
 *
 * @param root - the source repo
 * @returns the paths relative to the root, with forward slashes
 * @throws {ScriptError} when git fails
 * @sideEffects runs git
 */
export async function trackedFiles(root: string): Promise<string[]> {
  const out = await git(root, ["ls-files", "-z"]);
  return out.split("\0").filter((p) => p !== "");
}

/**
 * Reads the author and the committer that a commit in the target would get. It runs `git var` with the environment of
 * this process, which the commit inherits, so `GIT_AUTHOR_NAME`, `GIT_COMMITTER_EMAIL` and the like count.
 *
 * @param target - the local clone
 * @returns for the author, then the committer: the `git var` name and the value `Name <email>`, without the time stamp
 * @throws {ScriptError} when git cannot tell an identity, which would also stop the commit
 * @sideEffects runs git
 */
export async function commitIdentities(target: string): Promise<{ name: string; value: string }[]> {
  const out: { name: string; value: string }[] = [];
  for (const name of COMMIT_IDENTITIES) {
    out.push({ name, value: (await git(target, ["var", name])).replace(IDENT_STAMP, "") });
  }
  return out;
}

/**
 * Stages the whole target and commits it.
 *
 * @param target - the local clone
 * @param message - the commit message
 * @returns true when a commit was made, false when the tree equals the last commit
 * @throws {ScriptError} when git fails, for example when the author is not set
 * @sideEffects runs git; adds a commit to the target; never pushes
 */
export async function commitAll(target: string, message: string): Promise<boolean> {
  await git(target, ["add", "-A"]);
  // The public .gitignore holds *.sqlite; the demo store is tracked by force, so the file needs no exception line.
  await git(target, ["add", "-f", "--", DEMO_DIR]);
  if ((await git(target, ["status", "--porcelain"])) === "") return false;
  await git(target, ["commit", "-m", message]);
  return true;
}
