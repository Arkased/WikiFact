// technical/deployment.md, "Install and run": `wikifact.json` next to the database file, merged with the presets of technical/questions.md, "Quality presets".
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { QuestionId } from "../domain/enums.js";
import { errorMessage } from "../must.js";
import { WIKI_CONFIG_FILE } from "../paths.js";
import { DEFAULT_WEIGHTS } from "../store/types/index.js";
import { loadPresets, presetsPath, type Presets } from "./presets.js";
import { QUESTION_IDS, configSchema, type Config, type QuestionSettings } from "./schema.js";

/** The options of `parseConfig`. */
export interface ParseConfigOptions {
  /** The presets to use. Default: the file at `presetsPath()`. */
  presets?: Presets;
}

/** The options of `loadConfig`. */
export interface LoadConfigOptions {
  /** The presets file to read. Default: `presetsPath()`. */
  presetsPath?: string;
}

/**
 * Validates the parsed JSON of `wikifact.json` and fills every default. The model and effort of each question come
 * from the presets table of the chosen quality, and an entry under `questions` overrides it.
 *
 * @param raw - the parsed JSON of `wikifact.json`; `undefined` or `null` gives the all-defaults config
 * @param opts - the presets to use; absent means the file at `presetsPath()` is read
 * @returns the config, with all of Q1 to Q10 set under `questions` and the weights merged over `DEFAULT_WEIGHTS`
 * @throws {ZodError} when `raw` has an unknown key or a bad value
 * @throws {Error} when the presets file, the table of the chosen quality or one question's entry is missing
 * @sideEffects reads the presets file when `opts.presets` is absent
 */
export function parseConfig(raw: unknown, opts: ParseConfigOptions = {}): Config {
  const c = configSchema.parse(raw ?? {});
  const presets = opts.presets ?? loadPresets();
  const file = presets.sourcePath ?? presetsPath();
  const table = presets.presets[c.quality];
  if (!table) throw new Error(`The presets file ${file} has no "${c.quality}" table under "presets".`);
  const preset = {} as Record<QuestionId, QuestionSettings>;
  for (const q of QUESTION_IDS) {
    const e = table[q];
    if (!e) throw new Error(`The "${c.quality}" table of the presets file ${file} has no entry for ${q}.`);
    preset[q] = { model: e.model, effort: e.effort };
  }
  return {
    mode: c.mode,
    quality: c.quality,
    subject: c.subject,
    ...(c.description === undefined ? {} : { description: c.description }),
    embeddingModel: c.embeddingModel,
    // The preset, then wikifact.json.
    questions: { ...preset, ...c.questions },
    questionTimeout: c.questionTimeout,
    weights: { ...DEFAULT_WEIGHTS, ...c.weights },
    searchCap: c.searchCap,
    agentSearchCap: c.agentSearchCap,
    relevanceFloor: c.relevanceFloor,
    highVolume: c.highVolume,
  };
}

/**
 * Names the `wikifact.json` of a wiki, which sits next to its database.
 *
 * @param dbPath - the path of the database file
 * @returns the path of `wikifact.json` in the folder of the database
 * @sideEffects none
 */
export function configPath(dbPath: string): string {
  return join(dirname(dbPath), WIKI_CONFIG_FILE);
}

/**
 * Loads `wikifact.json` next to the database. A missing `wikifact.json` gives the defaults.
 *
 * @param dbPath - the path of the database file; only its folder is used
 * @param opts - the presets file to read; absent means `presetsPath()`
 * @returns the config, never undefined
 * @throws {Error} that names the file when the presets file is absent, or either file is not JSON or is invalid
 * @sideEffects reads the presets file and, when it exists, `wikifact.json`
 */
export function loadConfig(dbPath: string, opts: LoadConfigOptions = {}): Config {
  const path = configPath(dbPath);
  const presets = loadPresets({ path: opts.presetsPath });
  const popts = { presets };
  if (!existsSync(path)) return parseConfig({}, popts);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`${path} is not valid JSON: ${errorMessage(e)}`, { cause: e });
  }
  try {
    return parseConfig(raw, popts);
  } catch (e) {
    if (e instanceof z.ZodError) {
      throw new Error(
        `${path} is invalid: ${e.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`,
        { cause: e },
      );
    }
    throw e;
  }
}
