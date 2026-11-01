import { ChangeOutcome } from "../../src/domain/index.js";
import { newId, seedChange, type FactDraft, type Store } from "../../src/store/index.js";
import { required } from "../lib/required-value.js";
import type { ReplayFile, SeedFact } from "./types.js";

/**
 * Writes the seed wiki of replay.json into a store, one change per fact version, oldest version first.
 *
 * @param store - an open, empty store
 * @param file - the replay file
 * @returns the new fact id of each seed fact, by key
 * @sideEffects writes changes to the store through `seedChange`; the embedder runs
 */
export async function seedReplayStore(store: Store, file: ReplayFile): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const f of file.facts) ids[f.key] = newId();
  const write = async (draft: FactDraft): Promise<void> => {
    await seedChange(store, {
      outcome: ChangeOutcome.Accepted,
      summary: "seed",
      changeReasoning: "seed",
      facts: [draft],
    });
  };
  for (const f of file.facts) {
    const factId = required(ids[f.key], `replay.json: no id for the seed fact ${f.key}`);
    const refs = (f.refs ?? []).map((k) => required(ids[k], `replay.json: ${f.key} refers to the unknown fact ${k}`));
    const version = (content: string, justification: string, isDeleted?: boolean): FactDraft => ({
      factId,
      header: f.header,
      content,
      justification,
      references: refs,
      ...(isDeleted ? { isDeleted } : {}),
    });
    for (const o of [...(f.older ?? [])].reverse()) await write(version(o.content, o.just));
    await write(version(f.content, f.deleted ? deletedJustification(f) : f.just));
    if (f.deleted) await write(version(f.content, f.just, true));
  }
  return ids;
}

// The justification of the live version of a seed fact that is deleted later: the oldest recorded one.
function deletedJustification(f: SeedFact): string {
  return f.older?.[0]?.just ?? f.just;
}
