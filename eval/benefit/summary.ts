// The summary of the benefit test (technical/evaluation.md, "The result file"): per arm, kind, group, type and
// complexity, the share right, the cost and the tokens, and the change of the arm "with" against "without".
import { Arm, BenefitGroup, BenefitKind, Complexity, QuestionType, TaskType, Verdict } from "../lib/enums.js";
import { intervalCounts, mean, newcombeInterval, welchInterval, wilsonInterval } from "../lib/stats.js";
import { fileReadsOf, inputTokensOf, isRight, wikiCallsOf, type ResultRow } from "./rows.js";

/** The mean and the range of a measure over the runs of a cell. */
interface Range {
  mean: number;
  min: number;
  max: number;
}

/** The numbers of one arm in one cell. */
export interface ArmStats {
  /** The runs in the cell. */
  runs: number;
  /** The share of runs that are right: all checks of the row pass. 0 to 1. */
  right: number;
  /** The 95% Wilson interval of `right`. */
  ci: [number, number];
  /** The share of question runs whose answer holds every term; absent when the cell has no question. */
  terms?: number;
  /** The share of task runs that are done (the hidden tests and the type check pass); absent when the cell has no task. */
  done?: number;
  /** The share of runs that the judge calls correct. */
  judged: number;
  costUsd: Range;
  /** Fresh input, cache reads and cache writes. */
  inputTokens: Range;
  outputTokens: Range;
  turns: Range;
  /** The mean count of calls of the file tools per run. */
  fileReads: number;
  /** The mean count of calls of the wiki tools per run. */
  wikiCalls: number;
  /** The runs that ended with an error. */
  errors: number;
}

/** The change of the arm "with" against "without", in percent of "without"; null when "without" is 0. */
export interface Delta {
  right: number | null;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  turns: number | null;
}

/** A difference of the arm "with" minus "without", with its 95% interval. */
export interface Difference {
  /** The difference of the shares (0..1 scale) or of the mean dollars. NaN when an arm has too few runs. */
  value: number;
  /** The 95% interval of the difference: Newcombe for a share, Welch for the dollars. */
  ci: [number, number];
  /** True when the interval does not hold 0. */
  counts: boolean;
}

/** The differences "with" minus "without" of a cell. */
export interface Differences {
  /** The share right (Newcombe interval). */
  right: Difference;
  /** The share done; present when both arms have task runs. */
  done?: Difference;
  /** The mean dollars per run (Welch interval). */
  costUsd: Difference;
}

/** One line of the summary: a value of a dimension, with each arm. */
export interface Cell {
  key: string;
  with?: ArmStats;
  without?: ArmStats;
  /** Present when both arms have runs. */
  deltaPct?: Delta;
  /** Present when both arms have runs. Files from before it have none. */
  diff?: Differences;
}

/** The summary of a result file. */
export interface Summary {
  overall: Cell;
  byKind: Cell[];
  byGroup: Cell[];
  /** Kind and group together, because the bar is set per kind on the group "held". */
  byKindAndGroup: Cell[];
  byType: Cell[];
  byComplexity: Cell[];
  byTaskType: Cell[];
}

const PERCENT = 100;

function range(values: number[]): Range {
  return { mean: mean(values), min: Math.min(...values), max: Math.max(...values) };
}

function armStats(rows: ResultRow[]): ArmStats {
  const questions = rows.filter((r) => r.kind === BenefitKind.Question);
  const tasks = rows.filter((r) => r.kind === BenefitKind.Task);
  const share = (n: number, of: number): number => (of === 0 ? Number.NaN : n / of);
  return {
    runs: rows.length,
    right: share(rows.filter(isRight).length, rows.length),
    ci: wilsonInterval(rows.filter(isRight).length, rows.length),
    ...(questions.length > 0
      ? { terms: share(questions.filter((r) => r.correct.terms === true).length, questions.length) }
      : {}),
    ...(tasks.length > 0 ? { done: share(tasks.filter((r) => r.correct.tests === true).length, tasks.length) } : {}),
    judged: share(rows.filter((r) => r.correct.judge === Verdict.Correct).length, rows.length),
    costUsd: range(rows.map((r) => r.costUsd)),
    inputTokens: range(rows.map(inputTokensOf)),
    outputTokens: range(rows.map((r) => r.usage.output)),
    turns: range(rows.map((r) => r.turns)),
    fileReads: mean(rows.map(fileReadsOf)),
    wikiCalls: mean(rows.map(wikiCallsOf)),
    errors: rows.filter((r) => r.error !== undefined).length,
  };
}

const change = (a: number, b: number): number | null =>
  b === 0 || Number.isNaN(a) || Number.isNaN(b) ? null : ((a - b) / b) * PERCENT;

const difference = (value: number, ci: [number, number]): Difference => ({ value, ci, counts: intervalCounts(ci) });

// The difference "with" minus "without" of the share of rows that pass `test`, with its Newcombe interval.
function shareDifference(withRows: ResultRow[], withoutRows: ResultRow[], test: (r: ResultRow) => boolean): Difference {
  const w = withRows.filter(test).length;
  const wo = withoutRows.filter(test).length;
  return difference(
    w / withRows.length - wo / withoutRows.length,
    newcombeInterval(w, withRows.length, wo, withoutRows.length),
  );
}

