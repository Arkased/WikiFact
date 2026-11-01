// The interface between the pipeline (agent.ts) and the 10 questions (technical/updates.md, "Pipeline", "Dependents loop").
// `src/updates/questions/` implements `Questions` (technical/updates.md, "Dependents loop").
import type {
  ChangeOutcome,
  JudgmentTargetKind,
  Q2Stands,
  Q4Relation,
  RejectReason,
  SupportKind,
  WrongRelatedAction,
} from "../domain/enums.js";
import type { ChangeSet, FactDraft, FactMaterial } from "../store/index.js";

export type { ChangeSet, FactDraft, FactMaterial };

/**
 * One queued request as the pipeline reads it (technical/updates.md, "Pipeline", the input to step 1). Built from a `change_requests`
 * row; a lookupRepair has an empty `change` and `justification`.
 */
export interface Request {
  id: string;
  change: string;
  /** Fact ids the submitter named; empty when none. An id that is no fact is dropped at step 1. */
  targets: string[];
  justification: string;
  /** The id of the search this change follows; its `query` is the prior query of the lookup repair. Absent when the submitter named none. */
  searchId?: string;
  /** The submission that a split made this request from; absent otherwise. A child is never split again. */
  parentId?: string;
}

/**
 * What step 1 reads for a request (technical/updates.md, "Pipeline"): the subject, the named target facts and, for a submission,
 * the candidate facts that look like the change.
 */
export interface Gathered {
  subject: string;
  targetFacts: FactMaterial[];
  /** Facts found by search, nearest first; `distance` is the cosine distance (0..2) of the nearest version. */
  candidates: { fact: FactMaterial; distance: number }[];
}

/**
 * The decision of step 4 (technical/updates.md, "Pipeline"): accept, reject or duplicate, with the facts that an acceptance changes.
 * Empty `targets` for a rejection or a duplicate.
 */
export interface Judgment {
  outcome: ChangeOutcome;
  /** Set for a rejection only. */
  rejectReason?: RejectReason;
  /** The live fact that the claim repeats; set for a duplicate only. */
  duplicateOf?: string;
  changeReasoning: string;
  /**
   * The claim's fact first (`factId` absent for a new fact), then each wrong related fact to delete or narrow. A
   * deletion by negation has a `delete` target on the existing fact and no claim target.
   */
  targets: { kind: JudgmentTargetKind; factId?: string }[];
}

/**
 * What a model returns for a drafting question. It has no `justification` and no `factId`:
 * the code sets both. `drafts` holds exactly one entry.
 */
export type ModelDraft = Omit<FactDraft, "justification" | "factId">;
/** The answer of a drafting question (Q3, Q5, Q6, Q9, Q10): the drafts. */
export interface DraftResult {
  drafts: ModelDraft[];
}

/**
 * The second argument of every question: the subject sentence, which every question gets in its cached block
 * (technical/updates.md, "Pipeline").
 */
export interface QuestionContext {
  subject: string;
  /** The request that the question serves. Only the call log reads it; absent for a caller with no request (an eval). */
  requestId?: string;
}

/** A fact that this change set rewrites, as Q8 and Q9 see it: its text before and after the change. */
export interface ChangedFact {
  factId: string;
  before: { header: string; content: string };
  after: { header: string; content: string; isDeleted: boolean };
}

// ---- Inputs and outputs, technical/updates.md, "Pipeline" and "Dependents loop" ----

/** Q1 input (step 2): the claim text and the candidate facts, each with its header (its scope). */
export interface Q1Input {
  change: string;
  candidates: { factId: string; header: string }[];
}
/** Q1 output: the ids of the candidates whose scope is the claim's scope; empty when none. */
export interface Q1Output {
  matches: string[];
}

/** Q2 input (step 3): two live facts in one scope, the one that is kept and the other one. */
export interface Q2Input {
  kept: FactMaterial;
  other: FactMaterial;
}
/** Q2 output: which fact's content stands, and why. */
export interface Q2Output {
  stands: Q2Stands;
  reason: string;
}

/** Q3 input (step 3): the kept fact, the facts merged into it and the content that stands. */
export interface Q3Input {
  kept: FactMaterial;
  others: FactMaterial[];
  /** The content that Q2 chose, to be written as the merged version. */
  content: string;
  /** The failure of the first attempt, on the retry only. */
  lintFailure?: string;
}
/** Q3 output: exactly one draft, the merged version of the kept fact. */
export type Q3Output = DraftResult;

