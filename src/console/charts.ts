// technical/console.md, "Architecture" and "Charts": a chart is inline SVG that the server draws. Three kinds: a line chart of 1 to 4
// series, stacked bars and a histogram. Every mark carries a `<title>` with its value, the colors come
// from the `.s0` to `.s3` classes of the style sheet, and the script shows the title as a tooltip.
//
// Hand-rolled (code-standard section 5): the 4 kinds are about 200 lines of arithmetic over a viewBox, a chart library
// would need a browser build or a DOM on the server, and technical/console.md, "Architecture" rules both out.
import { html, type HtmlValue, type SafeHtml } from "./html.js";
import { DISPLAY_DECIMALS, HALF } from "../constants.js";

/** One series of a chart: its legend name and one value per label; `null` is a gap (no value that day). */
export interface Series {
  name: string;
  values: (number | null)[];
}

/** One bar of a histogram. */
export interface Bar {
  label: string;
  value: number;
  /** Text after the value in the tooltip, e.g. the share of the total. */
  detail?: string;
}

/**
 * The widths a chart may be drawn at, in viewBox units: the width the column renders at, so the text stays 12 to 13 px
 * (technical/console.md, "Charts"). `full` is a full-width panel, `main` the main column of a 2 to 1 grid, `half` a column of a
 * 2-column grid and `third` a column of a 3-column grid.
 */
export const CHART_WIDTH = { full: 1120, main: 740, half: 560, third: 360 } as const;

/** One of the widths of `CHART_WIDTH`. */
type ChartWidth = (typeof CHART_WIDTH)[keyof typeof CHART_WIDTH];

/** The options every chart takes. */
export interface ChartOptions {
  /** The sentence when every value is 0 or null; defaults to "No data in the window." */
  empty?: string;
  /** The width of the column the chart sits in; defaults to `CHART_WIDTH.half`. */
  width?: ChartWidth;
  /**
   * The tooltip text of each x position of a line or stacked chart, one string per label, with `\n` between lines. A
   * position without one shows its label and every series value.
   */
  tips?: string[];
  /** The positions of a line chart whose label the x axis shows, in place of the evenly spaced ones (e.g. round numbers). */
  labelIndexes?: number[];
  /**
   * True to put each point of a line chart at the center of its slot, as the bars of `stackedBars` sit, in place of spreading
   * the points from the first edge to the last. A line chart stacked over a bar chart with the same labels takes it, so
   * the hours line up (technical/console.md, "Charts").
   */
  inSlots?: boolean;
  /** A horizontal reference line of a line chart: the bar that the values are read against. */
  reference?: ReferenceLine;
  /**
   * Caps the y axis of a line chart at this many times the median of its values (and never under the reference): a value
   * over the top is clipped to the top edge, with a marker and its true value, so one outlier does not flatten the rest
   * (technical/console.md, "Charts", "Capped axis").
   */
  capMultiple?: number;
  /** The title of the x axis, centered under its labels, e.g. "hour". */
  xTitle?: string;
  /** The title of the y axis, rotated at the left, e.g. "calls". */
  yTitle?: string;
}

/** A horizontal line at a value (technical/console.md, "Charts", "Reference line"): not a series, not in the legend. */
interface ReferenceLine {
  /** The y value the line is drawn at. */
  value: number;
  /** The text at the right end of the line, e.g. "100 ms". */
  label: string;
}

