import { pathToFileURL } from "node:url";

/**
 * Tells whether a module is the entry point of the process, so that it runs its main code only when started directly.
 *
 * @param importMetaUrl - the `import.meta.url` of the calling module
 * @returns true when `process.argv[1]` is that module's file
 * @sideEffects reads `process.argv`
 */
export function isMain(importMetaUrl: string): boolean {
  const entry = process.argv[1];
  return entry !== undefined && importMetaUrl === pathToFileURL(entry).href;
}
