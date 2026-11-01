// `node dist/setup.js`: the file part of `/wikifact:setup`. It adds the permission for the tools of the wiki server to
// `.claude/settings.json` of the project, and writes `wiki.name` to `.claude/setup.config.json` when the key is absent.
// Both files are merged, never replaced: every other key stays, and a second run writes nothing. The `createWiki` call
// is not here: the text of the command makes it through the MCP tool.
// Design: docs/design/publication.md#consumer-plugin. Contract: docs/technical/publication.md#the-plugin.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import { CONFIG_FILE } from "./config.js";
import { SetupOutcome } from "./enums.js";
import { projectDir } from "./env.js";
import { errnoCode, errorMessage } from "./errors.js";
import { isMain } from "./main.js";

/**
 * The permission rule for every tool of the wiki server. A server of a plugin is named `plugin:<plugin>:<server>`, and
 * the rule for a server is `mcp__` and its name with each character that is not a letter, a digit or `_` or `-` as `_`.
 */
export const WIKI_PERMISSION = "mcp__plugin_wikifact_wikifact";

/** The path of the settings file, relative to the project folder. */
export const SETTINGS_FILE = ".claude/settings.json";

/** The indent of the files that the setup writes, in spaces. */
const JSON_INDENT = 2;

/** The most characters of a wiki name; the service refuses a longer one (`WIKI_NAME_PATTERN` in `src/service/names.ts`). */
export const MAX_NAME_LENGTH = 40;

/** The name when nothing is left of the folder name. */
const FALLBACK_NAME = "wiki";

/** Each run of characters that a wiki name does not hold. */
const NAME_GAP = /[^a-z0-9-]+/g;

/** A `-` at the start or the end of a name. */
const EDGE_HYPHENS = /^-+|-+$/g;

const SETTINGS = z.looseObject({
  permissions: z.looseObject({ allow: z.array(z.unknown()).optional() }).optional(),
});

const CONFIG = z.looseObject({
  wiki: z.looseObject({ name: z.unknown().optional() }).optional(),
});

/** What the setup did to a file, and why when it skipped the file. */
export interface SetupReport {
  outcome: SetupOutcome;
  reason?: string;
}

/** The content of a JSON file of the project, or why it cannot be used. */
type Loaded = { json: unknown } | { skipped: string };

// Reads a JSON file; a missing file is an empty object, a file that does not parse is skipped.
function loadJson(path: string, label: string): Loaded {
  try {
    return { json: JSON.parse(readFileSync(path, "utf8")) };
  } catch (e) {
    if (errnoCode(e) === "ENOENT") return { json: {} };
    if (e instanceof SyntaxError) return { skipped: errorMessage(e) };
    throw new Error(`${label}: ${errorMessage(e)}`, { cause: e });
  }
}

// Writes a JSON file with its folder.
function saveJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, JSON_INDENT)}\n`);
}

/**
 * Adds the wiki permission to the settings file of the project.
 *
 * @param dir - the project folder
 * @returns the outcome: `written` when the file changed, `unchanged` when the rule was already in it, `skipped` (with
 *   the reason) when the file does not parse or its `permissions.allow` is not a list; a skipped file stays untouched
 * @throws {Error} when the file cannot be read or written
 * @sideEffects reads the settings file; writes it (and its folder) when the rule is missing
 */
export function addWikiPermission(dir: string): SetupReport {
  const path = join(dir, SETTINGS_FILE);
  const loaded = loadJson(path, SETTINGS_FILE);
  if ("skipped" in loaded) return { outcome: SetupOutcome.Skipped, reason: loaded.skipped };
  const parsed = SETTINGS.safeParse(loaded.json);
  if (!parsed.success) return { outcome: SetupOutcome.Skipped, reason: '"permissions.allow" must be a list' };
  const settings = parsed.data;
  const allow = settings.permissions?.allow ?? [];
  if (allow.includes(WIKI_PERMISSION)) return { outcome: SetupOutcome.Unchanged };
  saveJson(path, { ...settings, permissions: { ...settings.permissions, allow: [...allow, WIKI_PERMISSION] } });
  return { outcome: SetupOutcome.Written };
}

/**
 * Derives the wiki name from the name of the project folder.
 *
 * @param dir - the project folder
 * @returns the folder name in lower case, with each run of characters other than `a-z`, `0-9` and `-` as 1 `-`, cut to
 *   `MAX_NAME_LENGTH`, with no `-` at the start or the end; `wiki` when nothing is left
 * @sideEffects none
 */
export function wikiNameOf(dir: string): string {
  const name = basename(resolve(dir)).toLowerCase().replace(NAME_GAP, "-").slice(0, MAX_NAME_LENGTH);
  return name.replace(EDGE_HYPHENS, "") || FALLBACK_NAME;
}

/**
 * Writes `wiki.name` to the config file of the project when the key is absent.
 *
 * @param dir - the project folder
 * @returns the outcome: `written` when the key was absent (the file is made when it is missing), `unchanged` when the
 *   key is there (a null value counts: the project chose no wiki), `skipped` (with the reason) when the file does not
 *   parse or its `wiki` is not an object; a skipped file stays untouched
 * @throws {Error} when the file cannot be read or written
 * @sideEffects reads the config file; writes it (and its folder) when `wiki.name` is absent
 */
export function addWikiName(dir: string): SetupReport {
  const path = join(dir, CONFIG_FILE);
  const loaded = loadJson(path, CONFIG_FILE);
  if ("skipped" in loaded) return { outcome: SetupOutcome.Skipped, reason: loaded.skipped };
  const parsed = CONFIG.safeParse(loaded.json);
  if (!parsed.success) return { outcome: SetupOutcome.Skipped, reason: 'the file must hold an object, and "wiki" too' };
  const config = parsed.data;
  if (config.wiki?.name !== undefined) return { outcome: SetupOutcome.Unchanged };
  saveJson(path, { ...config, wiki: { ...config.wiki, name: wikiNameOf(dir) } });
  return { outcome: SetupOutcome.Written };
}

// Prints the line of one file and tells whether it was skipped.
function print(file: string, result: SetupReport): boolean {
  const reason = result.reason === undefined ? "" : ` (${result.reason})`;
  process.stdout.write(`${file}: ${result.outcome}${reason}\n`);
  return result.outcome === SetupOutcome.Skipped;
}

if (isMain(import.meta.url)) {
  try {
    const dir = projectDir();
    const settingsSkipped = print(SETTINGS_FILE, addWikiPermission(dir));
    const configSkipped = print(CONFIG_FILE, addWikiName(dir));
    if (settingsSkipped || configSkipped) process.exitCode = 1;
  } catch (e) {
    process.stderr.write(`wikifact setup: ${errorMessage(e)}\n`);
    process.exitCode = 1;
  }
}
