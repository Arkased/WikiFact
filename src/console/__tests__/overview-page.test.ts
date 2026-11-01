import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { ChangeOutcome, InterpretationId, Signal, SearchHitKind, enumValues } from "../../domain/enums.js";
import {
  enqueueRequest,
  growthSeries,
  finishRequest,
  openSession,
  recordModelCall,
  recordRetrieval,
  recordSearch,
  seedChange,
} from "../../store/index.js";
import { T0, accepted, draft } from "../../../__tests__/helpers/store.js";
import { INTERPRETATIONS } from "../interpretations.js";
import { overviewPage } from "../pages/overview.js";
import { SIGNAL_DEFINITIONS, SPAN_RECENT_SEARCHES } from "../signals.js";
import { queryOf, parse, squash, type Page } from "./helpers/dom.js";
import { openTmpWiki, type TmpWiki } from "./helpers/tmp-wiki.js";

/** The searches of each half of the seeded wiki (it has 2 halves of this size). */
const G = 50;

/** The digits of a seeded search id, so that the ids sort in time order. */
const SEARCH_ID_DIGITS = 5;

// The numbers of a tooltip of a stretch: its range of searches, the live facts and the 2 rates.
function tipLines(tip: string | undefined): { range: string; live: number; additions: number; corrections: number } {
  const [range = "", live = "", additions = "", corrections = ""] = (tip ?? "").split("\n");
  return {
    range,
    live: Number.parseInt(live, 10),
    additions: Number.parseFloat(additions),
    corrections: Number.parseFloat(corrections),
  };
}

let w: TmpWiki;
beforeEach(() => {
  w = openTmpWiki();
});
afterEach(() => w.close());

async function open(query = ""): Promise<Page> {
  return parse(await overviewPage(w.ctx({}, query)));
}

// The time of search `i`, counted from 0; every request and session of a test lies around these.
const S0 = T0 + 1000;
const at = (i: number): number => S0 + i * 10;

function addSearch(i: number, sessionId: string | null, results: { targetId: string }[] = []): void {
  recordSearch(w.store, {
    id: `search-${i}`,
    sessionId,
    query: "q",
    at: at(i),
    durationMs: 1,
    results: results.map((r, rank) => ({
      kind: SearchHitKind.Fact,
      targetId: r.targetId,
      rank: rank + 1,
      ref: `search-${i}:${r.targetId}`,
    })),
  });
}

function addCalls(requestId: string, tokensIn: number): void {
  recordModelCall(w.store, {
    requestId,
    question: "Q1",
    model: "m",
    effort: "low",
    tokensIn,
    tokensOut: 0,
    tokensCacheRead: 0,
    tokensCacheWrite: 0,
    durationMs: 1,
    at: T0,
  });
}

// 2 groups of searches by the session s1 (the session s2 has none); 2 writes in the first group, 1 duplicate of the fact B,
// which no search lists, in the second; the first search lists the fact A, which is read twice, and 1 more read has no session.
async function seedUse(): Promise<void> {
  openSession(w.store, { id: "s1", startedAt: T0 + 500 });
  openSession(w.store, { id: "s2", startedAt: T0 + 500 });
  const a = await seedChange(w.store, accepted([draft({ header: "A" })]), { now: at(0) + 5, sessionId: "s1" });
  const b = await seedChange(w.store, accepted([draft({ header: "B" })]), { now: at(0) + 6, sessionId: "s1" });
  const factId = a.factIds[0] ?? "";
  // Every search lists the fact but the last, which returns no result.
  for (let i = 0; i < 2 * G; i++) addSearch(i, "s1", i === 2 * G - 1 ? [] : [{ targetId: factId }]);
  // The writes name the first search (they follow it); the request rows came before the search rows, so the link is set here.
  for (const id of [a.requestId, b.requestId])
    w.store.db.prepare("UPDATE change_requests SET search_id = 'search-0' WHERE id = ?").run(id);
  recordRetrieval(w.store, factId, { now: at(0) + 1, ref: `search-0:${factId}` });
  recordRetrieval(w.store, factId, { now: at(0) + 2, ref: `search-0:${factId}` });
  recordRetrieval(w.store, factId, { now: at(1) + 1 });
  const duplicate = enqueueRequest(
    w.store,
    { change: "c", justification: "j", sessionId: "s1", searchId: `search-${G}` },
    at(G) + 5,
  );
  finishRequest(w.store, duplicate, at(G) + 6);
  w.store.db
    .prepare("INSERT INTO changes(request_id, outcome, summary, created_at, duplicate_of) VALUES (?, ?, 's', ?, ?)")
    .run(duplicate, ChangeOutcome.Duplicate, at(G) + 6, b.factIds[0] ?? "");
  addCalls(a.requestId, 100);
  addCalls(b.requestId, 50);
  addCalls(duplicate, 30);
}