/** The width that the bar width cap is stated at, in viewBox units. */
const BASE_WIDTH = CHART_WIDTH.half;
/** The height of the plot area, in viewBox units. */
const PLOT_HEIGHT = 160;
/** Room on the left for the y axis labels, in viewBox units. */
const LEFT = 56;
/** The x of the center of the rotated y axis title, in viewBox units. */
const Y_TITLE_X = 10;
/** Room under the x axis labels for the x axis title, in viewBox units. */
const X_TITLE_ROOM = 18;
/** The baseline of the x axis title, in viewBox units under the labels' room (`BOTTOM`). */
const X_TITLE_Y = 14;
/** Room on the right so the last x label fits, in viewBox units. */
const RIGHT = 12;
/** Room above the plot for the legend, in viewBox units. */
const TOP = 26;
/** Room under the plot for the x axis labels, in viewBox units. */
const BOTTOM = 28;
/** The gap between 2 bars or 2 segments of a stack, in viewBox units; drawn as empty space. */
const GAP = 2;
/** Radius of a point of a line chart, in viewBox units. */
const DOT = 3;
/** The most labels an axis may have for its line chart to draw points; a longer axis draws the lines only. */
export const MAX_POINT_LABELS = 31;
/** The sentence of an empty chart when the caller gives none (technical/console.md, "Pages", L3). */
const DEFAULT_EMPTY = "No data in the window.";
/** What a title shows for a series that has no value at a position. */
const NO_VALUE = "–";
/** Font size of the labels, in viewBox units. */
const FONT = 13;
/** The widest a bar of a vertical bar chart gets inside its slot at `BASE_WIDTH`, in viewBox units; scales with the width. */
const MAX_BAR_WIDTH = 24;
/** The radius of the rounded end of a bar, in viewBox units. */
const BAR_RADIUS = 3;
/** The most series a line chart or a stacked bar chart takes; the style sheet defines that many colors. */
export const MAX_SERIES = 4;
/** How many intervals a dense x axis is split in: the first label, the last and up to 3 between make 5 labels. */
const X_INTERVALS = 4;
/** Horizontal room per legend entry (swatch and name), in viewBox units. */
const LEGEND_STEP = 130;
/** The side of a legend swatch, in viewBox units. */
const SWATCH = 10;
/** The top of a legend swatch, in viewBox units from the top of the drawing. */
const LEGEND_Y = 4;
/** The baseline of a legend name, in viewBox units from the top of the drawing. */
const LEGEND_TEXT_Y = 13;
/** The gap between a legend swatch and its name, in viewBox units. */
const SWATCH_GAP = 4;
/** The gap between the y axis and its labels, and the drop of a label's baseline under its tick, in viewBox units. */
const Y_LABEL_GAP = 4;
/** The gap between the x axis and the top of its labels, in viewBox units. */
const X_LABEL_GAP = 6;
/** The estimated width of one character of an axis label, in viewBox units, for keeping end labels inside. */
const CHAR_WIDTH = 7;
/** The multipliers of a power of 10 that an axis top may take (technical/console.md, "Charts"). */
const NICE_STEPS = [1, 2, 4, 6, 8, 10];
/** A date label as the data gives it. */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** The offset of the `MM-DD` part of a `YYYY-MM-DD` label. */
const DATE_SHORT_FROM = 5;

function seriesClass(i: number): string {
  return `s${i}`;
}

// Formats a value for a label or a title: integers as they are, others with 2 decimals.
function fmt(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(DISPLAY_DECIMALS);
}

/** A coordinate is rounded to 1/COORD_SCALE of a pixel (2 decimals), so that the markup stays short. */
const COORD_SCALE = 100;

// Rounds a coordinate to 2 decimals so the markup stays short.
function pt(v: number): number {
  return Math.round(v * COORD_SCALE) / COORD_SCALE;
}

/** A chart with fewer series than this has no legend. */
const MIN_SERIES_FOR_LEGEND = 2;
/** A chart with fewer labels than this puts its point in the middle instead of spreading the points. */
const MIN_LABELS_TO_SPREAD = 2;

function maxOf(values: (number | null)[]): number {
  let max = 0;
  for (const v of values) if (v !== null && v > max) max = v;
  return max;
}

// The empty rule of technical/console.md, "Charts": a chart whose values are all 0 or null is its empty sentence.
function hasData(values: (number | null)[]): boolean {
  return values.some((v) => v !== null && v !== 0);
}

function emptyChart(text: string | undefined): SafeHtml {
  return html`<p class="empty">${text ?? DEFAULT_EMPTY}</p>`;
}

/** Where the slots of a line or stacked chart sit. */
interface SlotGeometry {
  /** The center of position `i`, in viewBox units. */
  xOf: (i: number) => number;
  /** The width of one slot, in viewBox units. */
  width: number;
  /** The y of the x axis. */
  bottom: number;
  /** The tooltip text of each position, in place of the default; a position without one keeps the default. */
  tips?: string[];
}

const tipsOf = (opts: ChartOptions): Pick<SlotGeometry, "tips"> => (opts.tips === undefined ? {} : { tips: opts.tips });

