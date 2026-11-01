import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ChangeOutcome } from "../../src/domain/index.js";
import { EMBEDDING_MODEL } from "../../src/embed/index.js";
import {
  closeStore,
  getFact,
  openStore,
  recordRetrieval,
  search,
  seedChange,
  type SearchResult,
  type Store,
} from "../../src/store/index.js";
import { RelevanceQueryForm } from "../lib/enums.js";
import { resultStamp } from "../lib/stamp.js";
import { required } from "../lib/required-value.js";
import { EVAL_DIR, loadReplay } from "../replay/load.js";
import { seedReplayStore } from "../replay/seed.js";
import { loadRelevance, type RelevanceCase, type RelevanceFile } from "./cases.js";
import { JSON_INDENT } from "../../src/constants.js";

/** The rank (1 is best) that every answerable query must reach at the least. */
const MAX_RANK = 3;

/** The share of the answerable `terms` queries that must have the expected fact at rank 1. */
const RANK_ONE_SHARE = 0.9;

/** The share of the unanswerable queries that must return an empty list or only labeled close neighbors. */
export const NO_ANSWER_SHARE = 0.8;

/** How many headers a case row lists. */
const TOP = 3;

/** The result of one case. */
export interface RelevanceCaseResult {
  id: string;
  query: string;
  /** The form of the query: `terms` is the designed form, `question` the tolerance group. */
  form: RelevanceCase["form"];
  /** The header the case expects; absent for an unanswerable query. */
  expectHeader?: string;
  /** The 1-based place of the expected header in the result list; null when it is absent. */
  rank: number | null;
  /** The headers of the first results. */
  top3: string[];
  /** The number of results. */
  count: number;
  pass: boolean;
  note: string;
}

/** The summary of a run. */
export interface RelevanceReport {
  results: RelevanceCaseResult[];
  /** The answerable `terms` queries, the ones with the expected fact in the top 3, and the ones with it at rank 1. */
  answerable: { total: number; top3: number; rank1: number };
  /** The answerable `question` queries (rank 1 not required), and the ones with the expected fact in the top 3. */
  tolerance: { total: number; top3: number };
  /** The unanswerable queries, the ones with an empty list or only allowed neighbors, and the ids of the others. */
  unanswerable: { total: number; ok: number; failedIds: string[] };
  pass: boolean;
}

/** The results file of a run. */
interface RelevanceResultFile extends RelevanceReport {
  startedAt: string;
  finishedAt: string;
  embedder: string;
  relevanceFloor: number;
  readFacts: string[];
}

/**
 * Names the results file of a run that has no `--out`.
 *
 * @returns `eval/relevance-results/<stamp>.json` under the project
 * @sideEffects reads the clock
 */
export function defaultRelevanceOut(): string {
  return join(EVAL_DIR, "relevance-results", `${resultStamp()}.json`);
}

// The label of a hit: the header of its fact.
const label = (h: SearchResult): string[] => [h.header];

/**
 * Judges one case from its search results.
 *
 * @param c - the case
 * @param hits - the results of `search` for its query
 * @returns the rank, the first headers and whether the case passes on its own: a fact case at rank 3 or better, an unanswerable case with an empty list or
 *   only results whose header is in `allowNear`
 * @sideEffects none
 */
export function judgeCase(c: RelevanceCase, hits: SearchResult[]): RelevanceCaseResult {
  const labels = hits.flatMap(label);
  const at = c.expectHeader !== undefined ? labels.indexOf(c.expectHeader) : -1;
  const rank = at < 0 ? null : at + 1;
  const pass =
    c.expectHeader !== undefined
      ? rank !== null && rank <= MAX_RANK
      : labels.every((l) => c.allowNear?.includes(l) === true);
  return {
    id: c.id,
    query: c.query,
    form: c.form,
    ...(c.expectHeader === undefined ? {} : { expectHeader: c.expectHeader }),
    rank,
    top3: labels.slice(0, TOP),
    count: hits.length,
    pass,
    note: c.note,
  };
}

/**
 * Applies the pass condition of technical/lookup.md, "Tests" to the case results.
 *
 * @param results - one result per case
 * @returns the counts and the verdict: every answerable query in the top 3, at least `RANK_ONE_SHARE` of the `terms`
 *   ones at rank 1 (the `question` ones need no rank 1), at least `NO_ANSWER_SHARE` of the unanswerable
 *   queries empty or with allowed neighbors only
 * @sideEffects none
 */