/** Q4 input (step 4): the claim, its justification, the existing fact in its scope and the related facts. */
export interface Q4Input {
  change: string;
  justification: string;
  /** The fact in the claim's scope; absent when the claim is new. */
  existing?: FactMaterial;
  related: FactMaterial[];
}
/** Q4 output: whether the claim is supported, how it relates to the existing fact and which related facts it breaks. */
export interface Q4Output {
  supported: boolean;
  /** Required when `supported` is false. */
  rejectReason?: RejectReason;
  /**
   * Required when there is an existing fact. `unrelated`: the existing fact is another scope (F24). `negates`: the
   * live existing fact is no longer true, and the claim gives no new content. `stale`: the deleted existing fact is
   * restated with an observation weaker than the deletion's.
   */
  relation?: Q4Relation;
  /** Empty when the claim is not supported. */
  wrongRelated: { factId: string; action: WrongRelatedAction }[];
  /** The record of the decision, stored as the change reasoning. */
  reason: string;
}

/** Q5 input (step 5): the accepted claim, its justification, the existing fact it corrects and the related facts. */
export interface Q5Input {
  change: string;
  justification: string;
  /** The fact that the claim corrects; absent for a new fact. */
  existing?: FactMaterial;
  related: FactMaterial[];
  /** True: `existing` is deleted, and the draft says that its claim is no longer true. */
  negate?: boolean;
  /** The failure of the first attempt, on the retry only. */
  lintFailure?: string;
}
/** Q5 output: `drafts` holds exactly 1 draft (an array only to share the `DraftResult` shape with the other drafting questions). */
export type Q5Output = DraftResult;

/** Q6 input (step 5): the related fact that the claim showed partly wrong, and the claim's draft. */
export interface Q6Input {
  wrong: FactMaterial;
  claim: FactDraft;
  /** The failure of the first attempt, on the retry only. */
  lintFailure?: string;
}
/** Q6 output: exactly one draft, the related fact without the part that was shown wrong. */
export type Q6Output = DraftResult;

/** Q7 input (step 1): the submission to check. */
export interface Q7Input {
  change: string;
  justification: string;
}
/**
 * Q7 output: whether the change is one claim that a reader can act on alone, the claims of a compound change, what kind
 * of support the justification gives, and why.
 */
export interface Q7Output {
  oneClaim: boolean;
  /** When `oneClaim` is false because the change holds 2 claims or more: each claim, written to stand alone. Else empty. */
  claims: string[];
  support: SupportKind;
  reason: string;
}

/** Q8 input (step 7): a dependent fact, the facts it references that changed, and those that did not. */
export interface Q8Input {
  dependent: { factId: string; header: string; content: string; justification: string };
  changed: ChangedFact[];
  unchanged: { factId: string; header: string; content: string }[];
}
/** Q8 output: whether the dependent still holds, which changed references it still rests on, and why. */
export interface Q8Output {
  holds: boolean;
  /** Ids of the changed references that the dependent still depends on. */
  stillDepends: string[];
  reason: string;
}

/** Q9 input (step 7): a dependent that no longer holds, Q8's reason and the facts that changed under it. */
export interface Q9Input {
  dependent: FactMaterial;
  /** The reason that Q8 gave. */
  reason: string;
  changed: ChangedFact[];
  /** The failure of the first attempt, on the retry only. */
  lintFailure?: string;
}
/** Q9 output: one draft, the dependent rewritten (or deleted) under the changed facts. */
export type Q9Output = DraftResult;

/** Q10 input (step 9): the prior query that missed, the target fact and what the query returned. */
export interface Q10Input {
  priorQuery: string;
  target: FactMaterial;
  /** The fact hits of the prior query. */
  results: { id: string; header: string }[];
  /** The failure of the first attempt, on the retry only. */
  lintFailure?: string;
}
/** Q10 output: one draft, an equivalence fact that makes the prior query return the target. */
export type Q10Output = DraftResult;

/** One claim of a group as the group call sees it (technical/updates.md, "The candidate architectures of the bulk test", C). */
export interface GroupClaim {
  /** The place in the group, from 1, in queue order. */
  position: number;
  change: string;
  justification: string;
  /** The live fact of the claim's scope that Q1 matched, as Q4 gets it; absent when none matched. */
  existing?: FactMaterial;
  /** The other facts that may relate to the claim, as Q4 gets them. */
  related: FactMaterial[];
}

/** The input of the group call: the claims that stay in the group, in queue order. */
export interface GroupInput {
  claims: GroupClaim[];
}

