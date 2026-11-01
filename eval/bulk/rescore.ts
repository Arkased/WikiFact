// A new score of a result file (technical/updates.md, "The candidate architectures of the bulk test", "A new score of a
// result file").
import { readFileSync } from "node:fs";
import { z } from "zod";
import { JSON_INDENT } from "../../src/constants.js";
import { writeFileAtomic } from "../lib/write-file-atomic.js";
import { readResultFile } from "./resume.js";
import { rescoreRequests } from "./score.js";

const rawFile = z.looseObject({
  sequential: z.looseObject({}).optional(),
  batch: z.looseObject({}).optional(),
});

/**
 * Scores the request ends of each path of a result file again with the current scorer, keeps the checks of the end state
 * that the file holds, rebuilds the score line and writes the file back. A path with no score in the file stays as it is.
 * The rest of the file is written as it was read.
 *
 * @param path - the result file
 * @returns the score line of each path that was scored again, in the order of the file
 * @throws {Error} when the file holds no path; {z.ZodError} when the JSON has the wrong shape
 * @sideEffects reads the file and writes it back through a temp file and a rename; no model call and no copy
 */
export function rescoreResultFile(path: string): string[] {
  const parsed = readResultFile(path);
  // The file is read again as loose objects, so that a key the schema of the resume does not know is written back.
  const raw = rawFile.parse(JSON.parse(readFileSync(path, "utf8")));
  const lines: string[] = [];
  for (const key of ["sequential", "batch"] as const) {
    const result = parsed[key];
    const stored = raw[key];
    if (!result?.score || !stored) continue;
    const score = rescoreRequests(result.requests, result.score, result.path);
    raw[key] = { ...stored, score };
    lines.push(score.line);
  }
  writeFileAtomic(path, JSON.stringify(raw, null, JSON_INDENT) + "\n");
  return lines;
}
