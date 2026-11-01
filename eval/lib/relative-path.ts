// A path that an eval writes into a result file is relative to the project root, so that no file holds a local path.
import { relative } from "node:path";
import { projectRoot } from "../../src/paths.js";

/**
 * Turns a path into its form for a result file: relative to the project root, with forward slashes.
 *
 * @param path - an absolute path, or a path relative to the working directory
 * @param root - the project root; default: `projectRoot()`
 * @returns the relative path with forward slashes; the unchanged path with forward slashes when no relative form exists (another drive)
 * @sideEffects reads the file system for the project root when none is given
 */
export function relativeToRoot(path: string, root: string = projectRoot()): string {
  return relative(root, path).replace(/\\/g, "/");
}
