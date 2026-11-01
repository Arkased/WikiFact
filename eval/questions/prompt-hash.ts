// The hash of what a question sends the model as instructions: its system prompt, its output schema and where its wiki block goes (technical/questions.md, "Quality presets").
import { createHash } from "node:crypto";
import type { z } from "zod";
import type { QuestionId } from "../../src/domain/index.js";
import { SPECS, jsonSchemaOf } from "../../src/updates/index.js";

/** The characters of the hash that are kept. */
const HASH_LENGTH = 16;

/** The layout mark of a spec with a wiki block: the block is in the cached prefix, after the system prompt. */
const WIKI_IN_PREFIX = "wiki:cached-prefix";

/** The part of a question spec that the model receives as instructions. */
export interface Instructions {
  system: string;
  output: z.ZodType;
  /** Present when the spec renders a wiki block, which the transport puts in the cached prefix, not in the message. */
  wiki?: unknown;
}

/**
 * Hashes the instructions of a question: the system prompt, the JSON Schema of the output and the layout of the call,
 * as the caller sends them. The layout is whether the spec has a wiki block (it goes in the cached prefix); a spec with
 * no wiki block adds nothing, so its hash stays. The case input is not part of it.
 *
 * @param spec - the question's system prompt, output schema and, when it has one, its wiki block renderer
 * @returns the first 16 hex characters of the SHA-256; it changes when the prompt text, the schema or the layout changes
 * @sideEffects none
 */
export function promptHashOf(spec: Instructions): string {
  const text = JSON.stringify([
    spec.system,
    jsonSchemaOf(spec.output),
    ...(spec.wiki === undefined ? [] : [WIKI_IN_PREFIX]),
  ]);
  return createHash("sha256").update(text).digest("hex").slice(0, HASH_LENGTH);
}

/**
 * Hashes the instructions of a question as the code has them now.
 *
 * @param q - the question
 * @returns the hash of the spec in `SPECS`
 * @sideEffects none
 */
export function currentPromptHash(q: QuestionId): string {
  return promptHashOf(SPECS[q]);
}
