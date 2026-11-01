// The score of a path against the labels of `fakes/bulk-expected.ts` (technical/updates.md, "The candidate architectures of
// the bulk test", "The score against the labels").
import { ChangeOutcome, RejectReason } from "../../src/domain/index.js";
import { firstSeqOfFacts, getRequest, listCurrentFacts, type Store } from "../../src/store/index.js";
import {
  BULK_END_STATE,
  BULK_LABELS,
  MAY_SPLIT_EXTRA_FACTS,
  type BulkLabel,
  type ClaimLabel,
  type DuplicateTarget,
} from "../../fakes/bulk-expected.js";
import { BULK_SUBMISSIONS } from "../../fakes/bulk-submissions.js";
import { ExpectedOutcome } from "../lib/enums.js";
import type { DuplicateReport, EndScore, EndStateCheck, PathResult, PathScore, RequestRecord } from "./types.js";

/** The end of a request with no change. */
const NO_END = "none";

/** What the score reads of the copy after the path. */
export interface ScoreInput {
  /** The sampled requests, in queue order: the request at index `i` is the submission at position `i`. */
  requests: RequestRecord[];
  /** The live facts: the id and the `seq` of the current version. */
  live: { factId: string; seq: number }[];
  /** The `seq` of the first version of each fact. */
  firstSeq: Map<string, number>;
  /** The highest `seq` before the run. */
  startSeq: number;
  /** The duplicates judged among the live facts; absent: the check is not scored. */
  duplicates?: DuplicateReport;
}

// The text of the end of a request: the outcome, with the reason of a rejection.
function endName(r: RequestRecord): string {
  if (r.outcome === undefined) return NO_END;
  return r.outcome === ChangeOutcome.Rejected && r.rejectReason !== undefined
    ? `${r.outcome} ${r.rejectReason}`
    : r.outcome;
}

// The ends of the labels that a rejection with this reason is.
function rejectedEnds(reason: RejectReason | undefined): ExpectedOutcome[] {
  switch (reason) {
    case RejectReason.Unsupported:
      return [ExpectedOutcome.RejectedUnsupported];
    case RejectReason.Contradicted:
      return [ExpectedOutcome.RejectedContradicted, ExpectedOutcome.LosesInReconciliation];
    case RejectReason.Compound:
      return [ExpectedOutcome.RejectedCompound];
    case undefined:
      return [];
  }
}

// The ends of the labels that a request's end is: an accepted request that wrote a new version of a fact from before the
// run is a correction, any other is a new fact.
function endsOf(r: RequestRecord, correction: boolean): ExpectedOutcome[] {
  switch (r.outcome) {
    case ChangeOutcome.Accepted:
      return [correction ? ExpectedOutcome.CorrectionAccepted : ExpectedOutcome.AcceptedNew];
    case ChangeOutcome.Duplicate:
      return [ExpectedOutcome.DuplicateOfSeed, ExpectedOutcome.DuplicateOfEarlier, ExpectedOutcome.MergedWith];
    case ChangeOutcome.Split:
      return [ExpectedOutcome.Split];
    case ChangeOutcome.Rejected:
      return rejectedEnds(r.rejectReason);
    case undefined:
      return [];
  }
}

// The end of a child against the label of its claim: only the outcome counts.
function claimIsRight(child: RequestRecord | undefined, claim: ClaimLabel): boolean {
  return child?.outcome === claim.outcome;
}

// The position that a label says its end duplicates, when the target is a submission.
function duplicateAt(target: DuplicateTarget | undefined): number | undefined {
  return target !== undefined && "position" in target ? target.position : undefined;
}

// An end with its record (absent for a missing child) and, when its label says "duplicate of position q", that q.
interface ScoredEnd {
  score: EndScore;
  record: RequestRecord | undefined;
  /** True when the end is an accepted new fact (not a correction). */
  isNew: boolean;
  duplicateOf: number | undefined;
}

// An equal pair in the other order (technical/updates.md, "An equal pair in either order"): the end labelled "duplicate of
// position q" ends as a new fact, and the request q ends as a duplicate of a fact that this end wrote. Each end is right
// only when the other has its matching outcome.
function takeOtherOrder(ends: ScoredEnd[], requestAt: Map<number, ScoredEnd>): void {
  for (const e of ends) {
    if (e.duplicateOf === undefined || !e.isNew || !e.record) continue;
    const target = requestAt.get(e.duplicateOf);
    const label = BULK_LABELS[e.duplicateOf];
    if (!target || label?.outcome !== ChangeOutcome.Accepted || label.replaces !== undefined) continue;
    const of = target.record?.duplicateOf;
    if (target.record?.outcome !== ChangeOutcome.Duplicate || of === undefined || !e.record.factIds.includes(of)) {
      continue;
    }
    e.score.right = true;
    target.score.right = true;
  }
}