const share = (n: number, d: number): string => `${Math.round((n / d) * 100)}%`;

// The reading of a number: the hover text of its `span.n`, and the hidden text that `aria-describedby` points at.
const readingOf = (page: Page, block: string, label: string): { title: string | null; described: string | null } => {
  const stat = (page.section(block)?.$$(".stat") ?? []).find(
    (s) => squash(s.querySelector(".l .defined")?.textContent) === label,
  );
  const n = stat?.querySelector(".n");
  const id = n?.getAttribute("aria-describedby");
  return {
    title: n?.getAttribute("title") ?? null,
    described: id === null || id === undefined ? null : squash(page.$(`#${id}`)?.textContent),
  };
};

describe("overviewPage on a wiki with no search, no session and no request", () => {
  it("shows 'No searches yet' and nothing else in each of the first 2 blocks, never NaN", async () => {
    const page = await open();
    expect(page.title).toBe("Overview - alpha - WikiFact");
    expect(page.text).not.toContain("NaN");
    expect(page.text).not.toContain("Infinity");
    for (const block of ["Wiki growth", "Search quality"]) {
      expect(page.section(block)?.text, block).toBe(`${block} No searches yet`);
      expect(page.section(block)?.stats(), block).toEqual({});
    }
    expect(page.text).not.toContain("searches so far");
    expect(page.section("Cost")?.stats()).toEqual({});
  });

  it("opens with the search quality, then the wiki growth, and leaves the subject of the wiki to the wikis page", async () => {
    const page = await open();
    expect(page.headings()[0]).toBe("Search quality");
    expect(page.headings()).toEqual(["Search quality", "Wiki growth", "Cost"]);
    expect(page.$("header.page p.lead")).toBeNull();
    expect(page.$("main")?.textContent).not.toContain(w.wiki.subject);
  });
});

