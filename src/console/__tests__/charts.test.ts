import { describe, expect, it } from "vitest";
import {
  CHART_WIDTH,
  MAX_POINT_LABELS,
  MAX_SERIES,
  histogram,
  lineChart,
  niceTop,
  shownLabels,
  stackedBars,
} from "../charts.js";
import type { SafeHtml } from "../html.js";
import { parse, squash, type Page } from "./helpers/dom.js";

/**
 * Parses a drawing, to read its text labels, its hover titles and its marks.
 *
 * @param chart - what a chart function returns
 * @returns the parsed drawing
 */
function draw(chart: SafeHtml): Page {
  return parse(chart);
}

const texts = (p: Page): string[] => p.$$("svg text").map((e) => squash(e.textContent));
const titles = (p: Page): string[] => p.$$("svg title").map((e) => e.textContent ?? "");
const width = (p: Page): number => Number(p.$("svg")?.getAttribute("viewBox")?.split(" ")[2]);

describe("niceTop", () => {
  it("takes the smallest of 1, 2, 4, 6, 8, 10 times a power of 10 at or over the value", () => {
    expect([0, 1, 1.5, 2, 3, 5, 7, 9, 10, 11, 37, 101, 700].map(niceTop)).toEqual([
      1, 1, 2, 2, 4, 6, 8, 10, 10, 20, 40, 200, 800,
    ]);
  });
});

describe("shownLabels", () => {
  it("shows every label of a short axis", () => {
    expect(shownLabels(5)).toEqual([0, 1, 2, 3, 4]);
    expect(shownLabels(1)).toEqual([0]);
    expect(shownLabels(0)).toEqual([]);
  });

  it("shows the first, the last and up to 3 between on a dense axis", () => {
    expect(shownLabels(30)).toEqual([0, 8, 16, 24, 29]);
  });

  it("drops a label within half a step of the last", () => {
    // 6 labels: step 2, so index 4 is 1 from the last (half a step) and goes.
    expect(shownLabels(6)).toEqual([0, 2, 5]);
  });
});

describe("axis titles", () => {
  const title = (p: Page, which: string): Element | null => p.$(`svg g.axis-title text.${which}`);

  it("draws the x title centered under the labels and the y title rotated, on every kind of chart", () => {
    const opts = { xTitle: "hour", yTitle: "calls" };
    const charts = [
      lineChart(["a", "b"], [{ name: "x", values: [1, 3] }], opts),
      stackedBars(["a", "b"], [{ name: "x", values: [1, 3] }], opts),
      histogram([{ label: "0", value: 2 }], "searches", opts),
    ];
    for (const chart of charts) {
      const p = draw(chart);
      expect(squash(title(p, "x-title")?.textContent)).toBe("hour");
      expect(squash(title(p, "y-title")?.textContent)).toBe("calls");
      expect(title(p, "x-title")?.getAttribute("text-anchor")).toBe("middle");
      expect(title(p, "y-title")?.getAttribute("transform")).toContain("rotate(-90)");
    }
  });

  it("draws no title and keeps the height when the options give none", () => {
    const plain = draw(lineChart(["a", "b"], [{ name: "x", values: [1, 3] }]));
    const titled = draw(lineChart(["a", "b"], [{ name: "x", values: [1, 3] }], { xTitle: "hour" }));
    expect(plain.$("g.axis-title")).toBeNull();
    const height = (p: Page): number => Number(p.$("svg")?.getAttribute("viewBox")?.split(" ")[3]);
    expect(height(titled)).toBeGreaterThan(height(plain));
  });
});

