// The release steps of `npm run ship` (technical/release.md, "Ship a release"): the guards, and the version bump with the fast-forward of `main`.
import { ReleaseKind } from "../../eval/lib/enums.js";
import { ScriptError } from "./shell.js";

/** The branch that releases are cut from. */
const BUILD_BRANCH = "build";
/** The branch that a release fast-forwards. */
const MAIN_BRANCH = "main";
/**
 * Reads the bump kind from the command line.
 *
 * @param arg - the first argument of the script
 * @returns the kind
 * @throws {ScriptError} when the argument is missing or not one of the kinds
 * @sideEffects none
 */
export function parseReleaseKind(arg: string | undefined): ReleaseKind {
  const kinds = Object.values(ReleaseKind);
  const kind = kinds.find((k) => k === arg);
  if (kind === undefined) throw new ScriptError(`usage: npm run ship -- ${kinds.join("|")}`);
  return kind;
}

/**
 * Stops unless the checkout is on the `build` branch.
 *
 * @param branch - the current branch name
 * @throws {ScriptError} for any other branch
 * @sideEffects none
 */
export function requireBuildBranch(branch: string): void {
  if (branch !== BUILD_BRANCH) {
    throw new ScriptError(`ship runs on the ${BUILD_BRANCH} branch, not on "${branch}"`);
  }
}

/**
 * Bumps the version, tags it and fast-forwards `main` to `build`, then checks `build` out again.
 *
 * @param kind - the bump
 * @param exec - runs a command for its effect (it may print its output); throws when it fails
 * @param capture - runs a command and returns its stdout; throws when it fails
 * @returns the new tag, such as `v0.1.19`
 * @throws {ScriptError} when `exec` or `capture` throws (a failed command), or when the tag that `git describe --tags
 *   --abbrev=0` returns is not `vX.Y.Z` (an empty capture): this is the one check of the tag, and the callers trust it
 * @sideEffects whatever `exec` does; with the real one: `npm version` edits package.json and package-lock.json,
 *   commits and tags; the checkouts and the merge move `main`; `capture` runs `git describe --tags --abbrev=0`
 */
export function cutRelease(
  kind: ReleaseKind,
  exec: (file: string, args: string[]) => void,
  capture: (file: string, args: string[]) => string,
): string {
  exec("npm", ["version", kind]);
  exec("git", ["checkout", MAIN_BRANCH]);
  exec("git", ["merge", "--ff-only", BUILD_BRANCH]);
  exec("git", ["checkout", BUILD_BRANCH]);
  const tag = capture("git", ["describe", "--tags", "--abbrev=0"]).trim();
  if (!/^v\d+\.\d+\.\d+/.test(tag)) throw new ScriptError(`the new tag could not be read: got "${tag}"`);
  return tag;
}
