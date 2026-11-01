// Scores one model answer against the label of a case. Pure, so the tests can run it.
//
// Labels (`expect`) per question:
//   Q1  { matches: string[] }                                  set equality
//   Q2  { stands }
//   Q4  { supported, rejectReason?, relation?, wrongRelated? } wrongRelated: set of {factId, action}; absent means empty
//   Q7  { oneClaim, support?, claims? }                        support is checked when the key is given; claims: the exact count, and each entry ("|" alternatives) in one answer claim
//   Q8  { holds, stillDepends? }                               stillDepends is checked when holds is true and the key is given
//   Q3, Q5, Q6, Q9, Q10 (drafts):
//       { drafts: n, contentHas?, contentLacks?, headerHas?, headerLacks?, refsHas?, refsLacks?, refsExactly?, isDeleted? }
//       contentHas: every entry must appear in the joined content of all drafts, case-insensitive.
//       An entry may list alternatives with "|": "12|twelve".
import { QuestionId } from "../../src/domain/index.js";
import {
  SPECS,
  type DraftResult,
  type Q1Output,
  type Q2Output,
  type Q4Output,
  type Q7Output,
  type Q8Output,
} from "../../src/updates/index.js";
import type { Label } from "./sets.js";

/** The verdict on one answer: whether it matches the label, and if not, why. */
export interface Score {
  pass: boolean;
  why: string;
}

/** The output type of each question. */
export interface QuestionOutputs {
  [QuestionId.Q1]: Q1Output;
  [QuestionId.Q2]: Q2Output;
  [QuestionId.Q3]: DraftResult;
  [QuestionId.Q4]: Q4Output;
  [QuestionId.Q5]: DraftResult;
  [QuestionId.Q6]: DraftResult;
  [QuestionId.Q7]: Q7Output;
  [QuestionId.Q8]: Q8Output;
  [QuestionId.Q9]: DraftResult;
  [QuestionId.Q10]: DraftResult;
}

/** The output of any question. */
export type QuestionOutput = QuestionOutputs[QuestionId];

const lc = (s: string): string => s.toLowerCase();
const has = (text: string, spec: string): boolean => spec.split("|").some((alt) => lc(text).includes(lc(alt)));
const sameSet = (a: string[], b: string[]): boolean =>
  a.length === b.length && new Set(a).size === a.length && b.every((x) => a.includes(x));
const fmt = (x: unknown): string => JSON.stringify(x);

/** The score of a correct answer. */
const ok: Score = { pass: true, why: "" };
const bad = (why: string): Score => ({ pass: false, why });

function scoreQ1(out: Q1Output, e: Label): Score {
  const want = e.matches ?? [];
  return sameSet(out.matches, want) ? ok : bad(`matches ${fmt(out.matches)}, expected ${fmt(want)}`);
}

function scoreQ2(out: Q2Output, e: Label): Score {
  return out.stands === e.stands ? ok : bad(`stands ${out.stands}, expected ${e.stands}`);
}

function scoreQ7(out: Q7Output, e: Label): Score {
  if (out.oneClaim !== e.oneClaim) return bad(`oneClaim ${out.oneClaim}, expected ${e.oneClaim}`);
  if (e.support !== undefined && out.support !== e.support) return bad(`support ${out.support}, expected ${e.support}`);
  if (e.claims !== undefined) {
    // The count must be exact; the content is loose: each expected claim names a "|" list of words, and one claim of the
    // answer holds one of them. One answer claim serves one expected claim only.
    if (out.claims.length !== e.claims.length) {
      return bad(`${out.claims.length} claims, expected ${e.claims.length}: ${fmt(out.claims)}`);
    }
    const free = [...out.claims];
    for (const spec of e.claims) {
      const at = free.findIndex((c) => has(c, spec));
      if (at < 0) return bad(`no claim holds "${spec}": ${fmt(out.claims)}`);
      free.splice(at, 1);
    }
  }
  return ok;
}

function scoreQ8(out: Q8Output, e: Label): Score {
  if (out.holds !== e.holds) return bad(`holds ${out.holds}, expected ${e.holds}`);
  if (e.holds && e.stillDepends && !sameSet(out.stillDepends, e.stillDepends)) {
    return bad(`stillDepends ${fmt(out.stillDepends)}, expected ${fmt(e.stillDepends)}`);
  }
  return ok;
}

function scoreQ4(out: Q4Output, e: Label): Score {
  if (out.supported !== e.supported) return bad(`supported ${out.supported}, expected ${e.supported}`);
  if (e.rejectReason !== undefined && out.rejectReason !== e.rejectReason) {
    return bad(`rejectReason ${out.rejectReason}, expected ${e.rejectReason}`);
  }
  if (e.relation !== undefined && out.relation !== e.relation)
    return bad(`relation ${out.relation}, expected ${e.relation}`);
  const want = e.wrongRelated ?? [];
  const key = (w: { factId: string; action: string }): string => `${w.factId}:${w.action}`;
  if (!sameSet(out.wrongRelated.map(key), want.map(key)))
    return bad(`wrongRelated ${fmt(out.wrongRelated)}, expected ${fmt(want)}`);
  return ok;
}

