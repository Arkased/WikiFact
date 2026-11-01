// What the repair of the duplicate fact check (technical/cleanup.md, "Cleanup") returns.
import type { CleanupFinder } from "../domain/enums.js";

/**
 * What a repair decides for one candidate: a change that the merge already wrote, verdicts to write because the model found nothing
 * to change, or nothing because the candidate no longer fits its finder. `merged` is a change that the merge of step 3
 * already wrote and logged (the duplicate fact repair), with the fact that stays and the fact that the merge deleted.
 */
export type RepairResult =
  | { merged: { seq: number; keptId: string; removedId: string } }
  | { verdict: { finder: CleanupFinder; subjects: string[] }; note: string }
  | { stale: string };
