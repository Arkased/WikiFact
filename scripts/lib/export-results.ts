// technical/publication.md, "Eval result files": each result folder keeps its newest stamped file, its newest summary file and each file that an exported text names.
import { posix } from "node:path";
import { unstamp } from "../../src/time.js";

/** The extension of a result file. */
const RESULT_EXTENSION = ".json";
/** The start of the name of a summary file: `summary-<stamp>.json`. */
const SUMMARY_PREFIX = "summary-";

/**
 * Tells whether a text names a file by its file name. A name inside a longer name does not count: `summary-X.json`
 * does not name `X.json`.
 *
 * @param text - the text to search
 * @param name - the file name
 * @returns true when the name occurs and the character before it is not part of a file name
 * @sideEffects none
 */
function names(text: string, name: string): boolean {
  for (let at = text.indexOf(name); at >= 0; at = text.indexOf(name, at + 1)) {
    if (at === 0 || !/[\w.-]/.test(text[at - 1] ?? "")) return true;
  }
  return false;
}

// The newest of the files whose name is `<prefix><stamp>.json`, in the order of the names.
function newestStamped(folder: string, files: string[], prefix: string): string | undefined {
  return files
    .filter((p) => {
      const name = posix.basename(p, RESULT_EXTENSION);
      return posix.dirname(p) === folder && name.startsWith(prefix) && unstamp(name.slice(prefix.length)) !== undefined;
    })
    .sort()
    .at(-1);
}

/**
 * Chooses the result files that the export leaves out. A result file is a `.json` file under a result folder. The
 * folder keeps the newest file whose name is a stamp (`<ISO stamp>.json`, in the order of the names), the newest
 * `summary-<stamp>.json`, and each file whose file name occurs in one of the texts.
 *
 * @param paths - the paths that the export would copy, relative to the root, with forward slashes
 * @param folders - the result folders, relative to the root, without a trailing `/`
 * @param texts - the exported text files that name result files: every text except the result files themselves
 * @returns the paths to leave out, in the order of `paths`
 * @sideEffects none
 */
export function resultFilesToDrop(paths: string[], folders: string[], texts: string[]): string[] {
  const all = texts.join("\n");
  const drop = new Set<string>();
  for (const folder of folders) {
    const files = paths.filter((p) => p.startsWith(`${folder}/`) && p.endsWith(RESULT_EXTENSION));
    const keep = [newestStamped(folder, files, ""), newestStamped(folder, files, SUMMARY_PREFIX)];
    for (const p of files) if (!keep.includes(p) && !names(all, posix.basename(p))) drop.add(p);
  }
  return paths.filter((p) => drop.has(p));
}
