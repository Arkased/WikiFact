// The result row of the benefit test (technical/evaluation.md, "The result file"): the schema, and the checks a row
// answers.
import { z } from "zod";
import {
  Arm,
  BenefitCopy,
  BenefitGroup,
  BenefitKind,
  Complexity,
  QuestionType,
  TaskType,
  Verdict,
} from "../lib/enums.js";
import { FILE_TOOLS, WIKI_TOOL_PREFIX } from "./arms.js";
const toolCall = z.object({ tool: z.string(), query: z.string().optional() });

/** The row of one run: (case, arm, run). */
export const resultRow = z.object({
  caseId: z.string(),
  kind: z.nativeEnum(BenefitKind),
  group: z.nativeEnum(BenefitGroup),
  type: z.nativeEnum(QuestionType).optional(),
  complexity: z.nativeEnum(Complexity).optional(),
  taskType: z.nativeEnum(TaskType).optional(),
  /** The copy of the wiki that the case read; absent in a file from before the preload. */
  copy: z.nativeEnum(BenefitCopy).optional(),
  arm: z.nativeEnum(Arm),
  run: z.number().int().min(1),
  correct: z.object({
    /** Question: every term of `answerContains` is in the answer. */
    terms: z.boolean().optional(),
    /** Task: the hidden tests and the type check pass (the task is done). */
    tests: z.boolean().optional(),
    /** Task: the type check alone, to tell a test failure from a type error. */
    typecheck: z.boolean().optional(),
    judge: z.nativeEnum(Verdict),
    judgeReason: z.string().optional(),
  }),
  /** The final text of the agent, kept so that a label can be reviewed against the answers without a new run. Absent in the first run of October 20, 2026. */
  answer: z.string().optional(),
  filesChanged: z.array(z.string()).optional(),
  usage: z.object({ input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number() }),
  costUsd: z.number(),
  turns: z.number(),
  toolCalls: z.array(toolCall),
  wallMs: z.number(),
  error: z.string().optional(),
});

/** The row of one run. */
export type ResultRow = z.infer<typeof resultRow>;

/**
 * The key of a run, for resuming: a run of the same case, arm and number is not run again.
 *
 * @param row - a row, or the three parts of one
 * @returns the key text
 * @sideEffects none
 */
export function runKey(row: Pick<ResultRow, "caseId" | "arm" | "run">): string {
  return `${row.caseId}|${row.arm}|${row.run}`;
}

/**
 * Tells whether a run is right: for a question, every term is in the answer and the judge says correct; for a task,
 * the hidden tests and the type check pass and the judge says correct.
 *
 * @param row - the row
 * @returns true when every check of the row passes
 * @sideEffects none
 */
export function isRight(row: ResultRow): boolean {
  const judged = row.correct.judge === Verdict.Correct;
  return row.kind === BenefitKind.Question
    ? row.correct.terms === true && judged
    : row.correct.tests === true && judged;
}

/**
 * The number of calls of the file tools in a row.
 *
 * @param row - the row
 * @returns the count
 * @sideEffects none
 */
export const fileReadsOf = (row: ResultRow): number => row.toolCalls.filter((c) => FILE_TOOLS.includes(c.tool)).length;

/**
 * The number of calls of the wiki tools in a row.
 *
 * @param row - the row
 * @returns the count
 * @sideEffects none
 */
export const wikiCallsOf = (row: ResultRow): number =>
  row.toolCalls.filter((c) => c.tool.startsWith(WIKI_TOOL_PREFIX)).length;

/**
 * The input-side tokens of a row: fresh input, cache reads and cache writes, all that the model read.
 *
 * @param row - the row
 * @returns the count
 * @sideEffects none
 */
export const inputTokensOf = (row: ResultRow): number => row.usage.input + row.usage.cacheRead + row.usage.cacheWrite;
