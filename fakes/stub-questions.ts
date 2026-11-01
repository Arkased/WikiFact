// A stub of the `Questions` interface for tests and the --stub modes of eval/ (docs/code-standard.md, section 2).
import { Q2Stands, Q4Relation, SupportKind } from "../src/domain/enums.js";
import type {
  DraftResult,
  GroupCall,
  ModelDraft,
  Q10Input,
  Q10Output,
  Q1Input,
  Q1Output,
  Q2Input,
  Q2Output,
  Q3Input,
  Q3Output,
  Q4Input,
  Q4Output,
  Q5Input,
  Q5Output,
  Q6Input,
  Q6Output,
  Q7Input,
  Q7Output,
  Q8Input,
  Q8Output,
  Q9Input,
  Q9Output,
  QuestionContext,
  QuestionName,
  Questions,
  TokenUsage,
} from "../src/updates/types.js";

interface InputOf {
  q1: Q1Input;
  q2: Q2Input;
  q3: Q3Input;
  q4: Q4Input;
  q5: Q5Input;
  q6: Q6Input;
  q7: Q7Input;
  q8: Q8Input;
  q9: Q9Input;
  q10: Q10Input;
}
interface OutputOf {
  q1: Q1Output;
  q2: Q2Output;
  q3: Q3Output;
  q4: Q4Output;
  q5: Q5Output;
  q6: Q6Output;
  q7: Q7Output;
  q8: Q8Output;
  q9: Q9Output;
  q10: Q10Output;
}

type One<Q extends QuestionName> =
  OutputOf[Q] | ((input: InputOf[Q], ctx: QuestionContext, call: number) => OutputOf[Q] | Promise<OutputOf[Q]>);

/**
 * An answer for one question: a value, a function of the input, or an array of those.
 * An array answers the calls in order, and the last entry repeats.
 * A function may throw, to simulate a failed call.
 */
export type Answer<Q extends QuestionName> = One<Q> | One<Q>[];

/** How many characters of the change text the stub takes as the header of a fact it drafts. */
const STUB_HEADER_CHARS = 60;

/** The answers a `StubQuestions` is built with: one optional `Answer` per question. */
export type StubAnswers = { [Q in QuestionName]?: Answer<Q> };

interface StubCall {
  q: QuestionName;
  input: unknown;
  ctx: QuestionContext;
}

/**
 * Builds the one-draft result of a drafting question with empty references as defaults.
 *
 * @param d - the draft fields; `header` and `content` are required
 * @returns a `DraftResult` with the one draft
 * @sideEffects none
 */
export function draftOf(d: Partial<ModelDraft> & { header: string; content: string }): DraftResult {
  return { drafts: [{ references: [], ...d }] };
}

/** Fixed answers for every question. A test overrides the ones it needs. */
export class StubQuestions implements Questions {
  /** Every call so far, in order, with its input and context. */
  readonly calls: StubCall[] = [];
  private counts: Record<string, number> = {};
  private answers: StubAnswers;
  /** The group call. Default: a call that fails, so that a group falls back to the pipeline of 1 request; a test sets its own. */
  group: GroupCall = { retries: 0, ask: () => Promise.reject(new Error("the stub has no group answer")) };

  /**
   * Creates the stub.
   *
   * @param answers - the answers that replace the defaults, per question
   * @sideEffects none
   */
  constructor(answers: StubAnswers = {}) {
    this.answers = answers;
  }

  /**
   * Replaces the answer of one question and resets its call counter.
   *
   * @param q - the question
   * @param answer - the new answer
   * @returns this stub, for chaining
   * @sideEffects mutates the stub's answers and call counter
   */
  set<Q extends QuestionName>(q: Q, answer: Answer<Q>): this {
    (this.answers as Record<string, unknown>)[q] = answer;
    this.counts[q] = 0;
    return this;
  }

  /**
   * Counts the calls to one question so far.
   *
   * @param q - the question
   * @returns the number of recorded calls to `q`
   * @sideEffects none
   */
  count(q: QuestionName): number {
    return this.calls.filter((c) => c.q === q).length;
  }

  /**
   * Reports the token usage, which is always zero for the stub.
   *
   * @returns zero input and zero output tokens
   * @sideEffects none
   */
  takeUsage(): TokenUsage {
    return { input: 0, output: 0 };
  }

  private async run<Q extends QuestionName>(
    q: Q,
    input: InputOf[Q],
    ctx: QuestionContext,
    fallback: (input: InputOf[Q], ctx: QuestionContext) => OutputOf[Q],
  ): Promise<OutputOf[Q]> {
    this.calls.push({ q, input, ctx });
    const n = this.counts[q] ?? 0;
    this.counts[q] = n + 1;
    // Through unknown: the indexed access over 13 questions is a union that the compiler cannot compare.
    const a = this.answers[q] as unknown as Answer<Q> | undefined;
    if (a === undefined) return fallback(input, ctx);
    const one: One<Q> = Array.isArray(a) ? a[Math.min(n, a.length - 1)] : a;
    // Through unknown again: with 16 outputs the compiler no longer proves that an output is not a function.
    const f: unknown = one;
    if (typeof f === "function") {
      return await (f as (i: InputOf[Q], c: QuestionContext, call: number) => OutputOf[Q] | Promise<OutputOf[Q]>)(
        input,
        ctx,
        n,
      );
    }
    return one as OutputOf[Q];
  }

