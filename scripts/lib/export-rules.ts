// technical/publication.md, "publication/export.json": the rules file of the export and the questions it answers about a path.
import { readFileSync } from "node:fs";
import { z } from "zod";
import { Mode } from "../../src/domain/index.js";

const rulesSchema = z
  .object({
    exclude: z.array(z.string().min(1)),
    binaryAllow: z.array(z.string().min(1)),
    resultFolders: z.array(z.string().min(1)),
    demo: z.object({ source: z.string().min(1), config: z.object({ mode: z.enum(Mode) }).strict() }).strict(),
  })
  .strict();

/** The rules of the export, as `publication/export.json` holds them. */
export type ExportRules = z.infer<typeof rulesSchema>;

/**
 * Reads and validates the rules file.
 *
 * @param path - the path of `publication/export.json`
 * @returns the rules
 * @throws {Error} when the file is missing, is not JSON, or does not match the schema (unknown keys included)
 * @sideEffects reads the file
 */
export function loadExportRules(path: string): ExportRules {
  return rulesSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

/**
 * Tells whether the export leaves a path out: it is in `exclude`, or under a folder of `exclude`.
 *
 * @param path - a path in the repo, relative to the root, with forward slashes
 * @param rules - the rules of the export
 * @returns true when the path is excluded
 * @sideEffects none
 */
export function isExcluded(path: string, rules: ExportRules): boolean {
  return rules.exclude.some((e) => (e.endsWith("/") ? path.startsWith(e) || `${path}/` === e : path === e));
}
