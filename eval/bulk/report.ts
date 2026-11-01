// The short text that the bulk test prints at the end.
import type { BulkResultFile, PathResult } from "./types.js";

const MS_PER_SECOND = 1000;
/** The width of the path name column, in characters. */
const NAME_WIDTH = 11;
/** Decimals of the seconds printed. */
const SECONDS_DECIMALS = 1;
/** Decimals of the dollars printed. */
const USD_DECIMALS = 4;

function line(r: PathResult | undefined, name: string): string {
  if (!r) return `${name.padEnd(NAME_WIDTH)} not run`;
  const t = r.usage.tokens;
  const outcomes = Object.entries(r.outcomes)
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");
  return [
    `${name.padEnd(NAME_WIDTH)} ${(r.wallMs / MS_PER_SECOND).toFixed(SECONDS_DECIMALS)} s (snapshots ${(r.snapshotMs / MS_PER_SECOND).toFixed(SECONDS_DECIMALS)} s)`,
    `calls ${r.usage.calls}`,
    `tokens in ${t.input} out ${t.output} cache read ${t.cacheRead} write ${t.cacheWrite}`,
    `$${r.usage.usd.toFixed(USD_DECIMALS)}`,
    `outcomes: ${outcomes || "none"}`,
    r.duplicates ? `duplicate pairs ${r.duplicates.pairs.length}` : "",
    r.complete ? "" : "INCOMPLETE",
  ]
    .filter((s) => s !== "")
    .join("  ");
}

/**
 * Names the requests that a path left `running` or `queued`, for the error line of a run that exits with code 1.
 *
 * @param f - the result file
 * @returns 1 line with the count of each path that has some, or undefined when no path has
 * @sideEffects none
 */
export function unfinishedLine(f: BulkResultFile): string | undefined {
  const parts = [f.sequential, f.batch].flatMap((r) =>
    r?.unfinished ? [`${r.unfinished} in the ${r.path} path`] : [],
  );
  return parts.length === 0 ? undefined : `not complete: requests still running or queued: ${parts.join(", ")}`;
}

/**
 * Formats the result file as a few lines for the terminal.
 *
 * @param f - the result file
 * @returns one line per path (the second only for `secondOnly`), the score of each path, the rounds of each batch of B and C, then the differences when the comparison ran
 * @sideEffects none
 */
export function formatSummary(f: BulkResultFile): string {
  const out = [
    `bulk test: ${f.requests} requests of ${f.queuedInSource} queued, batch size ${f.batchSize}, concurrency ${f.concurrency}` +
      (f.groupCut === undefined ? "" : `, group cut ${f.groupCut}`),
    ...(f.secondOnly ? [] : [line(f.sequential, "sequential")]),
    line(f.batch, f.arch ?? "batch"),
  ];
  for (const r of [f.sequential, f.batch]) if (r?.score) out.push(`score ${r.score.line}`);
  for (const r of f.batch?.rounds ?? []) {
    out.push(
      `  batch ${r.batch} round ${r.round}: ${r.requests} requests, cut ${r.cut}, shared candidate ${r.sharedCandidate ? "on" : "off"}, ` +
        `${r.groups} groups, largest ${r.largestGroup}, split label pairs ${r.splitPairs} of ${r.labelPairs}, ` +
        `reconciled ${r.reconciled.pairs} pairs, ${r.reconciled.merged} merged`,
    );
  }
  if (f.stoppedBy !== undefined) out.push(`stopped by: ${f.stoppedBy}`);
  if (f.differences) {
    const d = f.differences;
    out.push(
      `differences: ${d.outcomes.length} requests with another outcome, ${d.onlySequential.length} facts only sequential, ` +
        `${d.onlyBatch.length} only batch, ${d.sameHeader} same header (${d.sameContent} same content)`,
    );
  }
  return out.join("\n");
}