// The ends of the requests and of the children of a split. `isCorrection` says whether an accepted request wrote a version
// of a fact from before the run.
function scoreEnds(
  requests: RequestRecord[],
  isCorrection: (r: RequestRecord, position: number) => boolean,
): EndScore[] {
  const out: ScoredEnd[] = [];
  const requestAt = new Map<number, ScoredEnd>();
  for (const [position, r] of requests.entries()) {
    const submission = BULK_SUBMISSIONS[position];
    const label = BULK_LABELS[position];
    if (!submission || !label) continue;
    const correction = isCorrection(r, position);
    const end: ScoredEnd = {
      score: {
        position,
        end: endName(r),
        accepted: submission.expected,
        right: endsOf(r, correction).some((e) => submission.expected.includes(e)),
        unclear: label.unclear !== undefined,
        correction: r.outcome === ChangeOutcome.Accepted && correction,
      },
      record: r,
      isNew: r.outcome === ChangeOutcome.Accepted && !correction,
      duplicateOf: duplicateAt(label.duplicateOf),
    };
    out.push(end);
    requestAt.set(position, end);
    if (r.outcome !== ChangeOutcome.Split || !label.claims) continue;
    // A child is scored by its place among the children; a missing child and a surplus child are wrong ends.
    const count = Math.max(label.claims.length, r.children.length);
    for (let i = 0; i < count; i++) {
      const claim = label.claims[i];
      const child = r.children[i];
      out.push({
        score: {
          position,
          claim: i + 1,
          end: child ? endName(child) : NO_END,
          accepted: claim ? [claim.outcome] : [],
          right: claim !== undefined && claimIsRight(child, claim),
          unclear: claim?.unclear !== undefined,
          correction: false,
        },
        record: child,
        // The claim labels hold no correction, so a child that is accepted is a new fact.
        isNew: child?.outcome === ChangeOutcome.Accepted,
        duplicateOf: duplicateAt(claim?.duplicateOf),
      });
    }
  }
  takeOtherOrder(out, requestAt);
  return out.map((e) => e.score);
}

// The new facts that a label expects, as a minimum and a maximum.
function expectedNew(label: BulkLabel): { min: number; max: number } {
  if (label.outcome === ChangeOutcome.Accepted && label.replaces === undefined) {
    return { min: 1, max: 1 + (MAY_SPLIT_EXTRA_FACTS[label.position] ?? 0) };
  }
  const claims = (label.claims ?? []).filter((c) => c.outcome === ChangeOutcome.Accepted).length;
  const extra = label.claims === undefined ? 0 : (MAY_SPLIT_EXTRA_FACTS[label.position] ?? 0);
  return { min: claims, max: claims + extra };
}

/** The positions that the line names before it says `and N more`; the whole list is in `ends` and `endState`. */
const LINE_POSITIONS = 8;

// The first positions of a list for the line.
const listOf = (items: string[]): string =>
  items.length <= LINE_POSITIONS
    ? items.join(", ")
    : `${items.slice(0, LINE_POSITIONS).join(", ")} and ${items.length - LINE_POSITIONS} more`;

const rangeText = (min: number, max: number): string => (min === max ? String(min) : `${min} to ${max}`);