describe("overviewPage on a seeded wiki", () => {
  beforeEach(seedUse);

  it("growth: the 2 charts of the live facts and of the change per search, and the 3 stats over all searches", async () => {
    const stage = (await open("span=all")).section("Wiki growth");
    const live = stage?.stats()["Live facts"];
    const additions = stage?.stats()["Additions per search"];
    const corrections = stage?.stats()["Corrections per search"];
    // 2 facts written after the first search of the span: the span adds 2 live facts; the duplicate wrote nothing.
    expect(live?.value).toBe("2");
    expect(live?.under).toBe("+2 in the span");
    // 2 additions and no correction over all the searches.
    expect(additions?.value).toBe((2 / (2 * G)).toFixed(2));
    expect(additions?.under).toContain(`${2 * G} searches`);
    expect(corrections?.value).toBe("0.00");
    expect(corrections?.under).toContain(`${2 * G} searches`);
    expect(stage?.$$("svg.chart")).toHaveLength(2);
    // 2 series with a legend.
    const legend = stage?.$$("svg text").map((t) => squash(t.textContent)) ?? [];
    expect(legend).toContain("additions");
    expect(legend).toContain("corrections");
    // The stretch size is the rule of the code (signals.test.ts proves it). Each stretch has a tooltip in each chart.
    const series = growthSeries(w.store, { searches: 2 * G, fromAt: null, toAt: null });
    const size = series[0]?.count ?? 0;
    const tips = stage?.$$("svg title").map((t) => t.textContent ?? "") ?? [];
    expect(tips).toHaveLength(2 * series.length);
    // The 2 writes are received in the first stretch only: its rate is 2 per `size` searches, the rate of the others is 0.
    const first = tipLines(tips[0]);
    expect(first.range).toBe(`searches 1 to ${size}`);
    expect(first.live).toBe(2);
    expect(first.additions).toBe(2 / size);
    expect(first.corrections).toBe(0);
    const last = tipLines(tips[series.length - 1]);
    expect(last.range).toBe(`searches ${2 * G - size + 1} to ${2 * G}`);
    expect(last.live).toBe(2);
    expect(last.additions).toBe(0);
    expect(last.corrections).toBe(0);
    expect(stage?.text).toContain("Live facts");
    expect(stage?.text).toContain("Additions and corrections per search");
    expect(stage?.$$("svg g.axis-title text").map((t) => squash(t.textContent))).toEqual([
      "facts",
      "searches so far",
      "per search",
    ]);
    // The x axis is a count of searches at round numbers, not a date.
    const labels = stage?.$$("svg text").map((t) => squash(t.textContent)) ?? [];
    expect(labels).toContain(String(2 * G));
  });

  it("search quality: the 4 bars of the reads per search, the unlinked reads, the subsection Poor searches with its 3 stats", async () => {
    const quality = (await open("span=all")).section("Search quality");
    const tips = quality?.$$("svg title").map((t) => t.textContent ?? "") ?? [];
    expect(tips).toHaveLength(4);
    expect(tips[0]).toContain(`0: ${2 * G - 2}`);
    expect(tips[1]).toContain("1: 0");
    expect(tips[2]).toContain("2: 1");
    expect(tips[3]).toContain("3+: 0");
    // 2 writes after search 1 (additions, not misses) and 1 duplicate of an unlisted fact after a search: 1 miss of 3.
    // The search with no result is in no bar and in the first stat; the no-read stat counts the searches with results.
    const noResult = quality?.stats()["Searches with no result"];
    expect(noResult?.value).toBe(share(1, 2 * G));
    expect(noResult?.under).toBe(`1 of ${2 * G} searches`);
    const noRead = quality?.stats()["Searches with no read"];
    expect(noRead?.value).toBe(share(2 * G - 2, 2 * G - 1));
    expect(noRead?.under).toBe(`${2 * G - 2} of ${2 * G - 1} searches with a minted id`);
    const missed = quality?.stats()["Facts the search missed"];
    expect(missed?.value).toBe(share(1, 3));
    expect(missed?.under).toBe("1 of 3 change requests after a search");
    expect(quality?.text).not.toContain("Duplicates per change request");
    // The subsection is a titled group of the 3 stats, right of the histogram, the searches with no result first.
    expect(quality?.$("div.subsection > p.note")?.textContent).toBe("Poor searches");
    expect(quality?.$$("div.subsection .stat")).toHaveLength(3);
    expect(Object.keys(quality?.stats() ?? {}).slice(0, 3)).toEqual([
      "Searches with no result",
      "Searches with no read",
      "Facts the search missed",
    ]);
    // The histogram has no box of its own, its caption is the label of its signal, and it sits left of the subsection.
    expect(quality?.$("figure.chartbox")).toBeNull();
    expect(quality?.$("figure.plot > figcaption .defined")?.textContent).toBe("Reads per search");
    expect(quality?.$$("svg g.axis-title text").map((t) => squash(t.textContent))).toEqual([
      "reads after the search",
      "searches",
    ]);
    const cells = quality?.$$("div.grid.cols-2 > *") ?? [];
    expect(cells.map((e) => e.tagName)).toEqual(["FIGURE", "DIV"]);
    expect(cells[0]?.matches("figure.plot")).toBe(true);
    expect(cells[1]?.classList.contains("subsection")).toBe(true);
  });

  it("shows the level of each number with a reading rule in color, and the others in ink", async () => {
    const page = await open("span=all");
    const level = (view: ReturnType<Page["section"]>, label: string): string => {
      // The label holds the hidden definition after its text.
      const stat = (view?.$$(".stat") ?? []).find((s) => squash(s.querySelector(".l .defined")?.textContent) === label);
      return (stat?.querySelector(".n")?.getAttribute("class") ?? "").replace("n", "").trim();
    };
    const quality = page.section("Search quality");
    expect(level(quality, "Searches with no result")).toBe("warning");
    expect(level(quality, "Searches with no read")).toBe("");
    expect(level(quality, "Facts the search missed")).toBe("failing");
    expect(level(page.section("Wiki growth"), "Additions per search")).toBe("");
    expect(level(page.section("Cost"), "Cost per write")).toBe("");
  });

  it("cost: the dollars per write and the share spent on requests that wrote nothing", async () => {
    // at 1 cent per input token: 180 tokens cost $1.80, 30 of them on the request that wrote nothing
    const cost = (await open("span=all")).section("Cost");
    expect(cost?.stats()["Cost per write"]).toMatchObject({ value: "$0.9000", under: "$1.80 over 2 writes" });
    expect(cost?.stats()["Spent on requests that wrote nothing"]).toMatchObject({
      value: share(30, 180),
      under: "$0.30 of $1.80",
    });
    expect(cost?.$("p.note")).toBeNull();
  });

  it("cost: 2 decimals from 1 dollar per write, and a note for the calls of a model with no price", async () => {
    const row = w.store.db.prepare("SELECT id FROM change_requests ORDER BY received_at LIMIT 1").get() as {
      id: string;
    };
    addCalls(row.id, 200);
    recordModelCall(w.store, {
      requestId: row.id,
      question: "Q1",
      model: "unlisted",
      effort: "low",
      tokensIn: 5,
      tokensOut: 5,
      tokensCacheRead: 0,
      tokensCacheWrite: 0,
      durationMs: 1,
      at: T0,
    });
    const cost = (await open("span=all")).section("Cost");
    // 380 tokens at 1 cent over 2 writes: $1.90 each
    expect(cost?.stats()["Cost per write"]).toMatchObject({ value: "$1.90", under: "$3.80 over 2 writes" });
    expect(cost?.text).toContain("1 calls of a model with no price are counted at $0.");
  });

  it("shows the definition of every signal on its label", async () => {
    const page = await open("span=all");
    // The label of a signal carries the definition, so there is no separate "Definition" link or fold.
    expect(page.folds().map((f) => f.summary)).not.toContain("Definition");
    const definitions = page.$$("[data-definition]").map((d) => d.getAttribute("title") ?? "");
    const described = page
      .$$("[aria-describedby]")
      .map((d) => page.$(`#${d.getAttribute("aria-describedby")}`)?.textContent);
    expect(described).toEqual(definitions);
    for (const signal of enumValues(Signal)) {
      expect(
        definitions.some((d) => d.includes(SIGNAL_DEFINITIONS[signal])),
        signal,
      ).toBe(true);
    }
    // The stat of a signal carries its own definition, and its title holds the same text on hover.
    const stat = page.section("Cost")?.$(".stat .defined");
    expect(stat?.getAttribute("title")).toBe(SIGNAL_DEFINITIONS[Signal.CostPerWrite]);
  });

  it("carries the reading of a number in its hover text, and shows no reading line on the page", async () => {
    const page = await open("span=all");
    expect(page.$$("p.reading")).toEqual([]);
    expect(page.$$("ul.interps")).toEqual([]);
    const expected: [string, string, string][] = [
      ["Wiki growth", "Additions per search", "Growing. Agents add and correct in step: quality should rise slowly."],
      [
        "Search quality",
        "Facts the search missed",
        "Poor. The search misses facts the wiki has, and agents find them another way.",
      ],
    ];
    for (const [block, label, sentence] of expected) {
      const got = readingOf(page, block, label);
      expect(got.title, label).toContain(sentence);
      expect(got.described, label).toBe(squash(got.title));
      expect(got.title, label).not.toContain("verified");
    }
    // A number with no reading carries none, and the cost block has none.
    for (const [block, label] of [
      ["Search quality", "Searches with no result"],
      ["Search quality", "Searches with no read"],
      ["Wiki growth", "Corrections per search"],
      ["Cost", "Cost per write"],
    ] as const) {
      expect(readingOf(page, block, label), label).toEqual({ title: null, described: null });
    }
    expect(page.section("Cost")?.$("[aria-describedby]:not(.defined)")).toBeNull();
    expect(INTERPRETATIONS.length).toBe(expected.length);
    expect(Object.values(InterpretationId)).toHaveLength(expected.length);
  });

  it("offers the span control as 2 links, marks the one in force and defaults to the recent span", async () => {
    const recent = await open();
    const control = recent.within('nav[aria-label="Span"]');
    const lastN = `Last ${SPAN_RECENT_SEARCHES} searches`;
    expect(queryOf(control?.href(lastN) ?? "").get("span")).toBe("recent");
    expect(queryOf(control?.href("All") ?? "").get("span")).toBe("all");
    expect(control?.current().map((v) => v.text)).toEqual([lastN]);
    const all = await open("span=all");
    expect(
      all
        .within('nav[aria-label="Span"]')
        ?.current()
        .map((v) => v.text),
    ).toEqual(["All"]);
  });

  it("is a 400 for a span outside the enum", async () => {
    await expect(overviewPage(w.ctx({}, "span=week"))).rejects.toBeInstanceOf(ZodError);
  });
});