/** The fact that a claim is about: a fact id, or the position of an earlier claim of the group. */
type GroupTarget = { factId: string } | { position: number };

/** The answer for one claim: the verdict of Q4, the fact it is about, and the Q5 draft when the verdict writes a fact. */
export interface GroupAnswer {
  position: number;
  verdict: Q4Output;
  /** Absent when the claim is new. */
  target?: GroupTarget;
  /** Present when the verdict writes a fact for the claim. */
  draft?: ModelDraft;
}

/** The output of the group call: one answer for each claim, in order. */
export interface GroupOutput {
  answers: GroupAnswer[];
}

/** The group call (QG): 1 model call for the claims of 1 group. */
export interface GroupCall {
  /**
   * Asks the claims of one group. An answer that fails its schema or its rules is asked 1 more time with the error.
   *
   * @param input - the claims of the group, in queue order
   * @param ctx - the subject and the request that the call row names
   * @returns the validated answer, one entry for each claim, and the tokens of the call (the retry included), which the batch splits over the requests of the group
   * @throws {QuestionError} with code `Invalid` when the second answer is invalid too, and for a refusal, a cut answer or a timeout; the error carries the tokens of the failed call (`failedUsageOf`)
   * @throws {RateLimitError} when the transport reports a rate limit; the error carries the tokens too, but the round reads them only for a fall back, so a rate limit adds them to no request
   * @sideEffects one or two transport calls; with a store and `ctx.requestId`, one `model_calls` row for each (question `QG`)
   */
  ask(input: GroupInput, ctx: QuestionContext): Promise<{ output: GroupOutput; usage: TokenUsage }>;
  /** The second asks so far (the retries after an invalid answer), over all calls of this object. */
  readonly retries: number;
}

/**
 * Hangs the tokens of a failed call on its error, so that the caller can still account for them.
 *
 * @param e - the thrown value; a value that is not an object is left as it is
 * @param usage - the tokens that the failed call used
 * @returns `e`
 * @sideEffects sets the property `failedUsage` of `e`
 */
export function withFailedUsage<E>(e: E, usage: TokenUsage): E {
  if (typeof e === "object" && e !== null) (e as { failedUsage?: TokenUsage }).failedUsage = usage;
  return e;
}

/**
 * Reads the tokens that `withFailedUsage` hung on an error.
 *
 * @param e - the caught value
 * @returns the tokens of the failed call; undefined when the error carries none
 * @sideEffects none
 */
export function failedUsageOf(e: unknown): TokenUsage | undefined {
  if (typeof e !== "object" || e === null) return undefined;
  return (e as { failedUsage?: TokenUsage }).failedUsage;
}

/** Token usage since the last `takeUsage` call. The real questions fill it. The stub reports zeros. */
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/**
 * One method per question. Each is one model call in the real implementation.
 * A method throws on a failure of the call: an API error, a timeout (F21), a refusal that
 * the fallback did not fix (F19), or an output that is still invalid after the one retry (F18).
 * The pipeline treats every throw as a failed attempt.
 */
export interface Questions {
  q1(input: Q1Input, ctx: QuestionContext): Promise<Q1Output>;
  q2(input: Q2Input, ctx: QuestionContext): Promise<Q2Output>;
  q3(input: Q3Input, ctx: QuestionContext): Promise<Q3Output>;
  q4(input: Q4Input, ctx: QuestionContext): Promise<Q4Output>;
  q5(input: Q5Input, ctx: QuestionContext): Promise<Q5Output>;
  q6(input: Q6Input, ctx: QuestionContext): Promise<Q6Output>;
  q7(input: Q7Input, ctx: QuestionContext): Promise<Q7Output>;
  q8(input: Q8Input, ctx: QuestionContext): Promise<Q8Output>;
  q9(input: Q9Input, ctx: QuestionContext): Promise<Q9Output>;
  q10(input: Q10Input, ctx: QuestionContext): Promise<Q10Output>;
  /** The group question QG, which judges the claims of 1 group of a batch with 1 call. */
  readonly group: GroupCall;
  /** Optional. Returns the token usage since the previous call and resets it. The change log line reads it. */
  takeUsage?(): TokenUsage;
  /** Optional. Adds tokens to the usage that `takeUsage` returns: the share of a group call that a request takes. */
  addUsage?(u: TokenUsage): void;
}

/** The name of a single question method of `Questions` (`q1` to `q10`). */
export type QuestionName = Extract<keyof Questions, `q${number}`>;
