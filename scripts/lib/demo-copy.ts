// technical/publication.md#the-demo-copy, step 6: the served copy of the tracked demo store.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { WIKI_CONFIG_FILE, WIKI_DB_FILE } from "../../src/paths.js";

/** The tracked demo wiki, relative to the project root. */
const DEMO_SOURCE = join("demo", "wikifact");
/** The wiki that the service serves, relative to the project root. */
const DEMO_SERVED = join("wikis", "wikifact");

/**
 * Stops the demo when the built CLI is missing.
 *
 * @param cli - the path of `dist/src/cli.js`
 * @throws {Error} with `run npm run build first` when the file does not exist
 * @sideEffects none
 */
export function requireBuilt(cli: string): void {
  if (!existsSync(cli)) throw new Error("run npm run build first");
}

/**
 * Copies the tracked demo wiki to `wikis/wikifact/`, unless the served store exists.
 *
 * @param root - the project root
 * @returns true when the copy was made, false when a store was already there
 * @throws {Error} when the tracked demo files are missing
 * @sideEffects creates `wikis/wikifact/` and writes the 2 files into it; never overwrites an existing store
 */
export function copyDemoWiki(root: string): boolean {
  const served = join(root, DEMO_SERVED);
  if (existsSync(join(served, WIKI_DB_FILE))) return false;
  mkdirSync(served, { recursive: true });
  for (const file of [WIKI_DB_FILE, WIKI_CONFIG_FILE]) copyFileSync(join(root, DEMO_SOURCE, file), join(served, file));
  return true;
}