describe("overviewPage when a divisor is 0", () => {
  it("shows a dash for the tokens of no write", async () => {
    addSearch(0, null);
    const page = await open("span=all");
    expect(page.text).not.toContain("NaN");
    expect(page.section("Cost")?.stats()).toEqual({});
    expect(page.section("Cost")?.text).not.toBe("");
  });

  it("shows no reading on the numbers whose data cannot say anything", async () => {
    // 1 search with no session and no change request: the stage reads 0.0 and 0.0, the missed facts have no divisor.
    addSearch(0, null);
    const page = await open("span=all");
    expect(readingOf(page, "Wiki growth", "Additions per search").title).toContain(
      "Mature. Agents correct more than they add",
    );
    expect(readingOf(page, "Search quality", "Facts the search missed")).toEqual({ title: null, described: null });
    // The 2 stats of the subsection show a dash for the change requests after a search.
    expect(page.section("Search quality")?.stat("Facts the search missed")).toBe("-");
  });
});

describe("the span of the signals", () => {
  // `n` searches with no result.
  function seedSearches(n: number): void {
    // The ids sort in time order, as ULIDs do: the recent span takes the newest searches by id.
    for (let i = 0; i < n; i++)
      recordSearch(w.store, {
        id: `s-${String(i).padStart(SEARCH_ID_DIGITS, "0")}`,
        sessionId: null,
        query: "q",
        at: at(i),
        durationMs: 1,
        results: [],
      });
  }
  const usage = async (query: string): Promise<string> =>
    (await open(query)).section("Search quality")?.stats()["Searches with no result"]?.under ?? "";

  it("gives the recent span the newest SPAN_RECENT_SEARCHES searches and the all span every search", async () => {
    seedSearches(SPAN_RECENT_SEARCHES + 1);
    expect(await usage("span=recent")).toBe(`${SPAN_RECENT_SEARCHES} of ${SPAN_RECENT_SEARCHES} searches`);
    expect(await usage("span=all")).toBe(`${SPAN_RECENT_SEARCHES + 1} of ${SPAN_RECENT_SEARCHES + 1} searches`);
  });

  it("makes the 2 spans one when the wiki has no more than SPAN_RECENT_SEARCHES searches", async () => {
    seedSearches(SPAN_RECENT_SEARCHES);
    expect(await usage("span=recent")).toBe(await usage("span=all"));
  });

  it("starts the stage chart at the first search of the span, with the x axis in searches of the wiki", async () => {
    const before = 2;
    seedSearches(SPAN_RECENT_SEARCHES + before);
    // A write inside the span, so that the chart has a point with a value.
    await seedChange(w.store, accepted([draft({ header: "C" })]), { now: at(SPAN_RECENT_SEARCHES) + 1 });
    const tip = (await open("span=recent")).section("Wiki growth")?.$$("svg title")[0]?.textContent ?? "";
    // The span has `before` searches ahead of it, so its first stretch ends past them.
    expect(Number(/(\d+)\n/.exec(tip)?.[1])).toBeGreaterThan(before);
  });

  it("labels the x axis of the recent span at round numbers of the range that it shows", async () => {
    // The wiki holds 1,003 searches, not a multiple of the stretch size: the stretches still end at round counts.
    const total = 5 * SPAN_RECENT_SEARCHES + 3;
    seedSearches(total);
    await seedChange(w.store, accepted([draft({ header: "C" })]), { now: at(total - 5) + 1 });
    const labels =
      (await open("span=recent"))
        .section("Wiki growth")
        // The second axis group of the chart is the x axis; the first holds the y ticks.
        ?.$$("svg g.axis")[1]
        ?.querySelectorAll("text") ?? [];
    const numeric = [...labels].map((t) => squash(t.textContent)).filter((l) => /^\d+$/.test(l));
    expect(numeric.length).toBeGreaterThan(1);
    expect(numeric.length).toBeLessThanOrEqual(5);
  });

  it("labels the x axis of the all span of about 1,000 searches with 4 or 5 labels", async () => {
    const total = 1000;
    seedSearches(total);
    await seedChange(w.store, accepted([draft({ header: "C" })]), { now: at(5) + 1 });
    const labels =
      (await open("span=all"))
        .section("Wiki growth")
        // The second axis group of the chart is the x axis; the first holds the y ticks.
        ?.$$("svg g.axis")[1]
        ?.querySelectorAll("text") ?? [];
    const numeric = [...labels].map((t) => squash(t.textContent)).filter((l) => /^\d+$/.test(l));
    expect(numeric.length).toBeGreaterThanOrEqual(4);
    expect(numeric.length).toBeLessThanOrEqual(5);
  });
});

