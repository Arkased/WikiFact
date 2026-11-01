// The stubs of the replay test (`eval/replay.ts --stub`) and its tests: answers that a case of replay.json scripts.
import { SupportKind } from "../src/domain/enums.js";
import type { Questions, Q1Input } from "../src/updates/types.js";
import { StubQuestions } from "./stub-questions.js";

/** The script of a case: the `stub` block of replay.json. "@key" in a value names a seed fact id. */
export type StubScript = Record<string, unknown>;

/**
 * Replaces every string "@key" in a value with the id that `ids` holds for `key`, at any depth.
 *
 * @param v - a JSON value from a case script
 * @param ids - seed fact ids by key
 * @returns the value with the ids put in; a "@key" that `ids` does not hold stays as it is
 * @sideEffects none
 */
function substituteIds(v: unknown, ids: Record<string, string>): unknown {
  if (typeof v === "string") return v.startsWith("@") ? (ids[v.slice(1)] ?? v) : v;
  if (Array.isArray(v)) return v.map((x) => substituteIds(x, ids));
  if (v && typeof v === "object")
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, substituteIds(x, ids)]));
  return v;
}

/**
 * Builds a stub from the script of a case: Q1 matches by header, and Q4, Q5, Q7, Q8, Q9 have fixed answers.
 *
 * @param c - the case; only its `stub` block is read
 * @param c.stub - the script; absent means every question has its default answer
 * @param ids - seed fact ids by key, for the "@key" values of the script
 * @returns a `StubQuestions` that answers as the script says
 * @sideEffects none
 */
export function scriptedStub(c: { stub?: StubScript }, ids: Record<string, string>): Questions {
  const s = c.stub ?? {};
  const q1Headers = (Array.isArray(s.q1) ? s.q1 : []).map((h) => String(h).toLowerCase());
  const answers: Record<string, unknown> = {
    q1: (input: Q1Input) => ({
      matches: input.candidates.filter((x) => q1Headers.includes(x.header.toLowerCase())).map((x) => x.factId),
    }),
  };
  // An array answers the calls in order and the last entry repeats: a split case scripts the parent first, then its children.
  const q7Of = (a: object): object => ({
    oneClaim: true,
    claims: [],
    support: SupportKind.Observation,
    reason: "stub",
    ...a,
  });
  if (Array.isArray(s.q7)) answers.q7 = s.q7.map((a: object) => q7Of(a));
  else if (s.q7) answers.q7 = q7Of(s.q7);
  if (s.q4) answers.q4 = { wrongRelated: [], reason: "stub", ...(substituteIds(s.q4, ids) as object) };
  if (s.q5) answers.q5 = substituteIds(s.q5, ids);
  if (s.q8) answers.q8 = s.q8;
  if (s.q9) answers.q9 = substituteIds(s.q9, ids);
  return new StubQuestions(answers);
}

/**
 * Builds a stub that knows nothing: Q1 matches no fact, so the checks must catch it on the duplicate cases.
 *
 * @returns a `StubQuestions` whose Q1 answer is "no match"
 * @sideEffects none
 */
export function naiveStub(): Questions {
  return new StubQuestions({ q1: { matches: [] } });
}