export function summarize(results: RelevanceCaseResult[]): RelevanceReport {
  const withHeader = results.filter((r) => r.expectHeader !== undefined);
  const answerable = withHeader.filter((r) => r.form === RelevanceQueryForm.Terms);
  const tolerance = withHeader.filter((r) => r.form === RelevanceQueryForm.Question);
  const unanswerable = results.filter((r) => r.expectHeader === undefined);
  const counts = {
    answerable: {
      total: answerable.length,
      top3: answerable.filter((r) => r.pass).length,
      rank1: answerable.filter((r) => r.rank === 1).length,
    },
    tolerance: { total: tolerance.length, top3: tolerance.filter((r) => r.pass).length },
    unanswerable: {
      total: unanswerable.length,
      ok: unanswerable.filter((r) => r.pass).length,
      failedIds: unanswerable.filter((r) => !r.pass).map((r) => r.id),
    },
  };
  const pass =
    counts.answerable.top3 === counts.answerable.total &&
    counts.answerable.rank1 >= RANK_ONE_SHARE * counts.answerable.total &&
    counts.tolerance.top3 === counts.tolerance.total &&
    counts.unanswerable.ok >= NO_ANSWER_SHARE * counts.unanswerable.total;
  return { results, ...counts, pass };
}

// Seeds the replay wiki, then the extra facts of relevance.json. Returns the fact id of each extra header.
async function seedStore(store: Store, file: RelevanceFile): Promise<Map<string, string>> {
  await seedReplayStore(store, loadReplay());
  const res = await seedChange(store, {
    outcome: ChangeOutcome.Accepted,
    summary: "relevance seed",
    changeReasoning: "relevance seed",
    facts: file.facts.map((f) => ({
      header: f.header,
      content: f.content,
      justification: "seed",
      references: [],
    })),
  });
  return new Map(file.facts.map((f, i) => [f.header, required(res.factIds[i], `no fact id for ${f.header}`)]));
}

/**
 * Seeds a store, records a read on the `reads` facts the way the MCP `getFact` does, and runs every query.
 *
 * @param file - `relevance.json`
 * @param floor - the relevance floor of the store; default the store default
 * @returns the report and the headers that were read
 * @sideEffects opens and closes an in-memory store; the embedder runs for the seed and for every query
 */
async function runRelevance(
  file: RelevanceFile,
  floor?: number,
): Promise<{ report: RelevanceReport; relevanceFloor: number }> {
  const store = openStore(":memory:", { embeddingModel: EMBEDDING_MODEL, relevanceFloor: floor });
  try {
    const ids = await seedStore(store, file);
    // The consumer path: `getFact` reads, then the server records the retrieval.
    for (const header of file.reads) {
      const id = required(ids.get(header), `no fact for the read of ${header}`);
      if (getFact(store, id) !== null) recordRetrieval(store, id);
    }
    const results: RelevanceCaseResult[] = [];
    for (const c of file.cases) results.push(judgeCase(c, await search(store, c.query)));
    return { report: summarize(results), relevanceFloor: store.config.relevanceFloor };
  } finally {
    closeStore(store);
  }
}

/** The widths of the columns of the case table, in characters. */
const FORM_WIDTH = 8;
const EXPECT_WIDTH = 7;
const COUNT_WIDTH = 2;

/**
 * Prints the table of a report: one row per case.
 *
 * @param report - the report
 * @param log - receives each line
 * @sideEffects calls `log`
 */
function printRelevance(report: RelevanceReport, log: (line: string) => void): void {
  for (const r of report.results) {
    const want = r.expectHeader === undefined ? "none" : `rank ${r.rank ?? "-"}`;
    log(
      `${r.pass ? "ok  " : "FAIL"} ${r.id} ${r.form.padEnd(FORM_WIDTH)} ${want.padEnd(EXPECT_WIDTH)} ${String(r.count).padStart(COUNT_WIDTH)} hits  "${r.query}"`,
    );
    log(`       top 3: ${r.top3.join(" | ") || "(empty)"}`);
  }
  const { answerable: a, tolerance: t, unanswerable: u } = report;
  log(`terms: ${a.top3}/${a.total} in the top ${MAX_RANK}, ${a.rank1}/${a.total} at rank 1`);
  log(`question (tolerance): ${t.top3}/${t.total} in the top ${MAX_RANK}`);
  const failed = u.failedIds.length === 0 ? "" : `, failed: ${u.failedIds.join(", ")}`;
  log(`unanswerable: ${u.ok}/${u.total} empty or allowed neighbors only${failed}`);
  log(report.pass ? "relevance: PASS" : "relevance: FAIL");
}

/**
 * Runs the relevance test and writes the results file.
 *
 * @param outPath - the results file; its folder is made when it is missing
 * @param log - receives each line of output
 * @returns the report
 * @sideEffects see `runRelevance`; writes `outPath`; reads the clock
 */
export async function runRelevanceToFile(outPath: string, log: (line: string) => void): Promise<RelevanceReport> {
  const file = loadRelevance();
  const startedAt = new Date().toISOString();
  const { report, relevanceFloor } = await runRelevance(file);
  const out: RelevanceResultFile = {
    startedAt,
    finishedAt: new Date().toISOString(),
    embedder: EMBEDDING_MODEL,
    relevanceFloor,
    readFacts: file.reads,
    ...report,
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(out, null, JSON_INDENT) + "\n");
  printRelevance(report, log);
  log(`results written to ${outPath}`);
  return report;
}
