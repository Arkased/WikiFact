// technical/questions.md, "Quality presets": the presets file `config/presets.json`. `budget` is the cheapest configuration that passes the bar of
// technical/questions.md, "Test plan"; `standard` is the best mean for classification and judgment and the budget rule for drafting;
// `premium` is the best mean, cheapest among ties, on every question.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { Quality } from "../domain/enums.js";
import { readEnv, type Env } from "../env.js";
import { projectRoot } from "../paths.js";
import { effort, questionTable } from "./schema.js";

/** How many characters of a parse error go into the message about an invalid presets file. */
const ERROR_TEXT_CHARS = 300;

// A key that the schema does not name (another table, a note, the `groupSizes` of an older file) is dropped on parse.
// An entry of a question that no longer exists (Q7B, Q5B, Q11 to Q15 and Q11B were removed) is ignored, so that the file
// can keep the measured record as it was written.
const presetTable = questionTable(z.object({ model: z.string().min(1), effort }));
const presetsSchema = z.object({
  /** The summary file that the tables came from, in `eval/questions/results/`. */
  source: z.string().optional(),
  presets: z.object({
    [Quality.Budget]: presetTable.optional(),
    [Quality.Standard]: presetTable.optional(),
    [Quality.Premium]: presetTable.optional(),
  }),
});

/** The parsed presets file. `sourcePath` is the file that the presets were read from, for error messages. */
export type Presets = z.infer<typeof presetsSchema> & { sourcePath?: string };

/**
 * Names the presets file: `WIKIFACT_PRESETS` when set, else `config/presets.json` in the project root.
 *
 * @param env - the parsed environment; default: read from `process.env`
 * @returns the path of the presets file
 * @sideEffects reads `process.env` when no environment is given; reads the file system for the project root
 */
export function presetsPath(env: Env = readEnv()): string {
  return env.presetsPath ?? join(projectRoot(), "config", "presets.json");
}

/** The options of `loadPresets`. */
export interface LoadPresetsOptions {
  /** The file to read. Default: `presetsPath()`. */
  path?: string;
}

/**
 * Reads and validates the presets file, the source of the model and effort of each question.
 *
 * @param opts - the file to read; absent means `presetsPath()`
 * @returns the presets, with `sourcePath` set to the file that was read
 * @throws {Error} when the file is absent (the message says how to create it) or is not valid presets JSON
 * @sideEffects reads the presets file
 */
export function loadPresets(opts: LoadPresetsOptions = {}): Presets {
  const path = opts.path ?? presetsPath();
  if (!existsSync(path)) {
    throw new Error(
      `The presets file ${path} is missing. It holds the model and effort of every question; create it with \`npm run eval:questions -- summarize\`.`,
    );
  }
  try {
    return { ...presetsSchema.parse(JSON.parse(readFileSync(path, "utf8"))), sourcePath: path };
  } catch (e) {
    throw new Error(
      `The presets file ${path} is invalid: ${e instanceof Error ? e.message.slice(0, ERROR_TEXT_CHARS) : "invalid"}`,
      { cause: e },
    );
  }
}
