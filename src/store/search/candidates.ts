import type Database from "better-sqlite3";
import { eng, removeStopwords } from "stopword";
import { HALF } from "../../constants.js";

/** technical/lookup.md, "Retrieval pipeline": candidates per ranked list that goes into the rank fusion, in rows. */
export const RRF_CANDIDATES = 50;

/**
 * Candidates, in rows, that the 1-bit KNN over `current_vec` hands to the exact rescore. More candidates raise
 * recall and cost time: the scan is the same, the heap and the rescore grow.
 */
export const VEC_CANDIDATES = 100;

/** The FTS5 operator between the quoted tokens of a query. */
const FTS_OR = " OR ";

/** Punctuation at the edges of a token, which does not belong to the word. */
const EDGE_PUNCTUATION = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;

/** The query as the candidate lists need it: the vector, its bytes and the FTS5 match string. */
export interface SearchQuery {
  vector: Float32Array;
  /** The bytes of `vector`, for `embedding MATCH ?`. */
  blob: Buffer;
  /** The result of `ftsQuery`; "" when the query has no token. */
  match: string;
  /** The number of terms in `match`, which the relevance floor compares with the matched terms of a row. */
  terms: number;
}

/**
 * A fact in a candidate list. `versionId` is set in agent form only. `distance` is set on the vector list only:
 * the cosine distance (`1 - dot`; 0 is identical, 1 is unrelated) between the query and the fact vector.
 * `ftsTerms` is set on the full-text list only: the number of distinct query terms the row matches.
 */
interface FactHit {
  factId: string;
  versionId?: number;
  distance?: number;
  ftsTerms?: number;
}

/** The two ranked lists for facts. Each is ordered best first. */
export interface FactLists {
  fts: FactHit[];
  vec: FactHit[];
}

/**
 * technical/lookup.md, "Retrieval pipeline", step 1. Escapes a query for FTS5: splits on whitespace, quotes each token, joins with ` OR `,
 * so that `-`, `"`, `*` and `AND` in the text are not read as FTS5 syntax and one matching token is enough to
 * enter the list. A quote inside a token is doubled.
 *
 * @param query - the query text
 * @returns the FTS5 match string; "" when the query has no token
 * @sideEffects none
 */
export function ftsQuery(query: string): string {
  return queryTokens(query)
    .map((t) => `"${t.replaceAll('"', '""')}"`)
    .join(FTS_OR);
}

/**
 * The tokens of a query that the full-text search uses: the whitespace-separated tokens without the English
 * stopwords. A token that is only punctuation is kept, since it is no stopword.
 *
 * @param query - the query text
 * @returns the tokens in order; empty when the query has none or every token is a stopword
 * @sideEffects none
 */
export function queryTokens(query: string): string[] {
  return query
    .split(/\s+/)
    .filter((t) => t !== "")
    .filter((t) => {
      // A stopword with punctuation around it ("is?", "(the") is still a stopword.
      const word = t.toLowerCase().replace(EDGE_PUNCTUATION, "");
      return word === "" || removeStopwords([word], eng).length > 0;
    });
}

// The 2 columns of the FTS table, highlighted with brackets; "T" stands for the table name.
const HIGHLIGHT = "highlight(T, 0, '[', ']') AS h0, highlight(T, 1, '[', ']') AS h1";

// The two highlighted columns of one FTS row.
interface Highlighted {
  h0: string | null;
  h1: string | null;
}

// Counts the distinct terms that `highlight` marked in the 2 columns of one FTS row, case-folded.
function termsOf(row: Highlighted): number {
  const terms = new Set<string>();
  for (const text of [row.h0, row.h1])
    for (const m of (text ?? "").matchAll(/\[([^\]]*)\]/g)) terms.add((m[1] ?? "").toLowerCase());
  return terms.size;
}

/**
 * Cosine distance, `1 - dot`, between a float query and a float vector stored as a blob. Both are unit vectors
 * (the embedder normalizes), so it orders as the L2 distance does: |a - b|^2 = 2 - 2 dot = 2 * (1 - dot).
 *
 * @param q - the query vector
 * @param blob - the float vector as stored, `q.length` floats
 * @returns the distance; 0 is identical, 1 is unrelated
 * @sideEffects none
 */
