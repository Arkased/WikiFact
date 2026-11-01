// The `change` document of an `operatorEdit` request (technical/console.md, "The `operatorEdit` request", technical/updates.md, "Queue and worker").
import { z } from "zod";
import { OperatorEditKind } from "../../domain/enums.js";

/** The longest operator note, in characters. */
export const MAX_NOTE_LENGTH = 500;

const note = z.string().trim().min(1).max(MAX_NOTE_LENGTH);

/** The schema of the `change` document of an `operatorEdit` request, a union on `edit`. */
const operatorEditSchema = z.discriminatedUnion("edit", [
  z.object({ edit: z.literal(OperatorEditKind.Cleanup), note }).strict(),
  z.object({ edit: z.literal(OperatorEditKind.Reindex), note }).strict(),
]);

/** One `operatorEdit` document: the edit, its fields and the operator's note. */
export type OperatorEdit = z.infer<typeof operatorEditSchema>;

/**
 * Parses the `change` text of an `operatorEdit` request.
 *
 * @param json - the JSON text of the document
 * @returns the edit
 * @throws {Error} with a message that says what is wrong when the text is not JSON or not a valid edit
 * @sideEffects none
 */
export function parseOperatorEdit(json: string): OperatorEdit {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("the operator edit is not valid JSON");
  }
  const parsed = operatorEditSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `the operator edit is invalid: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`,
    );
  }
  return parsed.data;
}
