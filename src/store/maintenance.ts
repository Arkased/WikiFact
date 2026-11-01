import type Database from "better-sqlite3";
import { embed, type EmbedFn } from "../embed/index.js";
import { INSERT_CURRENT, vectorBuffer, versionText } from "./indexer.js";
import { currentVecSql } from "./schema.js";
import type { Store } from "./types/index.js";

/** One index table whose row count differs from its source. */
export interface IndexDifference {
  table: string;
  expected: number;
  actual: number;
}

const count = (db: Database.Database, sql: string): number => (db.prepare(sql).get() as { n: number }).n;

/**
 * technical/updates.md, "System failures", F14. Compares the row count of each index table with its source.
 * The FTS tables are external-content, so their rows are counted in the `_docsize` shadow tables.
 *
 * @param store - the open store
 * @returns the differences; an empty array means the counts agree
 * @sideEffects none (reads)
 */
export function checkIndex(store: Store): IndexDifference[] {
  const { db } = store;
  const versions = count(db, "SELECT count(*) AS n FROM fact_versions");
  const live = count(db, "SELECT count(*) AS n FROM current_fact_versions WHERE is_deleted = 0");
  const rows: [string, number, number][] = [
    ["fact_versions_fts", versions, count(db, "SELECT count(*) AS n FROM fact_versions_fts_docsize")],
    ["fact_versions_vec", versions, count(db, "SELECT count(*) AS n FROM fact_versions_vec")],
    ["current_vec", live, count(db, "SELECT count(*) AS n FROM current_vec")],
  ];
  return rows.filter(([, e, a]) => e !== a).map(([table, expected, actual]) => ({ table, expected, actual }));
}

/**
 * technical/deployment.md, "Install and run". Rebuilds the index tables of the facts from `fact_versions`, and embeds everything
 * again.
 *
 * @param store - the open store
 * @param embedFn - the embedder; default the bundled model
 * @returns the number of fact versions that were indexed
 * @sideEffects the embedder runs before the transaction; one immediate transaction drops and recreates
 *   `current_vec` and rewrites the FTS and vector tables of the fact versions
 */
export async function reindex(store: Store, embedFn: EmbedFn = embed): Promise<{ versions: number }> {
  const { db } = store;
  const versions = db.prepare("SELECT id, fact_id, header, content FROM fact_versions ORDER BY id").all() as {
    id: number;
    fact_id: string;
    header: string;
    content: string;
  }[];
  const liveIds = new Set(
    (db.prepare("SELECT id FROM current_fact_versions WHERE is_deleted = 0").all() as { id: number }[]).map(
      (r) => r.id,
    ),
  );
  const vVec = await embedFn(versions.map((v) => versionText(v.header, v.content)));

  db.transaction(() => {
    // current_vec is dropped and created again, so that a database made with an older layout gets the new one.
    db.exec("DELETE FROM fact_versions_vec; DROP TABLE IF EXISTS current_vec;");
    db.exec(currentVecSql(store.config.embeddingDim));
    db.exec("INSERT INTO fact_versions_fts(fact_versions_fts) VALUES ('delete-all')");
    db.exec("INSERT INTO fact_versions_fts(fact_versions_fts) VALUES ('rebuild')");
    const insVec = db.prepare("INSERT INTO fact_versions_vec(fact_version_id, embedding) VALUES (?, ?)");
    const insCur = db.prepare(INSERT_CURRENT);
    versions.forEach((v, i) => {
      const e = vectorBuffer(vVec, i);
      insVec.run(BigInt(v.id), e);
      if (liveIds.has(v.id)) insCur.run(v.fact_id, e, e);
    });
  }).immediate();
  return { versions: versions.length };
}