// One `g.slot` per x position (technical/console.md, "Charts"): the crosshair line, shown on hover by the style sheet, and a transparent
// rect over the whole plot height whose title lists the label and every series value, one per line.
function slots(labels: string[], series: Series[], geo: SlotGeometry, width: ChartWidth): SafeHtml[] {
  const tips = geo.tips ?? [];
  return labels.map((label, i) => {
    const center = geo.xOf(i);
    const x0 = Math.max(LEFT, center - geo.width / HALF);
    const x1 = Math.min(width - RIGHT, center + geo.width / HALF);
    const lines = series.map((s) => {
      const v = s.values[i] ?? null;
      return `${s.name}: ${v === null ? NO_VALUE : fmt(v)}`;
    });
    return html`<g class="slot">
      <line class="cursor" x1="${pt(center)}" y1="${TOP}" x2="${pt(center)}" y2="${geo.bottom}" />
      <rect class="hit" x="${pt(x0)}" y="${TOP}" width="${pt(x1 - x0)}" height="${PLOT_HEIGHT}">
        <title>${tips[i] ?? [label, ...lines].join("\n")}</title>
      </rect>
    </g>`;
  });
}

/** The length of the sample of the reference line that stands before its label, in viewBox units. */
const KEY_LENGTH = 16;
/** The y of the sample of the reference line, level with the middle of the label, in viewBox units from the top. */
const LEGEND_KEY_Y = LEGEND_TEXT_Y - FONT / HALF + 1;

// The reference line of a line chart: a horizontal rule at the value. Its label sits above the plot at the right end, after a
// sample of the rule, where no point can cover it.
function referenceLine(ref: ReferenceLine | undefined, yOf: (v: number) => number, width: ChartWidth): SafeHtml | null {
  if (ref === undefined) return null;
  const y = pt(yOf(ref.value));
  const keyStart = width - RIGHT - ref.label.length * CHAR_WIDTH - KEY_LENGTH - SWATCH_GAP;
  return html`<g class="reference">
    <line x1="${LEFT}" y1="${y}" x2="${width - RIGHT}" y2="${y}" />
    <line x1="${pt(keyStart)}" y1="${LEGEND_KEY_Y}" x2="${pt(keyStart + KEY_LENGTH)}" y2="${LEGEND_KEY_Y}" />
    <text x="${width - RIGHT}" y="${LEGEND_TEXT_Y}" text-anchor="end" font-size="${FONT}">${ref.label}</text>
  </g>`;
}

/**
 * Gives the top of a y axis: the smallest of 1, 2, 4, 6, 8 and 10 times a power of 10 that is at or over the largest
 * value, so the middle label is a whole number too when the top is 2 or more (technical/console.md, "Charts").
 *
 * @param max - the largest value to draw; values under 1 count as 1
 * @returns the axis top
 * @sideEffects none
 */
export function niceTop(max: number): number {
  const m = Math.max(1, max);
  const power = 10 ** Math.floor(Math.log10(m));
  for (const step of NICE_STEPS) if (step * power >= m) return step * power;
  return m;
}

// The titles of the axes (technical/console.md, "Charts"): the x title centered under the axis labels, the y title rotated at the left.
function axisTitles(opts: ChartOptions, width: ChartWidth, bottom: number): SafeHtml | null {
  if (opts.xTitle === undefined && opts.yTitle === undefined) return null;
  const centerX = LEFT + (width - LEFT - RIGHT) / HALF;
  const centerY = (TOP + bottom) / HALF;
  return html`<g class="axis-title">
    ${
      opts.xTitle === undefined
        ? null
        : html`<text
            class="x-title"
            x="${pt(centerX)}"
            y="${bottom + BOTTOM + X_TITLE_Y}"
            text-anchor="middle"
            font-size="${FONT}"
            >${opts.xTitle}</text
          >`
    }
    ${
      opts.yTitle === undefined
        ? null
        : html`<text
            class="y-title"
            transform="translate(${Y_TITLE_X} ${pt(centerY)}) rotate(-90)"
            text-anchor="middle"
            font-size="${FONT}"
            >${opts.yTitle}</text
          >`
    }
  </g>`;
}

// The height of the drawing: the plot, the labels, and the room of the x title when there is one.
const heightOf = (bottom: number, opts: ChartOptions): number =>
  bottom + BOTTOM + (opts.xTitle === undefined ? 0 : X_TITLE_ROOM);

