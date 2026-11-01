import type Database from "better-sqlite3";
import { StagedVectorKind } from "../domain/enums.js";
import { vectorBuffer, type Prepared } from "./indexer.js";
import type { IndexChange } from "./types/index.js";

// What `createIndexWriter().prepare` returned, when it has that shape; a custom index writer may return anything else.
function asPrepared(p: unknown): Prepared | undefined {
  if (typeof p !== "object" || p === null) return undefined;
  const { facts } = p as Partial<Prepared>;
  return Array.isArray(facts) ? { facts } : undefined;
}

/**
 * technical/updates.md, "High volume mode", "Staging". The index step of a write on the overlay store: the embeddings of
 * the change go to `stg_vectors` (a fact version by its id), and the promotion hands them to the index writer. No FTS,
 * `current_vec` or vector row is written, so no search sees the staged change.
 *
 * @param db - the open database, in the write transaction
 * @param change - the versions of the change, with the ids that the staging tables gave them
 * @param prepared - what `indexWriter.prepare` returned for the change; undefined: no vector is kept
 * @throws {Error} when `prepared` does not match the change in length
 * @sideEffects upserts rows of `stg_vectors`
 */
export function saveStagedVectors(db: Database.Database, change: IndexChange, prepared: unknown): void {
  const p = asPrepared(prepared);
  if (p && p.facts.length !== change.versions.length) {
    throw new Error("index: the prepared embeddings do not match the change");
  }
  const put = db.prepare("INSERT OR REPLACE INTO stg_vectors(kind, ref, embedding) VALUES (?, ?, ?)");
  if (p) change.versions.forEach((v, i) => put.run(StagedVectorKind.Fact, v.versionId, vectorBuffer(p.facts, i)));
}