describe("lineChart", () => {
  it("draws one point per value, a legend for 2 series, and a gap for null", () => {
    const p = draw(
      lineChart(
        ["d1", "d2", "d3"],
        [
          { name: "facts", values: [1, 2, 4] },
          { name: "tags", values: [1, null, 2] },
        ],
      ),
    );
    expect(texts(p)).toEqual(expect.arrayContaining(["facts", "tags"]));
    expect(p.$$("svg circle")).toHaveLength(5);
    expect(texts(p)).toContain("4");
  });

  it("puts a nice number at the top of the axis and a whole number in the middle", () => {
    const labels = texts(draw(lineChart(["a", "b"], [{ name: "x", values: [1, 37] }])));
    expect(labels).toEqual(expect.arrayContaining(["0", "20", "40"]));
  });

  it("shows a date label as MM-DD and drops the label next to the last", () => {
    const dates = Array.from({ length: 6 }, (_, i) => `2026-10-0${i + 1}`);
    const labels = texts(draw(lineChart(dates, [{ name: "x", values: [1, 2, 3, 4, 5, 6] }])));
    expect(labels).toEqual(expect.arrayContaining(["10-01", "10-06"]));
    expect(labels).not.toContain("10-05");
    expect(labels.filter((t) => t.includes("2026-"))).toEqual([]);
  });

  it("anchors the first label to the start and the last to the end so neither is cut", () => {
    const p = draw(lineChart(["2026-10-01", "2026-10-02", "2026-10-13"], [{ name: "x", values: [1, 2, 3] }]));
    const anchor = (label: string): string | null | undefined =>
      p
        .$$("svg text")
        .find((e) => squash(e.textContent) === label)
        ?.getAttribute("text-anchor");
    expect(anchor("10-01")).toBe("start");
    expect(anchor("10-13")).toBe("end");
  });

  it("has no legend for 1 series and refuses more than the color classes", () => {
    expect(texts(draw(lineChart(["a"], [{ name: "only", values: [3] }])))).not.toContain("only");
    const many = Array.from({ length: MAX_SERIES + 1 }, (_, i) => ({ name: `s${i}`, values: [1] }));
    expect(() => lineChart(["a"], many)).toThrow();
  });

  it("escapes the labels", () => {
    const p = draw(lineChart(["<b>"], [{ name: "x", values: [1] }]));
    expect(texts(p)).toContain("<b>");
    expect(p.$("svg b")).toBeNull();
  });

  it("draws a slot per label whose hit title lists the label and one line per series, with a dash for null", () => {
    const p = draw(
      lineChart(
        ["d1", "d2"],
        [
          { name: "facts", values: [1, 4] },
          { name: "tags", values: [null, 2] },
        ],
      ),
    );
    expect(titles(p)).toEqual(expect.arrayContaining(["d1\nfacts: 1\ntags: –", "d2\nfacts: 4\ntags: 2"]));
  });

  it("draws points up to MAX_POINT_LABELS labels and lines only beyond", () => {
    const at = (n: number): Page =>
      draw(
        lineChart(
          Array.from({ length: n }, (_, i) => `l${i}`),
          [{ name: "x", values: Array.from({ length: n }, () => 1) }],
        ),
      );
    expect(at(MAX_POINT_LABELS).$$("svg circle")).toHaveLength(MAX_POINT_LABELS);
    expect(at(MAX_POINT_LABELS + 1).$$("svg circle")).toHaveLength(0);
  });

  it("is the empty sentence when every value is 0 or null, with the given text or the default", () => {
    const series = [{ name: "x", values: [0, null] }];
    const none = draw(lineChart(["a", "b"], series));
    expect(none.$("svg")).toBeNull();
    expect(none.text).not.toBe("");
    const given = draw(lineChart(["a", "b"], series, { empty: "No write in the window." }));
    expect(given.text).toBe("No write in the window.");
    expect(given.$("svg")).toBeNull();
  });
});

