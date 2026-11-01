// The search log of technical/lookup.md, "Search log and sessions".
import type { SearchHitKind } from "../domain/enums.js";
import { newId } from "./queue.js";
import { search } from "./search/index.js";
import type { SearchResult, Store } from "./types/index.js";

/** One result of a logged search. */
interface SearchLogResult {
  /** The kind of the result: a fact. */
  kind: SearchHitKind;
  /** The fact id. */
  targetId: string;
  /** 1 for the first result. */
  rank: number;
  /** The id that this search mints for the result (a ULID), unique over the wiki; `getFact` takes it. */
  ref: string;
}

/** What `recordSearch` stores for one consumer `search` call. */
export interface SearchLogInput {
  /** The search id, a ULID. */
  id: string;
  /** The MCP session of the call; null for a call with no session. */
  sessionId: string | null;
  query: string;
  /** The time of the call, in ms since the epoch. */
  at: number;
  /** The duration of the search, in ms. */
  durationMs: number;
  /** The results, best first; may be empty. */
  results: SearchLogResult[];
}

/**
 * Writes the `searches` row of a search call and one `search_results` row per result.
 *
 * @param store - the open store with the write connection
 * @param input - the search and its results
 * @throws {Error} when the id exists, when a `ref` exists, or when `sessionId` names no session; nothing is written then
 * @sideEffects one transaction on the store; `result_count` is the length of `results`
 */
export function recordSearch(store: Store, input: SearchLogInput): void {
  const write = store.db.transaction(() => {
    store.db
      .prepare("INSERT INTO searches(id, session_id, query, at, duration_ms, result_count) VALUES (?, ?, ?, ?, ?, ?)")
      .run(input.id, input.sessionId, input.query, input.at, input.durationMs, input.results.length);
    const insert = store.db.prepare(
      "INSERT INTO search_results(search_id, kind, target_id, rank, ref) VALUES (?, ?, ?, ?, ?)",
    );
    for (const r of input.results) insert.run(input.id, r.kind, r.targetId, r.rank, r.ref);
  });
  write.immediate();
}

/** What a `ref` names: the search that minted it and the result it stands for. */
export interface RefTarget {
  /** The id of the search that minted the ref. */
  searchId: string;
  /** What the result is: a fact. */
  kind: SearchHitKind;
  /** The fact id. */
  targetId: string;
}

/**
 * Resolves the `ref` of a search result (technical/lookup.md, "What the tools write").
 *
 * @param store - the open store
 * @param ref - the `ref` that a consumer sent to `getFact`
 * @returns the search, kind and target id that the ref names; undefined when no search minted it
 * @sideEffects none (reads `search_results`)
 */
export function resolveRef(store: Store, ref: string): RefTarget | undefined {
  const row = store.db.prepare("SELECT search_id, kind, target_id FROM search_results WHERE ref = ?").get(ref) as
    { search_id: string; kind: SearchHitKind; target_id: string } | undefined;
  return row === undefined ? undefined : { searchId: row.search_id, kind: row.kind, targetId: row.target_id };
}

/**
 * Reads the query of a logged search (technical/updates.md, "Step 9. Prior query check").
 *
 * @param store - the open store
 * @param searchId - the id of a search
 * @returns the query text of the search; undefined when no search has this id
 * @sideEffects none (reads `searches`)
 */
export function getSearchQuery(store: Store, searchId: string): string | undefined {
  const row = store.db.prepare("SELECT query FROM searches WHERE id = ?").get(searchId) as
    { query: string } | undefined;
  return row?.query;
}

/** The result of `searchAndLog`: the hits, and the ids that the log minted for them when it was written. */
export interface LoggedSearch<T> {
  /** The id of the logged search; absent when the log write failed. */
  searchId?: string;
  /** The hits in rank order, each with its minted `ref`; the `ref` is absent on every hit when the log write failed. */
  results: (T & { ref?: string })[];
  /** The error of a failed log write; absent when the log was written. */
  logError?: unknown;
}

/**
 * Runs a consumer search and logs it with its minted ids: the one place that mints the `searchId` and a `ref` per
 * result and writes the `searches` and `search_results` rows (technical/lookup.md, "What the tools write"). The
 * `search` tool and the harnesses that need the `searchId` of a real search call it.
 *
 * @param store - the open store with the write connection; it receives the log rows
 * @param query - the search text
 * @param opts - the read connection, the clock, the session and the failure mode
 * @param opts.readStore - the store to search on; default `store`
 * @param opts.now - the time of the search, in ms since the epoch; default now
 * @param opts.sessionId - the session of the call; default none, stored as NULL
 * @param opts.strict - true to throw when the log write fails; default false
 * @returns the hits. When the log write fails they carry no `ref` and there is no `searchId`, so that nothing points at ids that do not exist; `logError` holds the error
 * @throws {Error} when the search fails, or when `opts.strict` is set and the log write fails
 * @sideEffects runs the embedder; one transaction on `store` for the log; reads the clock when `opts.now` is absent
 */
export async function searchAndLog(
  store: Store,
  query: string,
  opts: { readStore?: Store; now?: number; sessionId?: string | null; strict?: boolean } = {},
): Promise<LoggedSearch<SearchResult>> {
  const at = opts.now ?? Date.now();
  const t0 = performance.now();
  const hits = await search(opts.readStore ?? store, query);
  const durationMs = Math.round(performance.now() - t0);
  const searchId = newId();
  const minted = hits.map((h) => ({ ...h, ref: newId() }));
  try {
    recordSearch(store, {
      id: searchId,
      sessionId: opts.sessionId ?? null,
      query,
      at,
      durationMs,
      results: minted.map((h, i) => ({ kind: h.kind, targetId: h.id, rank: i + 1, ref: h.ref })),
    });
  } catch (e) {
    if (opts.strict === true) throw e;
    return { results: hits, logError: e };
  }
  return { searchId, results: minted };
}
