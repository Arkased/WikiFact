// The duplicates left among the live facts after a path (technical/updates.md, "High volume mode", "The test of both paths").
import { cosineDistance } from "../../src/embed/index.js";
import { errorMessage } from "../../src/must.js";
import { listCurrentFacts, versionText, type Store } from "../../src/store/index.js";
import type { Questions } from "../../src/updates/index.js";
import { pool } from "../lib/pool.js";
import { embedAll } from "../lib/vectors.js";
import type { DuplicatePair, DuplicateReport, TokenCounts } from "./types.js";

/** The nearest live facts of a fact that go to Q1: the method of the duplicate fact finder. */
const NEIGHBORS_PER_FACT = 3;

/** The Q1 calls in flight. */
const JUDGE_CONCURRENCY = 4;

/** The options of `findDuplicates`. */
export interface DuplicateOptions {
  /** The open copy after a path. */
  store: Store;
  /** Q1 runs here; no store, so the judging writes no `model_calls` row. */
  questions: Questions;
  subject: string;
  /** Facts whose current version has a `seq` above this were written in the run and are checked. */
  sinceSeq: number;
  /** The cosine distance under which a neighbor goes to Q1 (the batch `neighborDistance`). */
  distance: number;
}

const addTokens = (t: TokenCounts, u: { input: number; output: number; cacheRead?: number; cacheWrite?: number }) => {
  t.input += u.input;
  t.output += u.output;
  t.cacheRead += u.cacheRead ?? 0;
  t.cacheWrite += u.cacheWrite ?? 0;
};

/**
 * Finds the duplicate pairs among the live facts. For each live fact written in the run it takes the nearest live facts
 * under the distance, up to `NEIGHBORS_PER_FACT`, and asks Q1 whether any of them has the scope of the fact; each neighbor
 * that Q1 returns makes a pair (a pair found from both sides counts once). A rate limit stops the judging and keeps the
 * pairs found so far.
 *
 * @param opts - the copy, the questions, the subject, the position of the start and the distance
 * @returns the report; `complete` is false when a failure stopped the judging
 * @sideEffects reads the copy; runs the embedder; one Q1 call per fact with a neighbor
 */
export async function findDuplicates(opts: DuplicateOptions): Promise<DuplicateReport> {
  const live = listCurrentFacts(opts.store).filter((f) => f.is_deleted === 0);
  const texts = live.map((f) => versionText(f.header, f.content));
  const vecs = await embedAll(texts);
  const written = live.flatMap((f, i) => (f.seq > opts.sinceSeq ? [i] : []));
  const pairKeys = new Set<string>();
  const proposals = written.map((i) => {
    const vi = vecs[i];
    const near = live
      .flatMap((g, j) => {
        const vj = vecs[j];
        if (j === i || !vi || !vj) return [];
        const distance = cosineDistance(vi, vj);
        return distance < opts.distance ? [{ j, distance }] : [];
      })
      .sort((a, b) => a.distance - b.distance)
      .slice(0, NEIGHBORS_PER_FACT);
    for (const n of near) pairKeys.add([i, n.j].sort((a, b) => a - b).join(":"));
    return { i, near };
  });
  const judge: DuplicateReport["judge"] = { calls: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const found = new Map<string, DuplicatePair>();
  let error: string | undefined;
  await pool(
    JUDGE_CONCURRENCY,
    proposals
      .filter((p) => p.near.length > 0)
      .map((p) => async () => {
        if (error !== undefined) return;
        const fact = live[p.i];
        if (!fact) return;
        try {
          judge.calls++;
          const answer = await opts.questions.q1(
            {
              change: texts[p.i] ?? "",
              candidates: p.near.flatMap((n) => {
                const g = live[n.j];
                return g ? [{ factId: g.fact_id, header: g.header }] : [];
              }),
            },
            { subject: opts.subject },
          );
          for (const n of p.near) {
            const g = live[n.j];
            if (!g || !answer.matches.includes(g.fact_id)) continue;
            const key = [fact.fact_id, g.fact_id].sort().join(":");
            if (!found.has(key))
              found.set(key, {
                a: { factId: fact.fact_id, header: fact.header, content: fact.content },
                b: { factId: g.fact_id, header: g.header, content: g.content },
                distance: n.distance,
              });
          }
        } catch (e) {
          // A failed call (a rate limit included) stops the judging and the file says why; the harness does not wait it out.
          error ??= errorMessage(e);
        }
      }),
  );
  const usage = opts.questions.takeUsage?.();
  if (usage) addTokens(judge.tokens, usage);
  return {
    complete: error === undefined,
    checkedFacts: written.length,
    candidatePairs: pairKeys.size,
    pairs: [...found.values()],
    judge,
    ...(error === undefined ? {} : { error }),
  };
}
