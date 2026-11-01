// The facts that differ between the two copies (technical/updates.md, "High volume mode", "The test of both paths").
import { getRequest, listCurrentFacts, type Store } from "../../src/store/index.js";
import { outcomeOf } from "./measure.js";
import type { FactDifferences, FactText, PathResult } from "./types.js";

/** The characters of a request's change text that the result file keeps. */
const CHANGE_CHARS = 160;

// The live facts whose current version was written above the position, by lower case header.
function writtenFacts(store: Store, sinceSeq: number): Map<string, FactText> {
  const out = new Map<string, FactText>();
  for (const f of listCurrentFacts(store)) {
    if (f.is_deleted === 0 && f.seq > sinceSeq)
      out.set(f.header.trim().toLowerCase(), { header: f.header, content: f.content });
  }
  return out;
}

const norm = (s: string): string => s.trim().replace(/\s+/g, " ").toLowerCase();

/** The options of `compareCopies`. */
export interface CompareOptions {
  /** The sequential copy. */
  sequentialStore: Store;
  /** The batch copy. */
  batchStore: Store;
  /** The highest `seq` before the run; the same in both copies. */
  sinceSeq: number;
  sequential: PathResult;
  batch: PathResult;
}

/**
 * Compares the two copies after the run: the requests whose outcomes differ, and the facts written in the run that only
 * one copy holds, matched by header.
 *
 * @param o - the two copies, the position of the start and the results of the two paths
 * @returns the differences
 * @sideEffects none (reads)
 */
export function compareCopies(o: CompareOptions): FactDifferences {
  const { sequentialStore: a, batchStore: b, sinceSeq } = o;
  const outcomes: FactDifferences["outcomes"] = [];
  const batchById = new Map(o.batch.requests.map((r) => [r.requestId, r]));
  for (const s of o.sequential.requests) {
    const other = batchById.get(s.requestId);
    if (!other) continue;
    const x = outcomeOf(s);
    const y = outcomeOf(other);
    if (x !== y)
      outcomes.push({
        requestId: s.requestId,
        change: (getRequest(a, s.requestId)?.change ?? "").slice(0, CHANGE_CHARS),
        sequential: x,
        batch: y,
      });
  }
  const fa = writtenFacts(a, sinceSeq);
  const fb = writtenFacts(b, sinceSeq);
  const onlySequential: FactText[] = [];
  const onlyBatch: FactText[] = [];
  let sameHeader = 0;
  let sameContent = 0;
  for (const [key, f] of fa) {
    const g = fb.get(key);
    if (!g) onlySequential.push(f);
    else {
      sameHeader++;
      if (norm(f.content) === norm(g.content)) sameContent++;
    }
  }
  for (const [key, g] of fb) if (!fa.has(key)) onlyBatch.push(g);
  return { outcomes, onlySequential, onlyBatch, sameHeader, sameContent };
}