describe("stackedBars", () => {
  // The width of a bar: the span of its path from the left edge to the right edge.
  const barWidths = (p: Page): number[] =>
    p.$$("svg path").map((path) => {
      const xs = [...(path.getAttribute("d") ?? "").matchAll(/[MH]([\d.]+)/g)].map((m) => Number(m[1]));
      return Math.max(...xs) - Math.min(...xs);
    });

  it("draws one segment per non-zero value and a slot per label with every series in its title", () => {
    const p = draw(
      stackedBars(
        ["mon", "tue"],
        [
          { name: "accepted", values: [2, 0] },
          { name: "rejected", values: [1, 3] },
        ],
      ),
    );
    expect(p.$$("svg path")).toHaveLength(3);
    expect(titles(p)).toEqual(
      expect.arrayContaining(["mon\naccepted: 2\nrejected: 1", "tue\naccepted: 0\nrejected: 3"]),
    );
    expect(texts(p)).toEqual(expect.arrayContaining(["accepted", "rejected"]));
  });

  it("is the empty sentence when every value is 0", () => {
    const p = draw(stackedBars(["a"], [{ name: "x", values: [0] }], { empty: "No write." }));
    expect(p.text).toBe("No write.");
    expect(p.$("svg")).toBeNull();
  });

  it("keeps a bar at most 24 units wide", () => {
    for (const w of barWidths(draw(stackedBars(["a", "b"], [{ name: "x", values: [1, 2] }])))) {
      expect(w).toBeLessThanOrEqual(24);
    }
  });

  it("scales the bar width cap with the chart width: 24 units at half, 48 at full, in proportion at third", () => {
    // The path of a rounded bar starts at the left edge and ends its last arc on the right edge.
    const barWidth = (w: (typeof CHART_WIDTH)[keyof typeof CHART_WIDTH]): number => {
      const d = draw(stackedBars(["a", "b"], [{ name: "x", values: [1, 2] }], { width: w })).$("svg path");
      const path = d?.getAttribute("d") ?? "";
      const left = Number(/^M([\d.]+),/.exec(path)?.[1]);
      const right = Number(/A[\d.]+,[\d.]+ 0 0 1 ([\d.]+),[\d.]+ V[\d.]+ Z$/.exec(path)?.[1]);
      return right - left;
    };
    expect(barWidth(CHART_WIDTH.half)).toBeCloseTo(24, 1);
    expect(barWidth(CHART_WIDTH.full)).toBeCloseTo(48, 1);
    expect(barWidth(CHART_WIDTH.third)).toBeCloseTo((24 * CHART_WIDTH.third) / CHART_WIDTH.half, 1);
  });
});

describe("histogram", () => {
  it("shows every label and value", () => {
    const p = draw(
      histogram(
        [
          { label: "0.0", value: 2 },
          { label: "0.1", value: 0 },
        ],
        "live facts",
      ),
    );
    expect(titles(p)).toEqual(expect.arrayContaining(["live facts, 0.0: 2", "live facts, 0.1: 0"]));
    expect(texts(p)).toContain("0.1");
  });

  it("is the empty sentence when every bucket is 0", () => {
    const p = draw(histogram([{ label: "0.0", value: 0 }], "live facts"));
    expect(p.$("svg")).toBeNull();
    expect(p.text).not.toBe("");
  });
});

describe("the reference line of a line chart", () => {
  // The line is a `g.reference` that the style sheet selects on (technical/console.md, "Charts"). The rule lies inside the
  // plot, at or under the top grid line; its sample lies above the plot, in the legend row.
  const series = [{ name: "p95", values: [40, 60] }];
  const num = (el: Element | undefined, attr: string): number => Number(el?.getAttribute(attr));
  const plotTop = (p: Page): number => num(p.$$("svg g.axis line.grid")[0], "y1");
  const rules = (p: Page): Element[] => p.$$("svg g.reference line").filter((l) => num(l, "y1") >= plotTop(p));
  const samples = (p: Page): Element[] => p.$$("svg g.reference line").filter((l) => num(l, "y1") < plotTop(p));

  it("draws a rule across the plot and a sample above it, and it is not a series: no legend entry, no hover title", () => {
    const p = draw(lineChart(["a", "b"], series, { reference: { value: 100, label: "100 ms" } }));
    const grid = p.$$("svg g.axis line.grid")[0];
    expect(rules(p)).toHaveLength(1);
    expect(num(rules(p)[0], "x1")).toBe(num(grid, "x1"));
    expect(num(rules(p)[0], "x2")).toBe(num(grid, "x2"));
    expect(samples(p)).toHaveLength(1);
    expect(texts(p)).toContain("100 ms");
    expect(p.$$("svg g.legend")).toHaveLength(0);
    expect(titles(p).every((t) => !t.includes("100 ms"))).toBe(true);
  });

  it("puts the label above the plot, so no point can cover it", () => {
    // The largest value is over the reference, so the top of the axis is over it too (200): a label put at the reference
    // would lie inside the plot.
    const high = [{ name: "p95", values: [40, 160] }];
    const p = draw(lineChart(["a", "b"], high, { reference: { value: 100, label: "100 ms" } }));
    const label = p.$$("svg g.reference text").find((t) => t.textContent?.trim() === "100 ms");
    expect(num(label, "y")).toBeLessThan(plotTop(p));
  });

  it("raises the top of the axis to hold a reference over every value", () => {
    const plain = texts(draw(lineChart(["a", "b"], series)));
    const withBar = texts(draw(lineChart(["a", "b"], series, { reference: { value: 100, label: "bar" } })));
    expect(plain).toContain("60");
    expect(withBar).toContain("100");
  });

  it("is the empty sentence when the series are empty, even with a reference", () => {
    const p = draw(lineChart(["a"], [{ name: "x", values: [null] }], { reference: { value: 100, label: "bar" } }));
    expect(p.$("svg")).toBeNull();
  });
});

