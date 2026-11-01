// technical/console.md, "Overview": the first page of a wiki. 3 blocks, 1 per question of goal 1: the quality of the
// search, the growth of the wiki and the cost. Every number is a hard datum with its definition; every reading of the data is 1 note
// number with a rule has its level color and its reading as hover text (requirements/console.md, "Data and interpretation"). The 6
// reads run once, on 1 read-only connection; the page does not refresh.
import { z } from "zod";
import type { PriceTable } from "../../config/index.js";
import { ConsoleSection, GridColumns, InterpretationId, Signal, Span } from "../../domain/enums.js";
import {
  readsPerSearch,
  searchMisses,
  spanBounds,
  growthSeries,
  tokenCost,
  type GrowthStretch,
  type SpanBounds,
  type Store,
} from "../../store/index.js";
import { CHART_WIDTH, histogram, lineChart, stackedBars } from "../charts.js";
import { html, layout, sectionLabel, type SafeHtml } from "../html.js";
import type { PageContext } from "../page.js";
import { noResultLevel, searchMissLevel } from "../interpretations.js";
import { SPAN_RECENT_SEARCHES } from "../signals.js";
import {
  column,
  dash,
  empty,
  grid,
  hrefWith,
  note,
  panel,
  parseQuery,
  plot,
  reading,
  segmented,
  stats,
  withWiki,
} from "./parts/index.js";
import { DISPLAY_DECIMALS, NICE_STEP_BASE, NICE_STEP_MULTIPLES } from "../../constants.js";

/** The percent multiplier of a share. */
const PERCENT = 100;

/** The labels of the 4 bars of the reads per search, in the order of `ReadsPerSearch.counts`. */
const READ_BUCKETS = ["0", "1", "2", "3+"];

/** The empty state of a block when the wiki has no search at all (technical/console.md, "Overview"). */
const NO_SEARCH_YET = "No searches yet";

/** The empty state of a block whose span holds no search while the wiki has some. */
const NO_SEARCH_IN_SPAN = "No searches in this span";

// The empty state of a block over the span, by whether the wiki has any search.
const noSearch = (all: number): string => (all === 0 ? NO_SEARCH_YET : NO_SEARCH_IN_SPAN);

const overviewQuery = z.object({ span: z.enum(Span).default(Span.Recent) });

// The share as text, "-" for a divisor of 0.
function percent(n: number, d: number): string {
  return d === 0 ? "-" : `${Math.round((n / d) * PERCENT)}%`;
}

function share(n: number, d: number): string | SafeHtml {
  return d === 0 ? dash() : percent(n, d);
}

/** A cost per write under this many dollars shows 4 decimals, else 2. */
const SMALL_COST_USD = 1;
/** The decimals of a small cost per write, and of any other amount. */
const SMALL_COST_DECIMALS = 4;
const COST_DECIMALS = 2;

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const plural = (n: number): string => count(n, "write", "writes");

function usd(n: number): string {
  return `$${n.toFixed(COST_DECIMALS)}`;
}

function costPerWrite(n: number, d: number): string | SafeHtml {
  if (d === 0) return dash();
  const each = n / d;
  return `$${each.toFixed(each < SMALL_COST_USD ? SMALL_COST_DECIMALS : COST_DECIMALS)}`;
}

/** The labels of the stage x axis, at most this many. */
const STAGE_X_LABELS = 5;

// The smallest of 1, 2, 5, 10, 20, 50, ... that is at least `total / STAGE_X_LABELS`.
function roundStep(total: number): number {
  for (let power = 1; ; power *= NICE_STEP_BASE)
    for (const mult of NICE_STEP_MULTIPLES) if (mult * power * STAGE_X_LABELS >= total) return mult * power;
}

// The positions of the points whose search count is a multiple of the smallest of 1, 2, 5, 10, ... that is at least a fifth of
// the searches that the chart shows (first point to last), so the x axis has 5 labels at most, at round numbers.
function roundLabelIndexes(points: GrowthStretch[]): number[] {
  const shown = (points.at(-1)?.searches ?? 0) - (points[0]?.searches ?? 0) + 1;
  const step = roundStep(shown);
  const indexes: number[] = [];
  points.forEach((p, i) => {
    if (p.searches % step === 0) indexes.push(i);
  });
  return indexes;
}

