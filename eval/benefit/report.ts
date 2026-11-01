// The terminal report of the benefit test: the summary as a text table, as `eval/corrections/report.ts` does.
import type { ArmStats, Cell, Delta, Difference, Differences, HeldBar, Summary } from "./summary.js";
import { COST_DECIMALS } from "../../src/constants.js";

const PERCENT = 100;

const pct = (share: number | undefined): string =>
  share === undefined || Number.isNaN(share) ? "-" : `${Math.round(share * PERCENT)}%`;
/**
 * Formats a cost in USD.
 *
 * @param n - the cost in USD
 * @returns the cost with `COST_DECIMALS` decimals
 * @sideEffects none
 */
export const money = (n: number): string => n.toFixed(COST_DECIMALS);
const whole = (n: number): string => (Number.isNaN(n) ? "-" : String(Math.round(n)));
const ci = (interval: [number, number] | undefined): string =>
  interval === undefined || Number.isNaN(interval[0]) ? "-" : `${pct(interval[0])}-${pct(interval[1])}`;
const points = (n: number): string => (Number.isNaN(n) ? "-" : `${n >= 0 ? "+" : ""}${(n * PERCENT).toFixed(0)}`);
const signedMoney = (n: number): string => (Number.isNaN(n) ? "-" : `${n >= 0 ? "+" : ""}${money(n)}`);
// The text of a difference: its value and 95% interval, with `*` when it counts (the interval does not hold 0).
const diffText = (d: Difference, format: (n: number) => string): string =>
  Number.isNaN(d.value) ? "-" : `${format(d.value)} [${format(d.ci[0])}..${format(d.ci[1])}]${d.counts ? " *" : ""}`;
const signed = (n: number | null): string => (n === null ? "-" : `${n >= 0 ? "+" : ""}${n.toFixed(0)}%`);

const HEAD = [
  "",
  "arm",
  "runs",
  "right",
  "95% ci",
  "terms/done",
  "judged",
  "$ mean",
  "$ min-max",
  "in tokens",
  "out tokens",
  "turns",
  "reads",
  "wiki",
];

function armRow(key: string, arm: string, s: ArmStats): string[] {
  return [
    key,
    arm,
    String(s.runs),
    pct(s.right),
    ci(s.ci),
    pct(s.terms ?? s.done),
    pct(s.judged),
    money(s.costUsd.mean),
    `${money(s.costUsd.min)}-${money(s.costUsd.max)}`,
    whole(s.inputTokens.mean),
    whole(s.outputTokens.mean),
    s.turns.mean.toFixed(1),
    s.fileReads.toFixed(1),
    s.wikiCalls.toFixed(1),
  ];
}

function deltaRow(d: Delta): string[] {
  return [
    "",
    "delta",
    "",
    signed(d.right),
    "",
    "",
    "",
    signed(d.costUsd),
    "",
    signed(d.inputTokens),
    signed(d.outputTokens),
    signed(d.turns),
    "",
    "",
  ];
}

// The row of the differences "with" minus "without": shares in points, dollars in USD, each with its 95% interval.
function diffRow(d: Differences): string[] {
  const row = HEAD.map(() => "");
  row[1] = "diff";
  row[3] = diffText(d.right, points);
  row[5] = d.done ? diffText(d.done, points) : "";
  row[7] = diffText(d.costUsd, signedMoney);
  return row;
}

function cellRows(cell: Cell): string[][] {
  const out: string[][] = [];
  if (cell.with) out.push(armRow(cell.key, "with", cell.with));
  if (cell.without) out.push(armRow(cell.with ? "" : cell.key, "without", cell.without));
  if (cell.deltaPct) out.push(deltaRow(cell.deltaPct));
  if (cell.diff) out.push(diffRow(cell.diff));
  return out;
}

function table(rows: string[][]): string {
  const all = [HEAD, ...rows];
  const widths = HEAD.map((_, i) => Math.max(...all.map((r) => (r[i] ?? "").length)));
  return all
    .map((r) => r.map((c, i) => (i <= 1 ? c.padEnd(widths[i] ?? 0) : c.padStart(widths[i] ?? 0))).join("  "))
    .join("\n");
}

/**
 * Formats the summary as text tables, one section per dimension.
 *
 * @param summary - the summary of the rows
 * @param bars - the bar on the group "held" per kind, reported under the tables
 * @returns the text, lines joined with newlines
 * @sideEffects none
 */
export function formatSummary(summary: Summary, bars: HeldBar[]): string {
  const sections: [string, Cell[]][] = [
    ["All runs", [summary.overall]],
    ["By kind", summary.byKind],
    ["By group", summary.byGroup],
    ["By kind and group", summary.byKindAndGroup],
    ["By question type", summary.byType],
    ["By complexity", summary.byComplexity],
    ["By task type", summary.byTaskType],
  ];
  const text = sections
    .filter(([, cells]) => cells.length > 0)
    .map(([title, cells]) => `${title}\n${table(cells.flatMap(cellRows))}`)
    .join("\n\n");
  const barText = bars
    .map((b) =>
      b.met === null || b.withRight === undefined
        ? `held ${b.kind}s: a side has no runs`
        : `held ${b.kind}s: right ${pct(b.withRight)} with, ${pct(b.withoutRight)} without; $${money(b.withCostUsd ?? 0)} with, $${money(b.withoutCostUsd ?? 0)} without; share diff ${b.shareDiff ? diffText(b.shareDiff, points) : "-"}, dollar diff ${b.costDiff ? diffText(b.costDiff, signedMoney) : "-"} (* counts); bar ${b.met ? "met" : "not met"} (reported, no bar at the first runs)`,
    )
    .join("\n");
  return barText ? `${text}\n\n${barText}` : text;
}