describe("the capped axis of a line chart", () => {
  const labels = ["a", "b", "c", "d", "e"];
  const slow = [{ name: "p95", values: [90, 110, 9000, 100, 100] }];
  const opts = { capMultiple: 2, reference: { value: 100, label: "100 ms" } };

  it("tops the axis at the cap, not at the outlier, and marks the clipped value with its true value", () => {
    const p = draw(lineChart(labels, slow, opts));
    expect(texts(p)).toContain("200");
    expect(texts(p)).not.toContain("10000");
    expect(p.$$("svg g.clipped")).toHaveLength(1);
    expect(p.$$("svg g.clipped text").map((t) => t.textContent?.trim())).toEqual(["9000"]);
    expect(titles(p).some((t) => t.includes("p95: 9000"))).toBe(true);
  });

  it("draws the normal points in the plot, away from the axis", () => {
    const p = draw(lineChart(labels, slow, opts));
    const ys = p.$$("svg circle.point").map((c) => Number(c.getAttribute("cy")));
    // y grows downward. The clipped point is the highest, on the top grid line; the 110 ms point is over the 100 ms
    // reference line, and well away from the x axis (more than the height of the 100 ms band is under it).
    const num = (el: Element | undefined, attr: string): number => Number(el?.getAttribute(attr));
    const topY = num(p.$$("svg g.axis line.grid")[0], "y1");
    const axisY = num(p.$$("svg g.axis line:not(.grid)")[0], "y1");
    const refY = num(
      p.$$("svg g.reference line").find((l) => num(l, "y1") >= topY),
      "y1",
    );
    expect(ys[2]).toBe(topY);
    expect(ys[1]).toBeLessThan(refY);
    expect(refY).toBeLessThan(axisY);
    expect(axisY - (ys[1] ?? 0)).toBeGreaterThan((axisY - topY) / 3);
  });

  describe("the rows of the value labels", () => {
    const many = Array.from({ length: 20 }, (_, i) => `d${i}`);
    // The distinct y values of the labels, top row first, and the y of each label in the order of the points.
    const rowsOf = (clips: Record<number, number>): { rows: number[]; ys: number[] } => {
      const values = many.map((_, i) => clips[i] ?? 100);
      const p = draw(lineChart(many, [{ name: "p95", values }], { capMultiple: 2 }));
      const ys = p.$$("svg g.clipped text").map((t) => Number(t.getAttribute("y")));
      return { rows: [...new Set(ys)].sort((a, b) => a - b), ys };
    };

    it("puts 2 clipped hours next to each other in 2 rows", () => {
      expect(rowsOf({ 3: 9000, 4: 8000 }).rows).toHaveLength(2);
    });

    it("puts 3 clipped hours next to each other in 3 rows, or in 2 when the first and the third do not touch", () => {
      const { rows, ys } = rowsOf({ 3: 9000, 4: 8000, 5: 7000 });
      expect(rows.length).toBeGreaterThanOrEqual(2);
      expect(rows.length).toBeLessThanOrEqual(3);
      expect(ys[1]).not.toBe(ys[0]);
      expect(ys[2]).not.toBe(ys[1]);
    });

    it("moves a label that would cover the triangle of the next clipped hour to the row below it", () => {
      const { ys } = rowsOf({ 3: 9000, 4: 8000 });
      // The label of hour 3 reaches over the triangle of hour 4, so hour 4 keeps row 0 and hour 3 goes down.
      expect(ys[0]).toBeGreaterThan(ys[1] ?? 0);
    });

    it("shares row 0 between 2 clipped hours far apart", () => {
      expect(rowsOf({ 1: 9000, 8: 8000 }).rows).toHaveLength(1);
    });
  });

  it("draws no marker when no value is over the cap", () => {
    const p = draw(lineChart(["a", "b"], [{ name: "p95", values: [40, 60] }], opts));
    expect(p.$$("svg g.clipped")).toHaveLength(0);
  });
});