// The checks of the end state: counts against the labels of the sampled positions, with the positions that fail.
function checkEndState(input: ScoreInput, isOld: (factId: string) => boolean): EndStateCheck[] {
  const liveIds = new Set(input.live.map((f) => f.factId));
  const changedLive = new Set(input.live.filter((f) => f.seq > input.startSeq).map((f) => f.factId));
  const labels = BULK_LABELS.slice(0, input.requests.length);
  const positionOfFact = new Map<string, number>();
  const newOf = (r: RequestRecord): number => {
    const ids = [...r.factIds, ...r.children.flatMap((c) => c.factIds)];
    return ids.filter((id) => liveIds.has(id) && !isOld(id)).length;
  };
  const correctedOf = (r: RequestRecord): number =>
    [...r.factIds, ...r.children.flatMap((c) => c.factIds)].filter(
      (id) => liveIds.has(id) && isOld(id) && changedLive.has(id),
    ).length;
  for (const [position, r] of input.requests.entries()) {
    for (const id of [...r.factIds, ...r.children.flatMap((c) => c.factIds)]) positionOfFact.set(id, position);
  }

  // New facts.
  let newMin = 0;
  let newMax = 0;
  let newActual = 0;
  const newBad: number[] = [];
  for (const [position, r] of input.requests.entries()) {
    const label = labels[position];
    if (!label) continue;
    const e = expectedNew(label);
    const n = newOf(r);
    newMin += e.min;
    newMax += e.max;
    newActual += n;
    if (n < e.min || n > e.max) newBad.push(position);
  }
  // Facts from before the run that changed in the run, by position: the corrections.
  let correctedExpected = 0;
  let correctedActual = 0;
  const correctedBad: number[] = [];
  for (const [position, r] of input.requests.entries()) {
    const label = labels[position];
    if (!label) continue;
    const want = label.replaces === undefined ? 0 : 1;
    const got = correctedOf(r);
    correctedExpected += want;
    correctedActual += got;
    if (got !== want) correctedBad.push(position);
  }
  // Conflict groups: a member that wrote a live fact without the value to keep holds the false value.
  const falseAt: number[] = [];
  for (const [position, r] of input.requests.entries()) {
    const keeps = labels[position]?.keeps;
    if (keeps === undefined) continue;
    if (r.facts.some((f) => !f.content.toLowerCase().includes(keeps.toLowerCase()))) falseAt.push(position);
  }
  // Pairs of live facts in one scope, from the judging of the duplicate fact finder.
  const pairs = input.duplicates?.pairs ?? [];
  const pairBad = new Set<number>();
  for (const p of pairs) {
    for (const x of [p.a.factId, p.b.factId]) {
      const at = positionOfFact.get(x);
      if (at !== undefined) pairBad.add(at);
    }
  }
  const judged = input.duplicates?.complete === true;
  // Compound live facts: a compound submission that was written as one fact instead of being split.
  const compoundAt: number[] = [];
  for (const [position, r] of input.requests.entries()) {
    if (labels[position]?.outcome === ChangeOutcome.Split && r.outcome === ChangeOutcome.Accepted && newOf(r) > 0) {
      compoundAt.push(position);
    }
  }
  const sorted = (xs: Iterable<number>): number[] => [...new Set(xs)].sort((a, b) => a - b);
  return [
    {
      name: "new facts",
      expected: rangeText(newMin, newMax),
      actual: String(newActual),
      ok: newActual >= newMin && newActual <= newMax && newBad.length === 0,
      positions: newBad,
    },
    {
      name: "corrected seed facts",
      expected: String(correctedExpected),
      actual: String(correctedActual),
      ok: correctedBad.length === 0,
      positions: correctedBad,
    },
    {
      name: "false value in a conflict group",
      expected: "0",
      actual: String(falseAt.length),
      ok: falseAt.length === 0,
      positions: falseAt,
    },
    {
      name: "duplicate pairs",
      expected: String(BULK_END_STATE.duplicatePairs),
      actual: input.duplicates === undefined ? "not judged" : `${pairs.length}${judged ? "" : " (judging incomplete)"}`,
      ok: judged && pairs.length === BULK_END_STATE.duplicatePairs,
      positions: sorted(pairBad),
    },
    {
      name: "compound facts",
      expected: String(BULK_END_STATE.compoundFacts),
      actual: String(compoundAt.length),
      ok: compoundAt.length === BULK_END_STATE.compoundFacts,
      positions: compoundAt,
    },
  ];
}

// The score of a path from its ends and the checks of its end state: the counts and the line.
function buildScore(ends: EndScore[], endState: EndStateCheck[], path: string): PathScore {
  const count = (right: boolean, unclear: boolean): number =>
    ends.filter((e) => e.right === right && e.unclear === unclear).length;
  const failed = endState.filter((c) => !c.ok);
  const parts = failed.map(
    (c) =>
      `${c.name} ${c.actual} (expected ${c.expected})${c.positions.length > 0 ? ` at ${listOf(c.positions.map(String))}` : ""}`,
  );
  const wrongAt = ends
    .filter((e) => !e.right && !e.unclear)
    .map((e) => (e.claim ? `${e.position}.${e.claim}` : `${e.position}`));
  const unclearRight = count(true, true);
  const unclearWrong = count(false, true);
  const line =
    `${path}: ${count(true, false)} right, ${count(false, false)} wrong` +
    (wrongAt.length > 0 ? ` (at ${listOf(wrongAt)})` : "") +
    `; unclear ${unclearRight} right, ${unclearWrong} wrong; ` +
    (parts.length === 0 ? "end state ok" : `failed: ${parts.join("; ")}`);
  return {
    right: count(true, false),
    wrong: count(false, false),
    unclear: { right: unclearRight, wrong: unclearWrong },
    ends,
    endState,
    line,
  };
}

/**
 * Scores the requests and the end state of a path against the labels. The request at index `i` is the submission at
 * position `i` of the queue; a sample of fewer than 100 requests is scored against the labels of its first positions.
 *
 * @param input - the records, the live facts, the first `seq` of each fact, the start position and the duplicates
 * @param path - the name of the path, for the line
 * @returns the right and wrong ends (the unclear labels apart), each end, the checks of the end state and the line
 * @sideEffects none
 */
