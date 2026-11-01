// The `change` document of a `cleanupRepair` request (technical/updates.md, "Queue and worker", technical/cleanup.md, "Cleanup"): the finder and the ids of one candidate.
import { z } from "zod";
import { CleanupFinder } from "../../domain/enums.js";

const id = z.string().min(1);

/** The schema of the `change` document of a `cleanupRepair` request. A document of a removed finder does not parse. */
const cleanupRepairSchema = z
  .object({ finder: z.literal(CleanupFinder.DuplicateFact), factIds: z.tuple([id, id]) })
  .strict()
  .refine((d) => d.factIds[0] !== d.factIds[1], { message: "a duplicate candidate needs 2 different facts" });

/**
 * One candidate of a cleanup finder, which is also the `change` document of its `cleanupRepair` request:
 * `duplicateFact` names the 2 facts of the pair, the older first.
 */
export type CleanupRepair = z.infer<typeof cleanupRepairSchema>;

/**
 * Parses the `change` text of a `cleanupRepair` request.
 *
 * @param json - the JSON text of the document
 * @returns the candidate
 * @throws {Error} with a message that says what is wrong when the text is not JSON or not a valid candidate
 * @sideEffects none
 */
export function parseCleanupRepair(json: string): CleanupRepair {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("the cleanup repair is not valid JSON");
  }
  const parsed = cleanupRepairSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `the cleanup repair is invalid: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`,
    );
  }
  return parsed.data;
}

/**
 * Lists the ids a candidate touches, which become `targets` of its request.
 *
 * @param repair - the candidate
 * @returns the 2 fact ids
 * @sideEffects none
 */
export function cleanupRepairTargets(repair: CleanupRepair): string[] {
  return [...repair.factIds];
}

/**
 * Names what a candidate is about, so that two requests for the same thing can be told apart: the finder and the pair of
 * facts. The finder skips a candidate whose key a queued or running request holds.
 *
 * @param repair - the candidate
 * @returns the key, for example `duplicateFact:<factId> <factId>`
 * @sideEffects none
 */
export function cleanupRepairKey(repair: CleanupRepair): string {
  return `${repair.finder}:${[...repair.factIds].sort().join(" ")}`;
}