// A rate, with 2 decimals.
const perSearch = (n: number): string => n.toFixed(DISPLAY_DECIMALS);

function growthBlock(stretches: GrowthStretch[]): SafeHtml {
  const first = stretches[0];
  const last = stretches.at(-1);
  if (first === undefined || last === undefined)
    return panel({ title: "Wiki growth", span: true }, empty(NO_SEARCH_YET));
  const spanSearches = stretches.reduce((sum, p) => sum + p.count, 0);
  const additions = stretches.reduce((sum, p) => sum + p.additions, 0);
  const corrections = stretches.reduce((sum, p) => sum + p.corrections, 0);
  const grown = last.liveFacts - first.liveBefore;
  const stat = stats([
    {
      label: "Live facts",
      value: last.liveFacts,
      under: `${grown >= 0 ? "+" : "-"}${Math.abs(grown)} in the span`,
    },
    {
      label: "Additions per search",
      value: perSearch(additions / spanSearches),
      // The ratio divides by the searches of the span, so the line names that count, not the searches of the wiki so far.
      under: `in ${spanSearches} searches`,
      signal: Signal.AdditionsPerSearch,
      reading: reading({ stage: { searches: spanSearches, additions, corrections } }, InterpretationId.Stage),
    },
    {
      label: "Corrections per search",
      value: perSearch(corrections / spanSearches),
      under: `in ${spanSearches} searches`,
      signal: Signal.CorrectionsPerSearch,
    },
  ]);
  const labels = stretches.map((p) => String(p.searches));
  const labelIndexes = roundLabelIndexes(stretches);
  const tips = stretches.map((p) => {
    const range = p.count === 1 ? `search ${p.searches}` : `searches ${p.searches - p.count + 1} to ${p.searches}`;
    return `${range}\n${count(p.liveFacts, "live fact", "live facts")}\n${perSearch(p.additionsPerSearch)} additions per search\n${perSearch(p.correctionsPerSearch)} corrections per search`;
  });
  const content = grid(GridColumns.MainSide, [
    column([
      plot(
        "Live facts",
        lineChart(labels, [{ name: "live facts", values: stretches.map((p) => p.liveFacts) }], {
          width: CHART_WIDTH.main,
          empty: "No live fact yet.",
          labelIndexes,
          inSlots: true,
          yTitle: "facts",
          tips,
        }),
      ),
      plot(
        "Additions and corrections per search",
        stackedBars(
          labels,
          [
            { name: "additions", values: stretches.map((p) => p.additionsPerSearch) },
            { name: "corrections", values: stretches.map((p) => p.correctionsPerSearch) },
          ],
          {
            width: CHART_WIDTH.main,
            empty: "No change request yet.",
            labelIndexes,
            xTitle: "searches so far",
            yTitle: "per search",
            tips,
          },
        ),
      ),
    ]),
    stat,
  ]);
  return panel({ title: "Wiki growth", span: true }, content);
}

