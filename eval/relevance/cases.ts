import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { RelevanceQueryForm } from "../lib/enums.js";
import { EVAL_DIR } from "../replay/load.js";

const nonEmpty = z.string().min(1);

const caseSchema = z
  .object({
    id: nonEmpty,
    query: nonEmpty,
    expectHeader: nonEmpty.optional(),
    expectNone: z.literal(true).optional(),
    allowNear: z.array(nonEmpty).optional(),
    form: z.enum(RelevanceQueryForm).default(RelevanceQueryForm.Terms),
    note: nonEmpty,
  })
  .strict();

const fileSchema = z
  .object({
    facts: z.array(z.object({ header: nonEmpty, content: nonEmpty }).strict()),
    reads: z.array(nonEmpty),
    cases: z.array(caseSchema).min(1),
  })
  .strict();

/**
 * One query of `relevance.json`: the header it must find, or
 * `expectNone` when the seed cannot answer it. An `expectNone` case may list `allowNear`, the fact headers
 * of close neighbors that an agent with that question could fairly open; any other result fails it. `form` is
 * `terms` (a phrase of terms or a claim, the designed form) or `question` (the tolerance group).
 */
export type RelevanceCase = z.output<typeof caseSchema>;

/** The whole `relevance.json`: the extra seed facts, the facts to read first and the cases. */
export type RelevanceFile = z.infer<typeof fileSchema>;

/**
 * Reads `eval/relevance.json` and checks that every case has exactly one expectation.
 *
 * @returns the extra facts, the headers to read, and the cases
 * @throws {Error} when the file is malformed, a case has `allowNear` without `expectNone`, a case does not have exactly one of `expectHeader` and `expectNone`, a case
 *   id repeats, or a header to read is not an extra fact
 * @sideEffects reads eval/relevance.json
 */
export function loadRelevance(): RelevanceFile {
  const file = fileSchema.parse(JSON.parse(readFileSync(join(EVAL_DIR, "relevance.json"), "utf8")));
  const ids = new Set<string>();
  for (const c of file.cases) {
    if (c.allowNear !== undefined && c.expectNone === undefined)
      throw new Error(`relevance.json ${c.id}: allowNear is only for an expectNone case`);
    if ([c.expectHeader, c.expectNone].filter((e) => e !== undefined).length !== 1)
      throw new Error(`relevance.json ${c.id}: set exactly one of expectHeader and expectNone`);
    if (ids.has(c.id)) throw new Error(`relevance.json: the case id ${c.id} repeats`);
    ids.add(c.id);
  }
  const headers = new Set(file.facts.map((f) => f.header));
  for (const h of file.reads) if (!headers.has(h)) throw new Error(`relevance.json: reads names the unknown fact ${h}`);
  return file;
}