function differencesOf(withRows: ResultRow[], withoutRows: ResultRow[]): Differences {
  const withTasks = withRows.filter((r) => r.kind === BenefitKind.Task);
  const withoutTasks = withoutRows.filter((r) => r.kind === BenefitKind.Task);
  const withCosts = withRows.map((r) => r.costUsd);
  const withoutCosts = withoutRows.map((r) => r.costUsd);
  const isDone = (r: ResultRow): boolean => r.correct.tests === true;
  return {
    right: shareDifference(withRows, withoutRows, isRight),
    ...(withTasks.length > 0 && withoutTasks.length > 0
      ? { done: shareDifference(withTasks, withoutTasks, isDone) }
      : {}),
    costUsd: difference(mean(withCosts) - mean(withoutCosts), welchInterval(withCosts, withoutCosts)),
  };
}

function cellOf(key: string, rows: ResultRow[]): Cell {
  const withRows = rows.filter((r) => r.arm === Arm.With);
  const withoutRows = rows.filter((r) => r.arm === Arm.Without);
  const w = withRows.length > 0 ? armStats(withRows) : undefined;
  const wo = withoutRows.length > 0 ? armStats(withoutRows) : undefined;
  return {
    key,
    ...(w ? { with: w } : {}),
    ...(wo ? { without: wo } : {}),
    ...(w && wo
      ? {
          deltaPct: {
            right: change(w.right, wo.right),
            costUsd: change(w.costUsd.mean, wo.costUsd.mean),
            inputTokens: change(w.inputTokens.mean, wo.inputTokens.mean),
            outputTokens: change(w.outputTokens.mean, wo.outputTokens.mean),
            turns: change(w.turns.mean, wo.turns.mean),
          },
        }
      : {}),
    ...(w && wo ? { diff: differencesOf(withRows, withoutRows) } : {}),
  };
}

function cellsBy(rows: ResultRow[], values: string[], pick: (r: ResultRow) => string | undefined): Cell[] {
  return values
    .map((v) => ({ v, rows: rows.filter((r) => pick(r) === v) }))
    .filter((x) => x.rows.length > 0)
    .map((x) => cellOf(x.v, x.rows));
}

/**
 * Summarizes the rows of a result file.
 *
 * @param rows - the rows
 * @returns the cell of all rows, and the cells per kind, group, kind and group, question type, complexity and task type; a value with no row has no cell
 * @sideEffects none
 */
export function summarize(rows: ResultRow[]): Summary {
  return {
    overall: cellOf("all", rows),
    byKind: cellsBy(rows, Object.values(BenefitKind), (r) => r.kind),
    byGroup: cellsBy(rows, Object.values(BenefitGroup), (r) => r.group),
    byKindAndGroup: cellsBy(
      rows,
      Object.values(BenefitKind).flatMap((k) => Object.values(BenefitGroup).map((g) => `${k}/${g}`)),
      (r) => `${r.kind}/${r.group}`,
    ),
    byType: cellsBy(rows, Object.values(QuestionType), (r) => r.type),
    byComplexity: cellsBy(rows, Object.values(Complexity), (r) => r.complexity),
    byTaskType: cellsBy(rows, Object.values(TaskType), (r) => r.taskType),
  };
}

/** The bar on the group "held" for one kind, evaluated on a summary; reported, not enforced, at the first runs. */
export interface HeldBar {
  kind: BenefitKind;
  /**
   * True when the share difference (right for questions, done for tasks) does not count as negative and the dollar
   * difference counts and is negative. Null when a side has no runs.
   */
  met: boolean | null;
  withRight?: number;
  withoutRight?: number;
  withCostUsd?: number;
  withoutCostUsd?: number;
  /** The share difference "with" minus "without" that the bar used: the share right (questions) or done (tasks). */
  shareDiff?: Difference;
  /** The dollar difference that the bar used. */
  costDiff?: Difference;
}

/**
 * Evaluates the pass condition on the "held" group, for questions and for tasks: the share right of the arm "with"
 * (the share done for tasks) is not lower by a difference that counts, and its mean dollars are lower by a difference
 * that counts (the 95% interval of the difference does not hold 0).
 *
 * @param summary - the summary
 * @returns one bar per kind that has runs in the group "held"
 * @sideEffects none
 */
export function heldBars(summary: Summary): HeldBar[] {
  return Object.values(BenefitKind).flatMap((kind): HeldBar[] => {
    const cell = summary.byKindAndGroup.find((c) => c.key === `${kind}/${BenefitGroup.Held}`);
    if (!cell) return [];
    const { with: w, without: wo } = cell;
    if (!w || !wo || !cell.diff) return [{ kind, met: null }];
    const shareDiff = (kind === BenefitKind.Task ? cell.diff.done : undefined) ?? cell.diff.right;
    const costDiff = cell.diff.costUsd;
    return [
      {
        kind,
        shareDiff,
        costDiff,
        met: !(shareDiff.counts && shareDiff.value < 0) && costDiff.counts && costDiff.value < 0,
        withRight: kind === BenefitKind.Task ? (w.done ?? w.right) : w.right,
        withoutRight: kind === BenefitKind.Task ? (wo.done ?? wo.right) : wo.right,
        withCostUsd: w.costUsd.mean,
        withoutCostUsd: wo.costUsd.mean,
      },
    ];
  });
}