function svg(width: ChartWidth, height: number, body: HtmlValue, label: string): SafeHtml {
  return html`<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${label}">${body}</svg>`;
}

function legend(series: Series[]): SafeHtml | null {
  if (series.length < MIN_SERIES_FOR_LEGEND) return null;
  return html`<g class="legend">
    ${series.map(
      (s, i) =>
        html`<rect
            class="swatch ${seriesClass(i)}"
            x="${LEFT + i * LEGEND_STEP}"
            y="${LEGEND_Y}"
            width="${SWATCH}"
            height="${SWATCH}"
          />
          <text x="${LEFT + i * LEGEND_STEP + SWATCH + SWATCH_GAP}" y="${LEGEND_TEXT_Y}" font-size="${FONT}">
            ${s.name}
          </text>`,
    )}
  </g>`;
}

function yAxis(top: number, bottom: number, width: ChartWidth): SafeHtml {
  const middle = (TOP + bottom) / HALF;
  const right = width - RIGHT;
  return html`<g class="axis">
    <line class="grid" x1="${LEFT}" y1="${TOP}" x2="${right}" y2="${TOP}" />
    <line class="grid" x1="${LEFT}" y1="${middle}" x2="${right}" y2="${middle}" />
    <line x1="${LEFT}" y1="${bottom}" x2="${right}" y2="${bottom}" />
    <text x="${LEFT - Y_LABEL_GAP}" y="${TOP + Y_LABEL_GAP}" text-anchor="end" font-size="${FONT}">${fmt(top)}</text>
    <text x="${LEFT - Y_LABEL_GAP}" y="${middle + Y_LABEL_GAP}" text-anchor="end" font-size="${FONT}">
      ${fmt(top / HALF)}
    </text>
    <text x="${LEFT - Y_LABEL_GAP}" y="${bottom + Y_LABEL_GAP}" text-anchor="end" font-size="${FONT}">0</text>
  </g>`;
}

/**
 * Chooses the labels of a dense x axis: the first, the last, and evenly spaced ones between, five at most. A label
 * within half a step of the last is dropped, so the last 2 never overlap (technical/console.md, "Charts").
 *
 * @param count - how many labels the axis has
 * @returns the indexes to draw, in order; every index when the axis has 5 labels or fewer
 * @sideEffects none
 */
export function shownLabels(count: number): number[] {
  if (count <= 0) return [];
  const last = count - 1;
  const step = Math.max(1, Math.ceil(last / X_INTERVALS));
  const shown = [0];
  for (let i = step; i < last; i += step) if (last - i > step / HALF) shown.push(i);
  if (last > 0) shown.push(last);
  return shown;
}

// A date label shows as MM-DD; any other label shows as it is.
function axisText(label: string): string {
  return DATE_PATTERN.test(label) ? label.slice(DATE_SHORT_FROM) : label;
}

// `shown` is the positions to draw: the evenly spaced ones, or those a page names.
function xLabels(
  labels: string[],
  shown: number[] | undefined,
  xOf: (i: number) => number,
  axis: { bottom: number; width: ChartWidth },
): SafeHtml {
  const { bottom, width } = axis;
  return html`<g class="axis">
    ${(shown ?? shownLabels(labels.length)).map((i) => {
      const text = axisText(labels[i] ?? "");
      const half = (text.length * CHAR_WIDTH) / HALF;
      // A label that would cross the plot edge is anchored to it, so the first and last labels are never cut.
      const x = xOf(i);
      const anchor = x + half > width ? "end" : x - half < LEFT - Y_LABEL_GAP ? "start" : "middle";
      const edge = anchor === "end" ? width - RIGHT : anchor === "start" ? LEFT : x;
      return html`<text x="${pt(edge)}" y="${bottom + FONT + X_LABEL_GAP}" text-anchor="${anchor}" font-size="${FONT}">
        ${text}
      </text>`;
    })}
  </g>`;
}

/** A column of a bar chart: it rises from `base` by `height`, `width` wide from `x`. */
interface Column {
  x: number;
  base: number;
  width: number;
  height: number;
}

