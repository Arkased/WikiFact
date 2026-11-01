import { SearchHitKind } from "../../domain/enums.js";
import { confidences } from "../scores.js";
import { inList } from "../sql.js";
import type { AgentSearchResult, SearchResult, Store } from "../types/index.js";
import type { Scored } from "./boost.js";

interface VersionRow {
  id: number;
  fact_id: string;
  seq: number;
  header: string;
  is_deleted: number;
}

// technical/lookup.md, "Retrieval pipeline", step 9. Loads the version row of each fact hit: the matched version in agent form,
// the current version in consumer form.
function loadVersions(store: Store, facts: Scored[], history: boolean): Map<string, VersionRow> {
  const out = new Map<string, VersionRow>();
  if (facts.length === 0) return out;
  const { db } = store;
  let rows: VersionRow[];
  if (history) {
    const ids = facts.flatMap((f) => (f.versionId === undefined ? [] : [f.versionId]));
    rows = db
      .prepare(`SELECT id, fact_id, seq, header, is_deleted FROM fact_versions WHERE id IN (${inList(ids.length)})`)
      .all(...ids) as VersionRow[];
  } else {
    const ids = facts.map((f) => f.factId);
    rows = db
      .prepare(
        `SELECT id, fact_id, seq, header, is_deleted FROM current_fact_versions WHERE fact_id IN (${inList(ids.length)})`,
      )
      .all(...ids) as VersionRow[];
  }
  for (const r of rows) out.set(r.fact_id, r);
  return out;
}

/**
 * technical/lookup.md, "Retrieval pipeline", step 8. Turns the cut hits into results: loads the headers and the confidence of the facts.
 * A fact hit whose version row is missing is dropped.
 *
 * @param store - the open store
 * @param top - the hits after the sort and the cut, best first
 * @param history - true for the agent form
 * @param now - the clock, in ms since the epoch
 * @returns the results in the order of `top`
 * @sideEffects none (reads)
 */
export function hydrate(
  store: Store,
  top: Scored[],
  history: boolean,
  now: number,
): (SearchResult | AgentSearchResult)[] {
  const conf = confidences(
    store,
    top.map((f) => f.factId),
    now,
  );
  const versionByFact = loadVersions(store, top, history);

  const out: (SearchResult | AgentSearchResult)[] = [];
  for (const s of top) {
    const v = versionByFact.get(s.factId);
    if (!v) continue;
    const confidence = conf.get(s.factId) ?? 0;
    if (history) {
      out.push({
        kind: SearchHitKind.Fact,
        id: s.factId,
        factId: s.factId,
        factVersionId: v.id,
        seq: v.seq,
        isDeleted: v.is_deleted === 1,
        header: v.header,
        confidence,
        score: s.score,
      });
    } else {
      out.push({ kind: SearchHitKind.Fact, id: s.factId, header: v.header, confidence, score: s.score });
    }
  }
  return out;
}
