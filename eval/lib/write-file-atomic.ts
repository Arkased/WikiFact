import { renameSync, writeFileSync } from "node:fs";

/**
 * Writes a file through a temp file in the same folder and a rename, so a stop in the middle never leaves a cut-off file.
 *
 * @param path - the file
 * @param content - the text of the file
 * @sideEffects writes `<path>.tmp` and renames it over the file
 */
export function writeFileAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}