// The outline of a column; the top corners are rounded when `rounded`, the base is square.
function columnPath({ x, base, width, height }: Column, rounded: boolean): string {
  const top = base - height;
  const r = rounded ? Math.min(BAR_RADIUS, height, width / HALF) : 0;
  const [x0, x1] = [pt(x), pt(x + width)];
  if (r === 0) return `M${x0},${pt(base)} V${pt(top)} H${x1} V${pt(base)} Z`;
  return (
    `M${x0},${pt(base)} V${pt(top + r)} A${r},${r} 0 0 1 ${pt(x + r)},${pt(top)} H${pt(x + width - r)} ` +
    `A${r},${r} 0 0 1 ${x1},${pt(top + r)} V${pt(base)} Z`
  );
}

// The width of a bar inside a slot of `slot` units: at most MAX_BAR_WIDTH scaled to the chart width, with a GAP to the
// next bar.
function barWidthIn(slot: number, width: ChartWidth): number {
  return Math.max(1, Math.min((MAX_BAR_WIDTH * width) / BASE_WIDTH, slot - GAP));
}

/** The half width of the triangle that marks a clipped value, in viewBox units. */
const CLIP_HALF = 5;
/** The gap between the triangle of a clipped value and its text, in viewBox units. */
const CLIP_GAP = 8;

// The median of the non-null values of the series; 0 with none.
function medianOf(series: Series[]): number {
  const all = series
    .flatMap((s) => s.values)
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b);
  if (all.length === 0) return 0;
  const mid = Math.floor(all.length / HALF);
  return all.length % HALF === 1 ? (all[mid] ?? 0) : ((all[mid - 1] ?? 0) + (all[mid] ?? 0)) / HALF;
}

/** The space on each side of the text in the box of a clipped label, in viewBox units. */
const CLIP_BOX_PAD = 4;
/** The half width of the box of the triangle of a clipped value: its half width plus the space, in viewBox units. */
const TRIANGLE_BOX = CLIP_HALF + CLIP_BOX_PAD;

/** A clipped value: its triangle, its label, the box of the label and the row that the label takes. */
interface ClippedLabel {
  series: number;
  x: number;
  textX: number;
  text: string;
  left: boolean;
  // The horizontal extent of the box of the label, in viewBox units.
  from: number;
  to: number;
  row: number;
}

// The labels of the values over the top, left to right. Each takes the first row, counted down from the top edge, in
// which its box touches no box already placed (technical/console.md, "Capped axis").
function clippedLabels(series: Series[], top: number, xOf: (i: number) => number, width: ChartWidth): ClippedLabel[] {
  const found = series.flatMap((s, si) =>
    s.values.flatMap((v, i): ClippedLabel[] => {
      if (v === null || v <= top) return [];
      const x = pt(xOf(i));
      const left = x > width / HALF;
      const text = fmt(v);
      const textX = pt(left ? x - CLIP_GAP : x + CLIP_GAP);
      const span = text.length * CHAR_WIDTH;
      const from = (left ? textX - span : textX) - CLIP_BOX_PAD;
      const to = (left ? textX : textX + span) + CLIP_BOX_PAD;
      return [{ series: si, x, textX, text, left, from, to, row: 0 }];
    }),
  );
  found.sort((a, b) => a.x - b.x);
  const placed: ClippedLabel[] = [];
  for (const label of found) {
    const touches = (row: number): boolean =>
      placed.some((p) => p.row === row && p.from <= label.to && label.from <= p.to) ||
      (row === 0 &&
        found.some((o) => o !== label && o.x - TRIANGLE_BOX <= label.to && label.from <= o.x + TRIANGLE_BOX));
    while (touches(label.row)) label.row += 1;
    placed.push(label);
  }
  return placed;
}

// The marker of each value over the top of a capped axis: a triangle on the top edge and the true value beside it.
function clippedMarks(series: Series[], top: number, xOf: (i: number) => number, width: ChartWidth): SafeHtml[] {
  return clippedLabels(series, top, xOf, width).map(
    (c) =>
      html`<g class="clipped ${seriesClass(c.series)}">
        <path
          d="M${c.x - CLIP_HALF},${TOP + CLIP_HALF + 1} L${c.x},${TOP - 1} L${c.x + CLIP_HALF},${TOP + CLIP_HALF + 1} Z"
        />
        <text
          x="${c.textX}"
          y="${TOP + CLIP_HALF + c.row * FONT}"
          text-anchor="${c.left ? "end" : "start"}"
          font-size="${FONT}"
          >${c.text}</text
        >
      </g>`,
  );
}