describe("a line chart over a bar chart", () => {
  const labels = Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, "0")}:00`);
  const values = labels.map((_, i) => i + 1);
  const xs = (p: Page, selector: string): string[] => p.$$(selector).map((e) => e.getAttribute("x") ?? "");

  it("puts its hit slots and its axis labels at the x positions of the bars when inSlots is set", () => {
    const opts = { width: CHART_WIDTH.half, xTitle: "hour", yTitle: "n" };
    const bars = draw(stackedBars(labels, [{ name: "a", values }], opts));
    const line = draw(lineChart(labels, [{ name: "a", values }], { ...opts, inSlots: true }));
    expect(xs(line, "svg g.axis text")).toEqual(xs(bars, "svg g.axis text"));
    expect(xs(line, "svg rect.hit")).toEqual(xs(bars, "svg rect.hit"));
    const centers = (p: Page): string[] => p.$$("svg line.cursor").map((e) => e.getAttribute("x1") ?? "");
    expect(centers(line)).toEqual(centers(bars));
  });

  it("spreads its points from the first edge to the last without it", () => {
    const line = draw(lineChart(labels, [{ name: "a", values }], { width: CHART_WIDTH.half }));
    const bars = draw(stackedBars(labels, [{ name: "a", values }], { width: CHART_WIDTH.half }));
    const centers = (p: Page): string[] => p.$$("svg line.cursor").map((e) => e.getAttribute("x1") ?? "");
    expect(centers(line)).not.toEqual(centers(bars));
  });
});

describe("the tooltip text of a position", () => {
  it("replaces the default of a line chart and a stacked chart, and leaves a position with none as it was", () => {
    const series = [{ name: "x", values: [1, 2] }];
    const line = draw(lineChart(["a", "b"], series, { tips: ["first\nsecond"] }));
    expect(titles(line)).toEqual(["first\nsecond", "b\nx: 2"]);
    const stack = draw(stackedBars(["a", "b"], series, { tips: ["first\nsecond"] }));
    expect(titles(stack)).toEqual(expect.arrayContaining(["first\nsecond", "b\nx: 2"]));
  });
});

describe("the detail of a histogram bar", () => {
  it("follows the value in the tooltip", () => {
    const p = draw(histogram([{ label: "3+", value: 4, detail: "20% of the searches" }], "searches"));
    expect(titles(p)).toEqual(["searches, 3+: 4, 20% of the searches"]);
  });
});

describe("chart width", () => {
  it("sets the viewBox of every chart kind to the width given, half by default", () => {
    const series = [{ name: "x", values: [1, 2] }];
    const bars = [{ label: "a", value: 1 }];
    for (const [name, w] of Object.entries(CHART_WIDTH)) {
      expect(width(draw(lineChart(["a", "b"], series, { width: w }))), name).toBe(w);
      expect(width(draw(stackedBars(["a", "b"], series, { width: w }))), name).toBe(w);
      expect(width(draw(histogram(bars, "x", { width: w }))), name).toBe(w);
    }
    expect(width(draw(lineChart(["a", "b"], series)))).toBe(CHART_WIDTH.half);
  });

  it("stretches the plot to the right edge of the width", () => {
    const series = [{ name: "x", values: [1, 2] }];
    const right = (w: (typeof CHART_WIDTH)[keyof typeof CHART_WIDTH]): number =>
      Math.max(
        ...draw(lineChart(["a", "b"], series, { width: w }))
          .$$("svg line")
          .map((l) => Number(l.getAttribute("x2"))),
      );
    expect(right(CHART_WIDTH.third)).toBeLessThan(right(CHART_WIDTH.half));
    expect(right(CHART_WIDTH.half)).toBeLessThan(right(CHART_WIDTH.full));
    expect(right(CHART_WIDTH.full)).toBeLessThanOrEqual(CHART_WIDTH.full);
  });
});