describe("overviewPage stage block on a young wiki", () => {
  it("draws the stage chart from the first searches on", async () => {
    await seedChange(w.store, accepted([draft({ header: "A" })]), { now: at(0) + 5 });
    addSearch(0, null);
    addSearch(1, null);
    const stage = (await open()).section("Wiki growth");
    expect(stage?.$("figure.plot")).not.toBeNull();
    expect(stage?.$$("svg.chart")).toHaveLength(2);
    expect(stage?.text).not.toContain("No group");
    expect(stage?.stats()["Live facts"]?.value).toBe("1");
    expect(stage?.stats()["Additions per search"]?.value).toBe("0.50");
    expect(stage?.stats()["Corrections per search"]?.value).toBe("0.00");
    const labels = stage?.$$("svg text").map((t) => squash(t.textContent)) ?? [];
    expect(labels).toContain("2");
  });

  it("says so in the place of the chart while no change request has come in", async () => {
    addSearch(0, null);
    const stage = (await open()).section("Wiki growth");
    expect(stage?.text).toContain("No change request yet.");
    expect(stage?.stats()["Additions per search"]?.value).toBe("0.00");
    expect(stage?.stats()["Corrections per search"]?.value).toBe("0.00");
  });
});

describe("the searches from before the minted ids", () => {
  it("are in no bar and not in the divisor of the no-read stat", async () => {
    const a = await seedChange(w.store, accepted([draft({ header: "A" })]), { now: at(0) - 5 });
    const factId = a.factIds[0] ?? "";
    // Search 0 is minted and has no read. Searches 1 and 2 have results but no search_results row (from before the minted ids).
    for (let i = 0; i < 3; i++) addSearch(i, null, [{ targetId: factId }]);
    for (const i of [1, 2]) w.store.db.prepare("DELETE FROM search_results WHERE search_id = ?").run(`search-${i}`);
    const quality = (await open("span=all")).section("Search quality");
    const tips = quality?.$$("svg title").map((t) => t.textContent ?? "") ?? [];
    expect(tips[0]).toContain("0: 1");
    expect(tips[0]).toContain("100%");
    expect(tips.slice(1).join(" ")).toContain("1: 0");
    const noRead = quality?.stats()["Searches with no read"];
    expect(noRead?.value).toBe("100%");
    expect(noRead?.under).toBe("1 of 1 search with a minted id");
    expect(quality?.stats()["Searches with no result"]?.under).toBe("0 of 3 searches");
  });
});