/**
 * Draws a line chart of 1 to 4 series over the same labels.
 *
 * @param labels - the x axis, one label per point; a `YYYY-MM-DD` label shows as `MM-DD`
 * @param series - the series, every one with `labels.length` values; a `null` value breaks the line
 * @param opts - the empty sentence (defaults to "No data in the window."), the width (defaults to `half`), the tooltip
 *   text of each position and a reference line, which the axis top covers
 * @returns the SVG; a legend when there are 2 or more series; points when the axis has `MAX_POINT_LABELS` labels or
 *   fewer; a `g.slot` per label whose hit rect carries the tooltip title. A `p.empty` when every value is 0 or null.
 * @throws {Error} when there are no series or more than `MAX_SERIES`
 * @sideEffects none
 */
export function lineChart(labels: string[], series: Series[], opts: ChartOptions = {}): SafeHtml {
  if (series.length === 0 || series.length > MAX_SERIES)
    throw new Error(`a line chart takes 1 to ${MAX_SERIES} series`);
  if (!series.some((s) => hasData(s.values))) return emptyChart(opts.empty);
  const width = opts.width ?? CHART_WIDTH.half;
  const bottom = TOP + PLOT_HEIGHT;
  const top = niceTop(
    Math.max(
      opts.reference?.value ?? 0,
      opts.capMultiple === undefined
        ? Math.max(...series.map((s) => maxOf(s.values)))
        : opts.capMultiple * medianOf(series),
    ),
  );
  const span = width - LEFT - RIGHT;
  const slotSpan = span / Math.max(1, labels.length);
  const xOf = (i: number): number =>
    opts.inSlots === true
      ? LEFT + i * slotSpan + slotSpan / HALF
      : LEFT + (labels.length < MIN_LABELS_TO_SPREAD ? span / HALF : (i * span) / (labels.length - 1));
  const yOf = (v: number): number => bottom - (Math.min(v, top) / top) * PLOT_HEIGHT;
  const lines = series.map((s, si) => {
    let d = "";
    let pen = false;
    s.values.forEach((v, i) => {
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${pt(xOf(i))},${pt(yOf(v))} `;
      pen = true;
    });
    const dots =
      labels.length > MAX_POINT_LABELS
        ? null
        : s.values.map((v, i) =>
            v === null
              ? null
              : html`<circle class="point ${seriesClass(si)}" cx="${pt(xOf(i))}" cy="${pt(yOf(v))}" r="${DOT}" />`,
          );
    return html`<path class="line ${seriesClass(si)}" d="${d.trim()}" /> ${dots}`;
  });
  const slotWidth = opts.inSlots === true ? slotSpan : labels.length < 2 ? span : span / (labels.length - 1);
  return svg(
    width,
    heightOf(bottom, opts),
    html`${legend(series)} ${yAxis(top, bottom, width)} ${xLabels(labels, opts.labelIndexes, xOf, { bottom, width })}
    ${axisTitles(opts, width, bottom)} ${lines} ${referenceLine(opts.reference, yOf, width)}
    ${clippedMarks(series, top, xOf, width)}
    ${slots(labels, series, { xOf, width: slotWidth, bottom, ...tipsOf(opts) }, width)}`,
    series.map((s) => s.name).join(", "),
  );
}

/**
 * Draws stacked bars: one bar per label, one segment per series. A bar is at most 24 units wide at the `half` width
 * (scaled with the width), a 2 unit gap separates the segments of a stack and adjacent bars, and only the top of a
 * stack is rounded.
 *
 * @param labels - the x axis, one label per bar; a `YYYY-MM-DD` label shows as `MM-DD`
 * @param series - the series, every one with `labels.length` values; a `null` value counts as 0
 * @param opts - the empty sentence (defaults to "No data in the window.") and the width (defaults to `half`)
 * @returns the SVG; a legend when there are 2 or more series; a `g.slot` per label whose hit rect carries the tooltip
 *   title. A `p.empty` when every value is 0 or null.
 * @throws {Error} when there are no series or more than `MAX_SERIES`
 * @sideEffects none
 */
export function stackedBars(labels: string[], series: Series[], opts: ChartOptions = {}): SafeHtml {
  if (series.length === 0 || series.length > MAX_SERIES) throw new Error(`a bar chart takes 1 to ${MAX_SERIES} series`);
  if (!series.some((s) => hasData(s.values))) return emptyChart(opts.empty);
  const width = opts.width ?? CHART_WIDTH.half;
  const bottom = TOP + PLOT_HEIGHT;
  const totals = labels.map((_, i) => series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0));
  const top = niceTop(Math.max(...totals));
  const span = width - LEFT - RIGHT;
  const slot = span / Math.max(1, labels.length);
  const barWidth = barWidthIn(slot, width);
  const xOf = (i: number): number => LEFT + i * slot + slot / HALF;
  const bars = labels.map((_, i) => {
    // The last non-zero segment is the top of the stack; the first one sits on the baseline.
    const present = series.map((s) => s.values[i] ?? 0);
    const baseIndex = present.findIndex((v) => v > 0);
    const topIndex = present.reduce((last, v, k) => (v > 0 ? k : last), -1);
    let edge = bottom;
    return series.map((s, si) => {
      const v = present[si] ?? 0;
      const h = (v / top) * PLOT_HEIGHT;
      const segmentBase = edge;
      edge -= h;
      if (v === 0) return null;
      // The gap sits under a segment that rests on another one, so the top of each segment is where its value ends.
      const lift = si === baseIndex ? 0 : GAP;
      const column = {
        x: xOf(i) - barWidth / HALF,
        base: segmentBase - lift,
        width: barWidth,
        height: Math.max(1, h - lift),
      };
      const d = columnPath(column, si === topIndex);
      return html`<path class="bar ${seriesClass(si)}" d="${d}" />`;
    });
  });
  return svg(
    width,
    heightOf(bottom, opts),
    html`${legend(series)} ${yAxis(top, bottom, width)} ${xLabels(labels, opts.labelIndexes, xOf, { bottom, width })}
    ${axisTitles(opts, width, bottom)} ${bars}
    ${slots(labels, series, { xOf, width: slot, bottom, ...tipsOf(opts) }, width)}`,
    series.map((s) => s.name).join(", "),
  );
}

/**
 * Draws a histogram: one vertical bar per bucket, every label shown.
 *
 * @param bars - the buckets in order
 * @param name - what the bars count, for the titles and the accessible name
 * @param opts - the empty sentence (defaults to "No data in the window.") and the width (defaults to `half`)
 * @returns the SVG; a `<title>` with the value on every bar; a `p.empty` when `bars` is empty or all 0
 * @sideEffects none
 */
export function histogram(bars: Bar[], name: string, opts: ChartOptions = {}): SafeHtml {
  if (!hasData(bars.map((b) => b.value))) return emptyChart(opts.empty);
  const width = opts.width ?? CHART_WIDTH.half;
  const bottom = TOP + PLOT_HEIGHT;
  const top = niceTop(Math.max(0, ...bars.map((b) => b.value)));
  const span = width - LEFT - RIGHT;
  const slot = span / Math.max(1, bars.length);
  const barWidth = barWidthIn(slot, width);
  const marks = bars.map((b, i) => {
    const h = (b.value / top) * PLOT_HEIGHT;
    const x = LEFT + i * slot + slot / HALF;
    return html`<path
      class="bar s0"
      d="${columnPath({ x: x - barWidth / HALF, base: bottom, width: barWidth, height: h }, true)}"
    >
      <title>${name}, ${b.label}: ${fmt(b.value)}${b.detail === undefined ? "" : `, ${b.detail}`}</title>
    </path>`;
  });
  // Every bucket keeps its label: the axis of a histogram is its buckets.
  const ticks = bars.map(
    (b, i) =>
      html`<text
        x="${pt(LEFT + i * slot + slot / HALF)}"
        y="${bottom + FONT + X_LABEL_GAP}"
        text-anchor="middle"
        font-size="${FONT}"
      >
        ${axisText(b.label)}
      </text>`,
  );
  return svg(
    width,
    heightOf(bottom, opts),
    html`${yAxis(top, bottom, width)} ${marks} <g class="axis">${ticks}</g> ${axisTitles(opts, width, bottom)}`,
    name,
  );
}
