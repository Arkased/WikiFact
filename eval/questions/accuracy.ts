// The accuracy of a configuration from its grid of results: per case.
import { mean, wilsonInterval } from "../lib/stats.js";

/** The verdict of one call of one case in one run. */
export interface Graded {
  pass: boolean;
}

/**
 * Gives the share of cases that passed in each run.
 *
 * @param grid - the result of each call: `grid[case][run]`; a missing cell counts as failed
 * @param runs - the number of runs that have happened
 * @returns one share per run, 0..1; NaN when there is no case
 * @sideEffects none
 */
export function caseRunAccuracy(grid: Graded[][], runs: number): number[] {
  return Array.from({ length: runs }, (_, r) => grid.filter((row) => row[r]?.pass).length / grid.length);
}

/**
 * Gives the share of runs in which each case passed.
 *
 * @param grid - the result of each call: `grid[case][run]`
 * @param ids - the id of each case, in the order of the grid
 * @param runs - the number of runs that have happened
 * @returns the rate by case id; 0 when no run has happened
 * @sideEffects none
 */
export function casePassRate(grid: Graded[][], ids: string[], runs: number): Record<string, number> {
  return Object.fromEntries(
    ids.map((id, ci) => [id, (grid[ci] ?? []).slice(0, runs).filter((x) => x.pass).length / Math.max(1, runs)]),
  );
}

/** The score of a set of cases: the cases, the mean over the runs of the share that passed (0..1) and its 95% Wilson interval over all answers of the runs. */
export interface Score {
  cases: number;
  mean: number;
  ci: [number, number];
}

/**
 * Gives the score of some cases: their mean over the runs and its 95% interval over all their answers.
 *
 * @param rows - the cases to score, each with the result of each call: `rows[case][run]`; a missing cell counts as failed
 * @param runs - the number of runs that have happened
 * @returns the number of cases, the mean over the runs and the interval; NaN mean and interval when there is no case or no run
 * @sideEffects none
 */
export function scoreOf(rows: Graded[][], runs: number): Score {
  const passed = rows.reduce((n, row) => n + row.slice(0, runs).filter((x) => x.pass).length, 0);
  return {
    cases: rows.length,
    mean: mean(caseRunAccuracy(rows, runs)),
    ci: wilsonInterval(passed, rows.length * runs),
  };
}

/** The score of the held-out half and of the tuning half of a set. */
export interface Halves {
  heldOut: Score;
  tuning: Score;
}

/**
 * Gives the score of the held-out half and of the tuning half.
 *
 * @param grid - the result of each call: `grid[case][run]`; a missing cell counts as failed
 * @param heldOut - for each case in the order of the grid, whether it is in the held-out half
 * @param runs - the number of runs that have happened
 * @returns the two halves; undefined when no case is marked held-out, as the set has no split
 * @sideEffects none
 */
export function halvesAccuracy(grid: Graded[][], heldOut: boolean[], runs: number): Halves | undefined {
  if (!heldOut.some(Boolean)) return undefined;
  const half = (want: boolean): Score =>
    scoreOf(
      grid.filter((_row, ci) => heldOut[ci] === want),
      runs,
    );
  return { heldOut: half(true), tuning: half(false) };
}