  /**
   * Answers Q1: no fact matches, unless a test set an answer.
   *
   * @param input - the Q1 input
   * @param ctx - the subject
   * @returns the Q1 output
   * @sideEffects records the call
   */
  q1(input: Q1Input, ctx: QuestionContext): Promise<Q1Output> {
    return this.run("q1", input, ctx, () => ({ matches: [] }));
  }

  /**
   * Answers Q2: the kept fact stands, unless a test set an answer.
   *
   * @param input - the Q2 input
   * @param ctx - the subject
   * @returns the Q2 output
   * @sideEffects records the call
   */
  q2(input: Q2Input, ctx: QuestionContext): Promise<Q2Output> {
    return this.run("q2", input, ctx, () => ({ stands: Q2Stands.Kept, reason: "stub" }));
  }

  /**
   * Answers Q3: the kept fact's header with the given content, unless a test set an answer.
   *
   * @param input - the Q3 input
   * @param ctx - the subject
   * @returns the Q3 output
   * @sideEffects records the call
   */
  q3(input: Q3Input, ctx: QuestionContext): Promise<Q3Output> {
    return this.run("q3", input, ctx, (i) => {
      const cur = i.kept.versions[0];
      return draftOf({ header: cur.header, content: i.content });
    });
  }

  /**
   * Answers Q4: the change is supported, unless a test set an answer.
   *
   * @param input - the Q4 input
   * @param ctx - the subject
   * @returns the Q4 output
   * @sideEffects records the call
   */
  q4(input: Q4Input, ctx: QuestionContext): Promise<Q4Output> {
    return this.run("q4", input, ctx, (i) => ({
      supported: true,
      relation: i.existing ? Q4Relation.Different : undefined,
      wrongRelated: [],
      reason: "stub",
    }));
  }

  /**
   * Answers Q5: a draft whose content is the change, unless a test set an answer.
   *
   * @param input - the Q5 input
   * @param ctx - the subject
   * @returns the Q5 output
   * @sideEffects records the call
   */
  q5(input: Q5Input, ctx: QuestionContext): Promise<Q5Output> {
    return this.run("q5", input, ctx, (i) => {
      const cur = i.existing?.versions[0];
      return draftOf({
        header: cur?.header ?? i.change.slice(0, STUB_HEADER_CHARS),
        content: i.change,
        references: cur?.references ?? [],
      });
    });
  }

  /**
   * Answers Q6: the wrong fact narrowed and referencing the claim, unless a test set an answer.
   *
   * @param input - the Q6 input
   * @param ctx - the subject
   * @returns the Q6 output
   * @sideEffects records the call
   */
  q6(input: Q6Input, ctx: QuestionContext): Promise<Q6Output> {
    return this.run("q6", input, ctx, (i) => {
      const cur = i.wrong.versions[0];
      return draftOf({
        header: cur.header,
        content: `${cur.content} (narrowed)`,
        references: [...cur.references, ...(i.claim.factId ? [i.claim.factId] : [])],
      });
    });
  }

  /**
   * Answers Q7: one claim, supported by an observation, unless a test set an answer.
   *
   * @param input - the Q7 input
   * @param ctx - the subject
   * @returns the Q7 output
   * @sideEffects records the call
   */
  q7(input: Q7Input, ctx: QuestionContext): Promise<Q7Output> {
    return this.run("q7", input, ctx, () => ({
      oneClaim: true,
      claims: [],
      support: SupportKind.Observation,
      reason: "",
    }));
  }

  /**
   * Answers Q8: the dependent claim holds and still depends on every changed fact, unless a test set an answer.
   *
   * @param input - the Q8 input
   * @param ctx - the subject
   * @returns the Q8 output
   * @sideEffects records the call
   */
  q8(input: Q8Input, ctx: QuestionContext): Promise<Q8Output> {
    return this.run("q8", input, ctx, (i) => ({
      holds: true,
      stillDepends: i.changed.map((c) => c.factId),
      reason: "stub",
    }));
  }

  /**
   * Answers Q9: the dependent fact marked "(rewritten)", unless a test set an answer.
   *
   * @param input - the Q9 input
   * @param ctx - the subject
   * @returns the Q9 output
   * @sideEffects records the call
   */
  q9(input: Q9Input, ctx: QuestionContext): Promise<Q9Output> {
    return this.run("q9", input, ctx, (i) => {
      const cur = i.dependent.versions[0];
      return draftOf({
        header: cur.header,
        content: `${cur.content} (rewritten)`,
        references: cur.references,
      });
    });
  }

  /**
   * Answers Q10: a redirect fact from the prior query to the target, unless a test set an answer.
   *
   * @param input - the Q10 input
   * @param ctx - the subject
   * @returns the Q10 output
   * @sideEffects records the call
   */
  q10(input: Q10Input, ctx: QuestionContext): Promise<Q10Output> {
    return this.run("q10", input, ctx, (i) => {
      const cur = i.target.versions[0];
      return {
        drafts: [
          {
            header: i.priorQuery,
            content: `${i.priorQuery} means ${cur.header}.`,
            references: [i.target.factId],
          },
        ],
      };
    });
  }
}
