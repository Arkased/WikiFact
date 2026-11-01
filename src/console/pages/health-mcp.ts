// technical/console.md, "Service health": the "MCP server" panels of the Operation page (left of its grid): its present (the last tool call, the
// calls and the time of a search in the last 15 minutes) above its last 24 hours (the calls per hour above the search time per hour).
import { HealthLevel, HealthRow } from "../../domain/enums.js";
import { CHART_WIDTH, lineChart, stackedBars } from "../charts.js";
import { durationText, type SafeHtml } from "../html.js";
import { SEARCH_BAR_MS, callsIn, failedIn, hourLabels, leveled, levelOf, rounded, type Facts } from "./health-facts.js";
import { column, dash, panel, plot, stats } from "./parts/index.js";

/** The axis of "Search time per hour" tops at this many times the median hour, so one slow first search does not flatten the rest. */
const SEARCH_CAP_MULTIPLE = 2;

/**
 * Builds the panel "MCP server, now": the time of the last tool call, and the calls and the time of a search of the last 15 minutes.
 *
 * @param f - what the page reads
 * @returns the panel, the left cell of the first row of the grid
 * @sideEffects none
 */
export function nowPanel(f: Facts): SafeHtml {
  const { recent } = f.calls;
  const p95 = rounded(recent.searchP95Ms);
  const p50 = rounded(recent.searchP50Ms);
  // The failed calls row reads the last hour; the window of this stat is shorter, so 0 failed is never colored by an older fault.
  const failedLevel = recent.failed === 0 ? HealthLevel.Green : levelOf(f.report, HealthRow.FailedCalls);
  return panel(
    { title: "MCP server, now" },
    stats([
      {
        label: "Last tool call",
        value: recent.lastAt === null ? dash() : durationText(Math.max(0, f.now - recent.lastAt)),
        under: recent.lastAt === null ? "no call yet" : "ago",
      },
      {
        label: "Tool calls",
        value: recent.calls,
        under: leveled(failedLevel, `${recent.failed} failed`),
      },
      {
        label: "Search time",
        value: p95 === null ? dash() : `${p95} ms`,
        ...(p95 === null ? {} : { level: p95 > SEARCH_BAR_MS ? HealthLevel.Yellow : HealthLevel.Green }),
        under: `${p50 === null ? "no search" : `p50 ${p50} ms`}, bar ${SEARCH_BAR_MS} ms`,
      },
    ]),
  );
}

/**
 * Builds the panel "MCP server, 24 hours": two charts on 1 time axis, then the failed calls of the 24 hours (its own rule: ok at 0, warning over 0).
 *
 * @param f - what the page reads
 * @returns the panel, the left cell of the second row of the grid
 * @sideEffects none
 */
export function historyPanel(f: Facts): SafeHtml {
  const { buckets } = f.calls;
  const labels = hourLabels(buckets.map((b) => b.startMs));
  const width = CHART_WIDTH.half;
  const failedCalls = buckets.reduce((sum, b) => sum + failedIn(b), 0);
  return panel(
    { title: "MCP server, 24 hours" },
    column([
      plot(
        "Tool calls per hour",
        stackedBars(labels, [{ name: "calls", values: buckets.map(callsIn) }], {
          width,
          empty: "No call in 24 hours",
          xTitle: "hour",
          yTitle: "calls",
        }),
      ),
      plot(
        "Search time per hour",
        lineChart(labels, [{ name: "p95", values: buckets.map((b) => rounded(b.searchP95Ms)) }], {
          width,
          empty: "No search in 24 hours",
          xTitle: "hour",
          yTitle: "ms",
          inSlots: true,
          capMultiple: SEARCH_CAP_MULTIPLE,
          reference: { value: SEARCH_BAR_MS, label: `${SEARCH_BAR_MS} ms` },
        }),
      ),
      stats([
        {
          label: "Failed tool calls",
          value: failedCalls,
          level: failedCalls === 0 ? HealthLevel.Green : HealthLevel.Yellow,
        },
      ]),
    ]),
  );
}