export function scoreRequests(input: ScoreInput, path: string): PathScore {
  const isOld = (factId: string): boolean => (input.firstSeq.get(factId) ?? Infinity) <= input.startSeq;
  return buildScore(
    scoreEnds(input.requests, (r) => r.factIds.some(isOld)),
    checkEndState(input, isOld),
    path,
  );
}

// The key of an end in a score: the position, with the claim of a child.
const endKey = (e: { position: number; claim?: number | undefined }): string =>
  e.claim === undefined ? String(e.position) : `${e.position}.${e.claim}`;

// The keys of the ends that make an equal pair with the request at `position`: the end its label says it duplicates, the
// requests whose labels say they duplicate it and the claims whose labels say so.
function pairKeys(position: number): string[] {
  const keys: string[] = [];
  const target = duplicateAt(BULK_LABELS[position]?.duplicateOf);
  if (target !== undefined) keys.push(String(target));
  for (const l of BULK_LABELS) {
    if (duplicateAt(l.duplicateOf) === position) keys.push(String(l.position));
    for (const [i, c] of (l.claims ?? []).entries()) {
      if (duplicateAt(c.duplicateOf) === position) keys.push(`${l.position}.${i + 1}`);
    }
  }
  return keys;
}

/**
 * Scores the request ends of a path again with the current scorer and keeps the checks of the end state of an earlier
 * score. The copy is not at hand, so whether an accepted request was a correction comes from the earlier score. Each end
 * of a score holds it (`correction`). In a file from before that field it is read from the earlier end only when the
 * label accepts a correction (it was one when the end was right) or a new fact (it was one when the end was wrong). For
 * any other accepted end the earlier verdict of that end and of its equal pair is kept, and the new end leaves
 * `correction` absent, so that a later rescore keeps the verdict again.
 *
 * @param requests - the request records of the path, in queue order
 * @param previous - the earlier score of the path; its end state is kept
 * @param path - the name of the path, for the line
 * @returns the new score
 * @sideEffects none
 */
export function rescoreRequests(requests: RequestRecord[], previous: PathScore, path: string): PathScore {
  const earlier = (position: number): EndScore | undefined =>
    previous.ends.find((e) => e.position === position && e.claim === undefined);
  const keepsVerdict = (position: number): boolean => {
    const old = earlier(position);
    return (
      old !== undefined &&
      old.correction === undefined &&
      requests[position]?.outcome === ChangeOutcome.Accepted &&
      !old.accepted.includes(ExpectedOutcome.CorrectionAccepted) &&
      !old.accepted.includes(ExpectedOutcome.AcceptedNew)
    );
  };
  const wasCorrection = (position: number): boolean => {
    const old = earlier(position);
    if (!old) return false;
    if (old.correction !== undefined) return old.correction;
    if (old.accepted.includes(ExpectedOutcome.CorrectionAccepted)) return old.right;
    return old.accepted.includes(ExpectedOutcome.AcceptedNew) ? !old.right : false;
  };
  const ends = scoreEnds(requests, (_r, position) => wasCorrection(position));
  const kept = new Set<string>();
  for (const e of previous.ends) {
    if (e.claim !== undefined || !keepsVerdict(e.position)) continue;
    kept.add(endKey(e));
    for (const k of pairKeys(e.position)) kept.add(k);
  }
  for (const e of ends) {
    const old = previous.ends.find((o) => endKey(o) === endKey(e));
    if (old && kept.has(endKey(e))) e.right = old.right;
    // The scorer does not know whether this end was a correction: the field stays absent, so a later rescore keeps the verdict.
    if (e.claim === undefined && keepsVerdict(e.position)) delete e.correction;
  }
  return buildScore(ends, previous.endState, path);
}

/**
 * Scores a path of the bulk test from its copy. It returns nothing when the sample is not the queue of the bulk test wiki
 * (a `--db` run on another source): the text of each sampled request is compared with the submission at its place.
 *
 * @param store - the open copy after the path
 * @param startSeq - the highest `seq` before the run
 * @param result - the path result with its request records and, if judged, its duplicates
 * @returns the score, or undefined when the sample is not the bulk test queue
 * @sideEffects none (reads)
 */
export function scorePath(store: Store, startSeq: number, result: PathResult): PathScore | undefined {
  if (result.requests.length === 0 || result.requests.length > BULK_SUBMISSIONS.length) return undefined;
  for (const [i, r] of result.requests.entries()) {
    if (getRequest(store, r.requestId)?.change !== BULK_SUBMISSIONS[i]?.change) return undefined;
  }
  const live = listCurrentFacts(store)
    .filter((f) => f.is_deleted === 0)
    .map((f) => ({ factId: f.fact_id, seq: f.seq }));
  return scoreRequests(
    {
      requests: result.requests,
      live,
      firstSeq: firstSeqOfFacts(store),
      startSeq,
      ...(result.duplicates ? { duplicates: result.duplicates } : {}),
    },
    result.path,
  );
}
