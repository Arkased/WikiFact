// The questions of the cleanup tests: the stub's, with Q1 and Q2 scripted by the test. The object is built here, not by the
// stub, so that these tests do not depend on how the stub answers the cleanup questions.
import { StubQuestions } from "../../../../fakes/stub-questions.js";
import type { Q1Input, Q1Output, Q2Input, Q2Output, Questions } from "../../types.js";

type Script<I, O> = O | ((input: I, call: number) => O);

/** What a test scripts: one answer or one function per cleanup question. */
export interface Scripts {
  /** Q1 is the stub's (no match) unless scripted. */
  q1?: Script<Q1Input, Q1Output>;
  /** Q2 is the stub's (the kept fact stands) unless scripted. */
  q2?: Script<Q2Input, Q2Output>;
}

/** The questions and the inputs that Q1 and Q2 received. */
export interface Scripted {
  q: Questions;
  q1: Q1Input[];
  q2: Q2Input[];
}

/**
 * Builds questions that answer Q1 and Q2 from the scripts and record their inputs.
 *
 * @param scripts - the answers
 * @returns the questions and the recorded inputs
 */
export function scripted(scripts: Scripts): Scripted {
  const stub = new StubQuestions();
  const seen: Pick<Scripted, "q1" | "q2"> = { q1: [], q2: [] };
  function answer<I, O>(log: I[], script: Script<I, O>, input: I): Promise<O> {
    log.push(input);
    return Promise.resolve(
      typeof script === "function" ? (script as (i: I, n: number) => O)(input, log.length - 1) : script,
    );
  }
  const q: Questions = {
    q1: (i, c) => (scripts.q1 === undefined ? stub.q1(i, c) : answer(seen.q1, scripts.q1, i)),
    q2: (i, c) => (scripts.q2 === undefined ? stub.q2(i, c) : answer(seen.q2, scripts.q2, i)),
    q3: (i, c) => stub.q3(i, c),
    q4: (i, c) => stub.q4(i, c),
    q5: (i, c) => stub.q5(i, c),
    q6: (i, c) => stub.q6(i, c),
    q7: (i, c) => stub.q7(i, c),
    q8: (i, c) => stub.q8(i, c),
    q9: (i, c) => stub.q9(i, c),
    q10: (i, c) => stub.q10(i, c),
    group: stub.group,
    takeUsage: () => stub.takeUsage(),
  };
  return { q, ...seen };
}