function scoreDrafts(out: DraftResult, e: Label): Score {
  const drafts = out.drafts;
  if (e.drafts !== undefined && drafts.length !== e.drafts) return bad(`${drafts.length} drafts, expected ${e.drafts}`);
  const content = drafts.map((d) => d.content).join(" || ");
  const header = drafts.map((d) => d.header).join(" || ");
  const refs = drafts.flatMap((d) => d.references);
  for (const s of e.contentHas ?? []) if (!has(content, s)) return bad(`content lacks "${s}": ${content}`);
  for (const s of e.contentLacks ?? []) if (has(content, s)) return bad(`content has "${s}": ${content}`);
  for (const s of e.headerHas ?? []) if (!has(header, s)) return bad(`header lacks "${s}": ${header}`);
  for (const s of e.headerLacks ?? []) if (has(header, s)) return bad(`header has "${s}": ${header}`);
  for (const s of e.refsHas ?? []) if (!refs.includes(s)) return bad(`references lack ${s}: ${fmt(refs)}`);
  for (const s of e.refsLacks ?? []) if (refs.includes(s)) return bad(`references have ${s}: ${fmt(refs)}`);
  if (e.refsExactly && !sameSet([...new Set(refs)], e.refsExactly))
    return bad(`references ${fmt(refs)}, expected ${fmt(e.refsExactly)}`);
  if (e.isDeleted !== undefined && !!drafts[0]?.isDeleted !== e.isDeleted)
    return bad(`isDeleted ${drafts[0]?.isDeleted}, expected ${e.isDeleted}`);
  return ok;
}

type Scorers = { [Q in QuestionId]: (out: QuestionOutputs[Q], expect: Label, input: unknown) => Score };

const SCORERS: Scorers = {
  [QuestionId.Q1]: scoreQ1,
  [QuestionId.Q2]: scoreQ2,
  [QuestionId.Q3]: scoreDrafts,
  [QuestionId.Q4]: scoreQ4,
  [QuestionId.Q5]: scoreDrafts,
  [QuestionId.Q6]: scoreDrafts,
  [QuestionId.Q7]: scoreQ7,
  [QuestionId.Q8]: scoreQ8,
  [QuestionId.Q9]: scoreDrafts,
  [QuestionId.Q10]: scoreDrafts,
};

/**
 * Scores one answer against the label of its case.
 *
 * @param q - the question that was asked
 * @param out - the validated answer of that question
 * @param expect - the label of the case
 * @param input - the expanded input of the case; no scorer reads it today
 * @returns whether the answer matches, and the first difference when it does not
 * @sideEffects none
 */
export function scoreAnswer<Q extends QuestionId>(
  q: Q,
  out: QuestionOutputs[Q],
  expect: Label,
  input?: unknown,
): Score {
  return SCORERS[q](out, expect, input);
}

type Signatures = { [Q in QuestionId]: (out: QuestionOutputs[Q]) => string };

const draftCount = (out: DraftResult): string => String(out.drafts.length);

const SIGNATURES: Signatures = {
  [QuestionId.Q1]: (out) => fmt([...out.matches].sort()),
  [QuestionId.Q2]: (out) => out.stands,
  [QuestionId.Q3]: draftCount,
  [QuestionId.Q4]: (out) =>
    `${out.supported}:${out.rejectReason ?? ""}:${out.relation ?? ""}:${fmt(out.wrongRelated.map((w) => `${w.factId}:${w.action}`).sort())}`,
  [QuestionId.Q5]: draftCount,
  [QuestionId.Q6]: draftCount,
  [QuestionId.Q7]: (out) => `${out.oneClaim}:${out.support}:${out.claims.length}`,
  [QuestionId.Q8]: (out) => `${out.holds}:${fmt([...out.stillDepends].sort())}`,
  [QuestionId.Q9]: draftCount,
  [QuestionId.Q10]: draftCount,
};

/**
 * Gives a short label of the answer, for the F23 stability check: two runs that differ here disagree.
 *
 * @param q - the question that was asked
 * @param out - the validated answer of that question
 * @returns the label
 * @sideEffects none
 */
export function signature<Q extends QuestionId>(q: Q, out: QuestionOutputs[Q]): string {
  return SIGNATURES[q](out);
}

/**
 * Checks a raw answer against the output schema of its question.
 *
 * @param q - the question that was asked
 * @param raw - the value that the question method returned
 * @returns the answer, typed
 * @sideEffects none; throws a ZodError when the answer does not match the schema
 */
export function parseOutput(q: QuestionId, raw: unknown): QuestionOutput {
  return SPECS[q].output.parse(raw);
}