function qualityBlock(store: Store, bounds: SpanBounds, all: number): SafeHtml {
  if (bounds.searches === 0) return panel({ title: "Search quality", span: true }, empty(noSearch(all)));
  const reads = readsPerSearch(store, bounds);
  const misses = searchMisses(store, bounds);
  // The histogram and the no-read stat cover the searches with results and a minted id: a search with no result has nothing
  // to read, and an unminted search (from before the minted ids) cannot link to a read.
  const withResults = reads.searches - reads.noResult - reads.unminted;
  const bars = reads.counts.map((count, i) => ({
    label: READ_BUCKETS[i] ?? String(i),
    value: count,
    detail: `${percent(count, withResults)} of the searches with results and a minted id`,
  }));
  return panel(
    { title: "Search quality", span: true },
    grid(GridColumns.Two, [
      plot(
        "Reads per search",
        histogram(bars, "searches", {
          width: CHART_WIDTH.half,
          empty: NO_SEARCH_IN_SPAN,
          xTitle: "reads after the search",
          yTitle: "searches",
        }),
        Signal.ReadsPerSearch,
      ),
      html`<div class="subsection">
        ${note("Poor searches")}
        ${stats([
          {
            label: "Searches with no result",
            value: share(reads.noResult, reads.searches),
            ...(reads.searches === 0 ? {} : { level: noResultLevel(reads.noResult) }),
            under: `${reads.noResult} of ${count(reads.searches, "search", "searches")}`,
            signal: Signal.NoResultSearches,
          },
          {
            label: "Searches with no read",
            value: share(reads.counts[0], withResults),
            under: `${reads.counts[0]} of ${count(withResults, "search with a minted id", "searches with a minted id")}`,
            signal: Signal.NoReadSearches,
          },
          {
            label: "Facts the search missed",
            value: share(misses.missed, misses.afterSearch),
            ...(misses.afterSearch === 0 ? {} : { level: searchMissLevel(misses.missed, misses.afterSearch) }),
            reading: reading({ misses }, InterpretationId.PoorSearches),
            under: `${misses.missed} of ${count(misses.afterSearch, "change request", "change requests")} after a search`,
            signal: Signal.SearchMisses,
          },
        ])}
      </div>`,
    ]),
  );
}

function costBlock(store: Store, bounds: SpanBounds, prices: PriceTable): SafeHtml {
  const cost = tokenCost(store, bounds, prices);
  if (cost.writes === 0) return panel({ title: "Cost" }, empty("No writes in this span"));
  return panel(
    { title: "Cost" },
    html`${stats([
      {
        label: "Cost per write",
        value: costPerWrite(cost.usd, cost.writes),
        under: `${usd(cost.usd)} over ${plural(cost.writes)}`,
        signal: Signal.CostPerWrite,
      },
      {
        label: "Spent on requests that wrote nothing",
        value: share(cost.wastedUsd, cost.usd),
        under: `${usd(cost.wastedUsd)} of ${usd(cost.usd)}`,
        signal: Signal.CostPerWrite,
      },
    ])}
    ${cost.unpricedCalls > 0 ? note(`${cost.unpricedCalls} calls of a model with no price are counted at $0.`) : ""}`,
  );
}

/**
 * Renders the page "Overview" at `GET /console/w/:w?span=recent|all`.
 *
 * @param ctx - the deps, the wiki in `params.w`, and `span` in the query (default `recent`)
 * @returns the HTML document: 3 blocks over the span, in page order: the search quality, the wiki growth and the
 *   cost; a ratio with a divisor of 0 is a dash
 * @throws {ConsoleError} `NotFound` for an unknown wiki; `ZodError` for a `span` outside the enum
 * @sideEffects one read-only connection, opened and closed; reads the clock once; reads the lock file and signals its
 *   pid with 0 for the status pill
 */
export async function overviewPage(ctx: PageContext): Promise<string> {
  const q = parseQuery(ctx.query, overviewQuery);
  return withWiki(ctx, ({ store, frame }) => {
    const bounds = spanBounds(store, q.span, SPAN_RECENT_SEARCHES);
    const control = segmented("Span", [
      {
        label: `Last ${SPAN_RECENT_SEARCHES} searches`,
        href: hrefWith(ctx.query, { span: Span.Recent }),
        current: q.span === Span.Recent,
      },
      { label: "All", href: hrefWith(ctx.query, { span: Span.All }), current: q.span === Span.All },
    ]);
    const stretches = growthSeries(store, bounds);
    // The "empty" state of a block asks whether the wiki has any search at all, whatever the span.
    const totalSearches = spanBounds(store, Span.All, SPAN_RECENT_SEARCHES).searches;
    return layout(
      {
        ...frame,
        section: ConsoleSection.Overview,
        title: sectionLabel(ConsoleSection.Overview),
        controls: control,
      },
      column([
        qualityBlock(store, bounds, totalSearches),
        growthBlock(stretches),
        costBlock(store, bounds, ctx.deps.prices),
      ]),
    );
  });
}
