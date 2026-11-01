import { SearchStep } from "../../domain/enums.js";
import { embed } from "../../embed/index.js";
import type { Store } from "../types/index.js";
import { RRF_CANDIDATES, VEC_CANDIDATES, ftsQuery } from "./candidates.js";
import { search } from "./search.js";

/** The time of each step of one consumer search, in ms. */
export type SearchTimings = Record<SearchStep, number>;

/**
 * Times each step of the consumer search for one query: the embedder, the 2 candidate statements alone, and the whole
 * `search`. The statements are the same as the ones `search` runs, without the rescore and the fusion.
 *
 * @param store - the open store
 * @param query - the query text
 * @returns the time of each step, in ms; a full-text step is 0 when the query has no token
 * @throws {Error} when the embedder returns no vector for the query
 * @sideEffects reads the database; the embedder runs for the query; reads the clock
 */
export async function profileSearch(store: Store, query: string): Promise<SearchTimings> {
  const { db } = store;
  const timings: SearchTimings = {
    [SearchStep.Embed]: 0,
    [SearchStep.FtsFacts]: 0,
    [SearchStep.KnnFacts]: 0,
    [SearchStep.Total]: 0,
  };
  let start = performance.now();
  const [vector] = await embed([query]);
  timings[SearchStep.Embed] = performance.now() - start;
  if (!vector) throw new Error("profileSearch: the embedder returned no vector for the query");
  const blob = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
  const match = ftsQuery(query);

  const time = (step: SearchStep, sql: string, arg: string | Buffer): void => {
    // `search` skips the full-text statements for a query with no token, so the step stays at 0.
    if (arg === "") return;
    const statement = db.prepare(sql);
    start = performance.now();
    statement.all(arg);
    timings[step] = performance.now() - start;
  };
  time(
    SearchStep.FtsFacts,
    `SELECT c.fact_id FROM fact_versions_fts f JOIN current_fact_versions c ON c.id = f.rowid
     WHERE fact_versions_fts MATCH ? AND c.is_deleted = 0 ORDER BY f.rank LIMIT ${RRF_CANDIDATES}`,
    match,
  );
  time(
    SearchStep.KnnFacts,
    `SELECT fact_id, full FROM current_vec WHERE embedding MATCH vec_quantize_binary(?) AND k = ${VEC_CANDIDATES}`,
    blob,
  );
  start = performance.now();
  await search(store, query);
  timings[SearchStep.Total] = performance.now() - start;
  return timings;
}
