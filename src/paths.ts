// technical/deployment.md, "Install and run": a wiki is a folder under `wikis/`. The default wiki is the demo.
import { readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { z } from "zod";

/** The database path that `--db` takes when the option is absent. The `wikifact.json` of the wiki sits next to it. */
export const DEFAULT_DB_PATH = "./wikis/demo/game.sqlite";

/** The file name of a wiki's database inside its folder under the wikis root (service mode, technical/deployment.md, "Service mode"). */
export const WIKI_DB_FILE = "game.sqlite";

/** The file name of a wiki's config; it sits next to the database. */
export const WIKI_CONFIG_FILE = "wikifact.json";

/**
 * Finds the project root from the place of this module: `<root>/src/paths.ts` in a checkout, and
 * `<root>/dist/src/paths.js` once built or installed, so the root is one folder above `src` or two.
 *
 * @returns the absolute path of the root
 * @sideEffects none
 */
export function projectRoot(): string {
  const built = extname(import.meta.filename) === ".js";
  return resolve(import.meta.dirname, built ? "../.." : "..");
}

const packageJson = z.object({ version: z.string() });

/**
 * Reads the version of this package from its `package.json` under the project root.
 *
 * @returns the `version` field, e.g. `0.1.2`
 * @throws {Error} when `package.json` is missing, is not JSON or has no string `version`
 * @sideEffects reads `package.json`
 */
export function packageVersion(): string {
  const text = readFileSync(join(projectRoot(), "package.json"), "utf8");
  return packageJson.parse(JSON.parse(text)).version;
}
