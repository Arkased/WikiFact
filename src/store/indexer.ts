import type Database from "better-sqlite3";
import { embed, type EmbedFn } from "../embed/index.js";
import type { ChangeSet, IndexChange, IndexWriter } from "./types/index.js";

/**
 * The SQL that inserts one live fact into `current_vec`: a 1-bit vector for the KNN and the float vector for the
 * rescore. Both come from the same float buffer (bind it twice).
 */
export const INSERT_CURRENT = "INSERT INTO current_vec(fact_id, embedding, full) VALUES (?, vec_quantize_binary(?), ?)";

/**
 * technical/storage.md, "Index tables": the text that is embedded and indexed for a fact version.
 *
 * @param header - the fact header
 * @param content - the fact content
 * @returns the header, a full stop, a space and the content
 * @sideEffects none
 */
export const versionText = (header: string, content: string): string => `${header}. ${content}`;

/** What `createIndexWriter().prepare` returns: one vector per fact draft, in change set order. */
export interface Prepared {
  facts: Float32Array[];
}

/**
 * Views a float vector as the bytes sqlite-vec takes.
 *
 * @param vectors - the embeddings of the facts of a change set, in change set order
 * @param i - the zero-based position of the vector in `vectors`
 * @returns a Buffer over the vector's memory (no copy), so the caller must not mutate the vector while it is bound
 * @throws {Error} when there is no vector at `i`
 * @sideEffects none
 */
export function vectorBuffer(vectors: Float32Array[], i: number): Buffer {
  const v = vectors[i];
  if (v === undefined) throw new Error(`index: no embedding at position ${i}`);
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

/**
 * Builds the index writer of technical/updates.md, "Write transaction", step 1 and 6. `prepare` embeds before the transaction.
 * `write` runs in it. `prepare` gets the change set with deletion drafts filled in, so the texts
 * match the rows. Without `prepared` (a sync caller that skipped step 1), `write` fills the FTS tables
 * only, and `checkIndex` reports the missing vector rows.
 *
 * @param embedFn - maps texts to one vector each, in order; default `embed` (the embedder in use, the real model
 *   unless a test swapped it)
 * @returns an index writer whose `prepare` returns `Prepared`
 * @sideEffects `prepare` calls the embedder; `write` inserts and deletes rows of the FTS and vector tables
 *   inside the caller's transaction, and throws Error when `prepared` does not match the change in length
 */
export function createIndexWriter(embedFn: EmbedFn = embed): IndexWriter<Prepared> {
  return {
    async prepare(change: ChangeSet): Promise<Prepared> {
      return { facts: await embedFn(change.facts.map((f) => versionText(f.header, f.content))) };
    },
    write(db: Database.Database, change: IndexChange, p: Prepared | undefined): void {
      if (p && p.facts.length !== change.versions.length) {
        throw new Error("index: the prepared embeddings do not match the change");
      }
      writeVersions(db, change, p);
    },
  };
}

// technical/updates.md, "Write transaction", step 6: the FTS rows, the vector rows and the `current_vec` row of each new version.
function writeVersions(db: Database.Database, change: IndexChange, p: Prepared | undefined): void {
  const insFts = db.prepare("INSERT INTO fact_versions_fts(rowid, header, content) VALUES (?, ?, ?)");
  const insVec = db.prepare("INSERT INTO fact_versions_vec(fact_version_id, embedding) VALUES (?, ?)");
  const delCur = db.prepare("DELETE FROM current_vec WHERE fact_id = ?");
  const insCur = db.prepare(INSERT_CURRENT);
  change.versions.forEach((v, i) => {
    insFts.run(BigInt(v.versionId), v.header, v.content);
    delCur.run(v.factId);
    if (!p) return;
    const e = vectorBuffer(p.facts, i);
    insVec.run(BigInt(v.versionId), e);
    if (!v.isDeleted) insCur.run(v.factId, e, e);
  });
}
