import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ChangeOutcome, enumValues, isMember } from "../../src/domain/index.js";
import { CriticalKind } from "../lib/enums.js";
import type { ReplayFile } from "./types.js";

/** The folder of replay.json and of the result folder: `eval/`. */
export const EVAL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Reads replay.json and checks the enum fields of every case, so that a typo fails here and not in a check.
 *
 * @returns the seed wiki and the cases
 * @throws {Error} when a case has a bad `critical` or `expect.outcome`
 * @sideEffects reads eval/replay.json
 */
export function loadReplay(): ReplayFile {
  const file = JSON.parse(readFileSync(join(EVAL_DIR, "replay.json"), "utf8")) as ReplayFile;
  for (const c of file.cases) {
    if (c.critical !== undefined && !isMember(CriticalKind, c.critical))
      throw new Error(
        `replay.json ${c.id}: critical is one of ${enumValues(CriticalKind).join(", ")}, not ${String(c.critical)}`,
      );
    if (!isMember(ChangeOutcome, c.expect.outcome))
      throw new Error(`replay.json ${c.id}: expect.outcome is not a ChangeOutcome: ${String(c.expect.outcome)}`);
  }
  return file;
}
