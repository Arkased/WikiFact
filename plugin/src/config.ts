// The wiki name of the project, read from `.claude/setup.config.json` in the project folder (`$CLAUDE_PROJECT_DIR`).
// No file means the project never ran the setup: the load returns null and the hook does nothing. A file that does not
// parse, or whose `wiki.name` has the wrong type, is a `ConfigError` that names the file and the key.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { projectDir } from "./env.js";
import { errnoCode, errorMessage } from "./errors.js";

/** The path of the config file, relative to the project folder. */
export const CONFIG_FILE = ".claude/setup.config.json";

const WIKI = z.object({ wiki: z.object({ name: z.string().min(1).nullable() }) });

/** The config file is unusable: it does not parse, or `wiki.name` is missing or has the wrong type. */
class ConfigError extends Error {
  /**
   * Builds the error.
   *
   * @param message - the file, the key and the problem
   * @param options - the cause
   * @sideEffects none
   */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConfigError";
  }
}

/**
 * Reads the name of the wiki of the project.
 *
 * @param dir - the project folder; `$CLAUDE_PROJECT_DIR` by default
 * @returns `wiki.name`, which is null when the project has no wiki, or null when the project has no config file
 * @throws {ConfigError} when the file cannot be read, is not JSON, or has no valid `wiki.name`
 * @sideEffects reads the config file and the environment
 */
export function loadWikiName(dir: string = projectDir()): string | null {
  const path = join(dir, CONFIG_FILE);
  const file = `${CONFIG_FILE} (${path})`;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if (errnoCode(e) === "ENOENT") return null;
    throw new ConfigError(`${file}: cannot read: ${errorMessage(e)}`, { cause: e });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new ConfigError(`${file}: not valid JSON: ${errorMessage(e)}`, { cause: e });
  }
  const result = WIKI.safeParse(parsed);
  if (!result.success) throw new ConfigError(`${file}: key "wiki.name" must be a non-empty string or null`);
  return result.data.wiki.name;
}