export function cosineDistance(q: Float32Array, blob: Buffer): number {
  // The blob may not sit on a 4-byte boundary, so copy it.
  const v = new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));
  let dot = 0;
  for (let i = 0; i < q.length; i++) dot += (q[i] ?? 0) * (v[i] ?? 0);
  return 1 - dot;
}

/**
 * The cosine distance from the distance that sqlite-vec reports on a float column. That is the L2 distance,
 * sqrt(|a - b|^2), and for unit vectors |a - b|^2 = 2 * (1 - dot), so the cosine distance is the square over 2.
 *
 * @param l2 - the L2 distance between 2 unit vectors
 * @returns the cosine distance
 * @sideEffects none
 */
const cosineFromL2 = (l2: number): number => (l2 * l2) / HALF;

/**
 * technical/lookup.md, "Retrieval pipeline", step 2 and 4. Builds the full-text list and the vector list for facts.
 * In consumer form the lists name live current versions and no version id. In agent form (`history`)
 * they range over every version and carry the version id. The consumer vector list runs the KNN on the
 * 1-bit vectors (`VEC_CANDIDATES` rows) and keeps the best `RRF_CANDIDATES` by exact cosine distance on the
 * float vectors. Every vector hit carries its cosine distance.
 *
 * @param db - the open database
 * @param query - the embedded query and its FTS5 match string
 * @param history - true for the agent form
 * @returns the two lists, best first
 * @sideEffects none (reads)
 */
export function factCandidates(db: Database.Database, query: SearchQuery, history: boolean): FactLists {
  const { match, blob, vector } = query;
  if (history) {
    const ftsRows = match
      ? (db
          .prepare(
            `SELECT v.id AS versionId, v.fact_id AS factId,
                    ${HIGHLIGHT.replaceAll("T", "fact_versions_fts")}
             FROM fact_versions_fts f JOIN fact_versions v ON v.id = f.rowid
             WHERE fact_versions_fts MATCH ? ORDER BY f.rank LIMIT ${RRF_CANDIDATES}`,
          )
          .all(match) as (FactHit & Highlighted)[])
      : [];
    const fts = ftsRows.map((r) => ({ factId: r.factId, versionId: r.versionId, ftsTerms: termsOf(r) }));
    const rows = db
      .prepare(
        `SELECT v.id AS versionId, v.fact_id AS factId, k.distance AS distance
         FROM (SELECT fact_version_id, distance FROM fact_versions_vec WHERE embedding MATCH ? AND k = ${RRF_CANDIDATES}) k
         JOIN fact_versions v ON v.id = k.fact_version_id ORDER BY k.distance`,
      )
      .all(blob) as (FactHit & { distance: number })[];
    return { fts, vec: rows.map((r) => ({ ...r, distance: cosineFromL2(r.distance) })) };
  }
  const ftsRows = match
    ? (db
        .prepare(
          `SELECT c.fact_id AS factId, ${HIGHLIGHT.replaceAll("T", "fact_versions_fts")}
           FROM fact_versions_fts f JOIN current_fact_versions c ON c.id = f.rowid
           WHERE fact_versions_fts MATCH ? AND c.is_deleted = 0 ORDER BY f.rank LIMIT ${RRF_CANDIDATES}`,
        )
        .all(match) as (FactHit & Highlighted)[])
    : [];
  const fts = ftsRows.map((r) => ({ factId: r.factId, ftsTerms: termsOf(r) }));
  const rows = db
    .prepare(
      `SELECT fact_id AS factId, full FROM current_vec WHERE embedding MATCH vec_quantize_binary(?) AND k = ${VEC_CANDIDATES}`,
    )
    .all(blob) as { factId: string; full: Buffer }[];
  const vec = rows
    .map((r) => ({ factId: r.factId, distance: cosineDistance(vector, r.full) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, RRF_CANDIDATES);
  return { fts, vec };
}
