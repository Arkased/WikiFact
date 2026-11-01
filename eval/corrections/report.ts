import { WorkerMode } from "../lib/enums.js";
import { isWrong, loadData, type Data } from "./data.js";
import type { RunReport } from "./run.js";
import { DISPLAY_DECIMALS } from "../../src/constants.js";

/** Milliseconds in a second. */
const MS_PER_SECOND = 1000;

/**
 * Formats the reports of the caps as a text table, one column per run.
 *
 * @param reports - the reports, one per cap
 * @param data - the seed data, for the number of wrong facts. Default: read from the JSON files.
 * @returns the table, lines joined with newlines
 * @sideEffects reads the data files when `data` is omitted
 */
export function formatTable(reports: RunReport[], data: Data = loadData()): string {
  const wrongCount = data.facts.filter(isWrong).length;
  const cols = reports.map((r) => `cap ${r.cap}${r.hook ? " +hook" : ""}`);
  const row = (label: string, f: (r: RunReport) => string): string[] => [label, ...reports.map(f)];
  const ifWorker = (f: (r: RunReport) => string) => (r: RunReport) => (r.workerMode === WorkerMode.None ? "n/a" : f(r));
  const seconds = (ms: number): string => (ms / MS_PER_SECOND).toFixed(1);
  const rows: string[][] = [
    ["", ...cols],
    row("tasks", (r) => String(r.counts.tasks)),
    row("retrievals rows (reads)", (r) => String(r.counts.retrievals)),
    row("  of a wrong fact", (r) => String(r.counts.readsOfWrong)),
    row("requestChange calls", (r) => String(r.counts.requestChange)),
    row("  naming a wrong fact", (r) => String(r.counts.namingWrong)),
    row("  naming the task's wrong fact", (r) => String(r.counts.namingOwn)),
    row("tasks with a correction", (r) => `${r.counts.tasksWithCorrection}/${r.counts.tasks}`),
    row("wrong facts named", (r) => `${r.counts.wrongFactsNamed}/${wrongCount}`),
    row("corrections per read", (r) =>
      r.counts.retrievals ? (r.counts.requestChange / r.counts.retrievals).toFixed(DISPLAY_DECIMALS) : "n/a",
    ),
    row("answers right", (r) => `${r.counts.answersOk}/${r.counts.tasks}`),
    row(
      `accepted (worker: ${[...new Set(reports.map((r) => r.workerMode))].join("/")})`,
      ifWorker((r) => String(r.counts.accepted)),
    ),
    row(
      "  naming a wrong fact",
      ifWorker((r) => String(r.counts.acceptedNamingWrong)),
    ),
    row(
      "wrong facts with a new version",
      ifWorker((r) => `${r.counts.wrongFactsWithNewVersion}/${wrongCount}`),
    ),
    row("F17 probes returning the new fact", (r) => `${r.counts.f17.hits}/${r.counts.f17.probes}`),
    row("cost usd", (r) => r.counts.costUsd.toFixed(DISPLAY_DECIMALS)),
    row("concurrency", (r) => String(r.concurrency)),
    row("task wall p50 / p95 (s)", (r) => `${seconds(r.taskWall.p50Ms)} / ${seconds(r.taskWall.p95Ms)}`),
    row("seconds", (r) => r.seconds.toFixed(0)),
  ];
  const width = (i: number): number => Math.max(...rows.map((r) => (r[i] ?? "").length));
  const widths = (rows[0] ?? []).map((_, i) => width(i));
  return rows
    .map((r) => r.map((c, i) => (i === 0 ? c.padEnd(widths[i] ?? 0) : c.padStart(widths[i] ?? 0))).join("  "))
    .join("\n");
}
