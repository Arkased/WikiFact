// The judge of the benefit test (technical/evaluation.md, "The judge"): one model question that grades an answer
// against its label, and one that grades a diff against the reference change. It is not in `src/updates/questions/`,
// because no worker runs it.
import { z } from "zod";
import type { QuestionSettings } from "../../src/config/index.js";
import type { Transport } from "../../src/updates/index.js";
import { Verdict } from "../lib/enums.js";
import { askJudgment } from "../lib/judgment.js";

/** The longest diff or reference patch sent to the judge, in characters; the rest is cut with a note. */
const MAX_PATCH_CHARS = 40_000;

const verdictSchema = z.object({ verdict: z.nativeEnum(Verdict), reason: z.string() });

/** The verdict of the judge and its reason. */
type JudgeVerdict = z.infer<typeof verdictSchema>;

/** What the judge sees of an answer. */
interface AnswerInput {
  question: string;
  /** The labeled answer: the truth. */
  labeledAnswer: string;
  /** The files and lines that prove the label, as `file:line` texts. */
  proof: string[];
  answer: string;
}

/** What the judge sees of a task run. */
interface DiffInput {
  issue: string;
  referencePatch: string;
  /** The diff the agent made, in unified form. */
  diff: string;
}

/** The two questions of the judge. */
export interface Judge {
  /**
   * Grades an answer against its label.
   *
   * @param input - the question, the label, the proof and the answer
   * @returns the verdict and a reason
   * @throws {Error} when the model gives no valid verdict after one retry, or does not answer in time
   */
  judgeAnswer(input: AnswerInput): Promise<JudgeVerdict>;
  /**
   * Grades a diff against the reference change.
   *
   * @param input - the issue, the reference patch and the diff
   * @returns the verdict and a reason
   * @throws {Error} when the model gives no valid verdict after one retry, or does not answer in time
   */
  judgeDiff(input: DiffInput): Promise<JudgeVerdict>;
}

const ANSWER_SYSTEM = [
  "You grade the answer of an engineer to a question about a code repository.",
  "You get the question, the labeled answer, the files and lines that prove the label, and the answer.",
  "The label is the truth, even when the answer sounds likely.",
  'Answer with JSON: {"verdict": "correct" | "partial" | "wrong", "reason": "<one or two sentences>"}.',
  "correct: the answer states what the label states on every point the question asks for; extra detail that does not contradict the label is fine.",
  "partial: the answer is right on some point the question asks for and misses or contradicts another.",
  "wrong: the answer contradicts the label on the main point, gives no answer, or says that it cannot tell.",
].join("\n");

const DIFF_SYSTEM = [
  "You grade a code change that an engineer made for an issue.",
  "You get the issue, the reference change (a right solution) and the diff of the engineer.",
  'Answer with JSON: {"verdict": "correct" | "partial" | "wrong", "reason": "<one or two sentences>"}.',
  "correct: the diff solves the issue with the same effect as the reference change, in the code and, when the issue asks, in the docs.",
  "partial: the diff solves part of the issue, or misses a place that the reference changes.",
  "wrong: the diff does not solve the issue, breaks other behavior, or passes a test by a hack such as hard-coding a value, special-casing the test or removing a check.",
].join("\n");

const cut = (text: string): string =>
  text.length > MAX_PATCH_CHARS
    ? `${text.slice(0, MAX_PATCH_CHARS)}\n[cut: ${text.length - MAX_PATCH_CHARS} more characters]`
    : text;

/**
 * Builds the judge on a transport of the question callers.
 *
 * @param transport - the transport that sends the request
 * @param settings - the model and the effort of the judge: the `standard` preset of the judgment questions
 * @returns the judge
 * @sideEffects each verdict sends one or two model requests through the transport
 */
export function modelJudge(transport: Transport, settings: QuestionSettings): Judge {
  const ask = async (system: string, user: string): Promise<JudgeVerdict> =>
    (await askJudgment(transport, settings, verdictSchema, { system, user })).answer;
  return {
    judgeAnswer: (i) =>
      ask(
        ANSWER_SYSTEM,
        [
          `Question: ${i.question}`,
          `Labeled answer: ${i.labeledAnswer}`,
          `Proof: ${i.proof.join(", ")}`,
          `Answer to grade: ${i.answer === "" ? "(no answer)" : i.answer}`,
        ].join("\n\n"),
      ),
    judgeDiff: (i) =>
      ask(
        DIFF_SYSTEM,
        [
          `Issue:\n${i.issue}`,
          `Reference change:\n${cut(i.referencePatch)}`,
          `Diff to grade:\n${i.diff === "" ? "(empty diff)" : cut(i.diff)}`,
        ].join("\n\n"),
      ),
  };
}
