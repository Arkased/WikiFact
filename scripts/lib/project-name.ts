import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { errorMessage } from "../../src/must.js";

/** The path of the project config, from this file's place in `scripts/lib/`. */
const CONFIG_PATH = fileURLToPath(new URL("../../.claude/setup.config.json", import.meta.url));

const NameSchema = z.object({ projectName: z.string().min(1) });

/**
 * Reads the name of the project from `.claude/setup.config.json`; the check lock is named after it.
 *
 * @param path - the config file; the one of the repo by default
 * @returns the value of `projectName`
 * @throws {Error} when the file is missing or is not JSON, or `projectName` is missing or is not a non-empty string
 * @sideEffects reads the file
 */
export function readProjectName(path: string = CONFIG_PATH): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`cannot read the project config ${path}: ${errorMessage(e)}`, {
      cause: e,
    });
  }
  const result = NameSchema.safeParse(parsed);
  if (!result.success) throw new Error(`${path}: key "projectName" must be a non-empty string`);
  return result.data.projectName;
}
