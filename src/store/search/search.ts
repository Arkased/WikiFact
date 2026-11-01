import { embed } from "../../embed/index.js";
import type { AgentSearchResult, SearchResult, Store } from "../types/index.js";
import { boost } from "./boost.js";
import { factCandidates, ftsQuery, queryTokens, type SearchQuery } from "./candidates.js";
import { applyRelevanceFloor, fuseFacts } from "./fuse.js";
import { hydrate } from "./hydrate.js";

/** The options of `search`. */
export interface SearchOptions {
  /** The clock, in ms since the epoch. Default: now. */
  now?: number;
  /** True for the agent form. Default false. */
  includeHistory?: boolean;
}

// technical/lookup.md, "Retrieval pipeline", step 1. Embeds the query and escapes it for FTS5.
async function prepareQuery(query: string): Promise<SearchQuery> {
  const [vector] = await embed([query]);
  if (!vector) throw new Error("search: the embedder returned no vector for the query");
  return {
    vector,
    blob: Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength),
    match: ftsQuery(query),
    terms: queryTokens(query).length,
  };
}

/**
 * The retrieval pipeline of technical/lookup.md, "Retrieval pipeline", consumer form: live current versions, at most
 * `store.config.searchCap` results, facts only. Records no retrieval.
 *
 * @param store - the open store
 * @param query - the free text to search; the caller keeps it inside the embedder window (512 tokens)
 * @param opts - the clock; `includeHistory` false or absent
 * @param opts.now - the clock, in ms since the epoch; default now
 * @param opts.includeHistory - true for the agent form
 * @returns the hits, best first; empty when nothing matches
 * @throws {Error} when the embedder returns no vector for the query
 * @sideEffects reads the database; the embedder runs for the query; reads the clock when `opts.now` is absent
 */
export async function search(
  store: Store,
  query: string,
  opts?: { now?: number; includeHistory?: false },
): Promise<SearchResult[]>;
/**
 * The retrieval pipeline of technical/lookup.md, "Retrieval pipeline", agent form (`includeHistory: true`): every version, at most
 * `store.config.agentSearchCap` results, one entry per fact, naming the version that matched best.
 * Records no retrieval.
 *
 * @param store - the open store
 * @param query - the free text to search; the caller keeps it inside the embedder window (512 tokens)
 * @param opts - the clock; `includeHistory: true`
 * @param opts.now - the clock, in ms since the epoch; default now
 * @param opts.includeHistory - true for the agent form
 * @returns the hits, best first; empty when nothing matches
 * @throws {Error} when the embedder returns no vector for the query
 * @sideEffects reads the database; the embedder runs for the query; reads the clock when `opts.now` is absent
 */
export async function search(
  store: Store,
  query: string,
  opts: { now?: number; includeHistory: true },
): Promise<AgentSearchResult[]>;
/**
 * The implementation of both forms; the overloads above are the public signatures.
 *
 * @param store - the open store
 * @param query - the query text
 * @param opts - the clock (ms, default now) and the form (`includeHistory`, default false)
 * @returns the hits of the form `opts.includeHistory` selects, best first; empty when nothing matches
 * @throws {Error} when the embedder returns no vector for the query
 * @sideEffects reads the database; the embedder runs for the query; reads the clock when `opts.now` is absent
 */
export async function search(
  store: Store,
  query: string,
  opts: SearchOptions = {},
): Promise<SearchResult[] | AgentSearchResult[]> {
  const now = opts.now ?? Date.now();
  const history = opts.includeHistory === true;
  const cap = history ? store.config.agentSearchCap : store.config.searchCap;

  const q = await prepareQuery(query);
  const fusedFacts = fuseFacts(factCandidates(store.db, q, history));
  // The agent form keeps the near misses, which the update pipeline needs for Q1 and Q4 (technical/updates.md, "Store API reads for the update agent").
  const facts = history
    ? fusedFacts
    : applyRelevanceFloor(fusedFacts, { floor: store.config.relevanceFloor, queryTerms: q.terms });

  const scored = boost(store, facts, now);
  scored.sort((a, b) => b.score - a.score);
  const results = hydrate(store, scored.slice(0, cap), history, now);
  // `hydrate` shapes every fact hit by `history`, so the array holds one result type only.
  return results;
}
