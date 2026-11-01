import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChangeOutcome } from "../../src/domain/enums.js";
import {
  applyChangeSync,
  enqueueRequest,
  openStore,
  type ApplyResult,
  type ChangeSet,
  type FactDraft,
  type Store,
} from "../../src/store/index.js";

export const DAY = 24 * 60 * 60 * 1000;
export const T0 = 1_700_000_000_000;

export function makeStore(): Store {
  return openStore(":memory:", { embeddingModel: "test-model" });
}

/**
 * Opens a store on a database file in a temp folder of its own, for a test of the staging set (its file lies next to the database).
 *
 * @returns the open store
 * @sideEffects makes a temp folder under the run folder (`__tests__/global-setup.ts` deletes it); creates the database file
 */
export function makeFileStore(): Store {
  return openStore(join(mkdtempSync(join(tmpdir(), "wikifact-store-")), "wiki.sqlite"), {
    embeddingModel: "test-model",
  });
}

export function draft(over: Partial<FactDraft> = {}): FactDraft {
  return {
    header: "Creeper damage",
    content: "Creepers do 10 damage.",
    justification: "I measured 10 damage.",
    references: [],
    ...over,
  };
}

export function accepted(facts: FactDraft[]): ChangeSet {
  return {
    outcome: ChangeOutcome.Accepted,
    summary: "test change",
    changeReasoning: "test reasoning",
    facts,
  };
}

/**
 * Enqueues a request and applies the change set under it.
 *
 * @param store - the open store
 * @param cs - the change set to apply
 * @param now - the clock value, in milliseconds
 * @returns the apply result
 */
export function write(store: Store, cs: ChangeSet, now: number): ApplyResult {
  const reqId = enqueueRequest(store, { change: "c", justification: "j" }, now);
  return applyChangeSync(store, reqId, cs, { now });
}

/**
 * Reads the id of the one fact in a store.
 *
 * @param store - a store that holds exactly one fact
 * @returns the fact id; throws when the store has no fact
 * @sideEffects reads the store
 */
export function factIdOf(store: Store): string {
  return (store.db.prepare("SELECT id FROM facts").get() as { id: string }).id;
}
