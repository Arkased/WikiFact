// The requirement tests of the operator console (docs/requirements/console.md). One `it` for each row of the
// requirements table, named as its Name cell.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChangeOutcome,
  CleanupFinder,
  LogEvent,
  Mode,
  OperatorEditKind,
  QuestionId,
  RequestStatus,
  SearchHitKind,
  Signal,
  McpToolName,
  enumValues,
} from "../../src/domain/enums.js";
import { writesAllowed } from "../../src/console/auth.js";
import type { PageContext, PageHandler } from "../../src/console/page.js";
import { exportPage } from "../../src/console/pages/export.js";
import { factPage } from "../../src/console/pages/fact.js";
import { SEARCH_BAR_MS, healthPage } from "../../src/console/pages/health.js";
import { requestPage } from "../../src/console/pages/request.js";
import { requestsPage } from "../../src/console/pages/requests.js";
import { searchPage } from "../../src/console/pages/search.js";
import { questionLabel, settingsPage } from "../../src/console/pages/settings.js";
import { overviewPage } from "../../src/console/pages/overview.js";
import { wikisPage } from "../../src/console/pages/wikis.js";
import { SIGNAL_DEFINITIONS, SPAN_RECENT_SEARCHES } from "../../src/console/signals.js";
import { StubQuestions } from "../../fakes/stub-questions.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../src/mcp/server.js";
import { runWorker } from "../../src/updates/index.js";
import {
  CLEANUP_EVERY,
  closeStore,
  openStoreFor,
  readQueuePause,
  recordToolCall,
  enqueueRequest,
  failAttempt,
  finishRequest,
  getRequest,
  listFacts,
  openSession,
  recordModelCall,
  recordRetrieval,
  recordSearch,
  seedChange,
  writeWorkerStatus,
} from "../../src/store/index.js";
import { Caller } from "../../src/updates/questions/call.js";
import { parse, squash } from "../../src/console/__tests__/helpers/dom.js";
import { fakeWrites, post, serveConsole, type RunningConsole } from "../../src/console/__tests__/helpers/serve.js";
import { openTmpWiki, type TmpWiki } from "../../src/console/__tests__/helpers/tmp-wiki.js";
import { BAR_MS, slowPages } from "../../scripts/lib/console-timing.js";
import { T0, accepted, draft } from "../helpers/store.js";
import { count } from "../helpers/updates.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

interface Running {
  wiki: TmpWiki;
  server: RunningConsole;
  factId: string;
}

// A wiki with one fact "Creeper damage" and its console on a real port.
async function start(opts: Parameters<typeof openTmpWiki>[1] = {}): Promise<Running> {
  const wiki = openTmpWiki("alpha", opts);
  cleanups.push(() => wiki.close());
  await seedChange(wiki.store, accepted([draft({ header: "Creeper damage", content: "A creeper deals 49 damage." })]), {
    now: T0,
  });
  const server = await serveConsole(wiki.deps);
  cleanups.push(() => server.close());
  return { wiki, server, factId: listFacts(wiki.store, { now: T0 }).items[0]?.id ?? "" };
}

// Text with the characters that HTML escapes, to see that a page shows a stored text as it was stored.
const CHANGE_REASONING = `Reasoned <twice> & "checked"`;
const QUEUED_CHANGE = `Please add <b>bold</b> & "quoted" text`;
const FACT_CONTENT = `A creeper deals <12> damage & "more".`;

/** A page of the console, rendered. */
interface Rendered {
  name: string;
  /** The HTML of the page, or the body of a file answer. */
  html: string;
}

/** The seeded wiki with the ids that the pages with a path parameter need. */
interface Seeded extends Running {
  requestId: string;
  queuedId: string;
}

// The wiki of `start`, with a second change that rewrites the fact and a queued submission, all with stored text
// that HTML escapes.
// With `tagged`, the rewritten fact carries the tag "Mobs", as a fact of an old wiki does.
async function startSeeded(): Promise<Seeded> {
  // The writes let the settings page show its forms, as in service mode.
  const running = await start({ writes: fakeWrites().writes });
  const { wiki, factId } = running;
  const sent = await seedChange(
    wiki.store,
    {
      ...accepted([
        draft({ factId, header: "Creeper damage", content: FACT_CONTENT }),
        draft({ header: "Ghast fireball", content: "A ghast shoots fireballs." }),
      ]),
      changeReasoning: CHANGE_REASONING,
    },
    { now: T0 + 1000, change: QUEUED_CHANGE, justification: "I checked it" },
  );
  const queuedId = enqueueRequest(wiki.store, { change: QUEUED_CHANGE, justification: "waiting <in> line" }, T0 + 2000);
  return { ...running, requestId: sent.requestId, queuedId };
}

// Every page that a GET serves (technical/console.md, "Pages"), each with real ids of the seeded wiki.
function pagesOf(s: Seeded): { name: string; page: PageHandler; ctx: PageContext }[] {
  const at = (name: string, page: PageHandler, params: Record<string, string> = {}, query = "") => ({
    name,
    page,
    ctx: s.wiki.ctx(params, query),
  });
  return [
    at("wikis", wikisPage),
    at("overview", overviewPage),
    at("overview, all", overviewPage, {}, "span=all"),
    at("search", searchPage, {}, "q=creeper+damage"),
    at("search sample", searchPage, {}, "sample=1"),
    at("search history", searchPage, {}, "q=creeper+damage&history=1"),
    at("fact", factPage, { id: s.factId }),
    at("export json", exportPage, {}, "format=json"),
    at("export md", exportPage, {}, "format=md"),
    at("requests", requestsPage),
    at("request", requestPage, { id: s.requestId }),
    at("request queued", requestPage, { id: s.queuedId }),
    at("health", healthPage),
    at("settings", settingsPage),
  ];
}

// Renders every page of the seeded wiki in turn.
async function renderAll(s: Seeded): Promise<Rendered[]> {
  const out: Rendered[] = [];
  for (const { name, page, ctx } of pagesOf(s)) {
    const result = await page(ctx);
    out.push({ name, html: typeof result === "string" ? result : result.body });
  }
  return out;
}

// The text a reader reads on a page.
async function textOf(s: Seeded, page: PageHandler, params: Record<string, string> = {}): Promise<string> {
  const result = await page(s.wiki.ctx(params));
  return parse(typeof result === "string" ? result : result.body).text;
}

// An empty wiki for the signals; the page is read through its handler.
function signalsWiki(): TmpWiki {
  const wiki = openTmpWiki("alpha");
  cleanups.push(() => wiki.close());
  return wiki;
}

// The time of search `i`; every request and read of a signals test lies around these.
const searchTime = (i: number): number => T0 + 1000 + i * 10;
/** Half the searches of the wiki of the test "Data and interpretation". */
const SEARCHES_FOR_DEFINITIONS = 50;

// Logs search `i` in session `sessionId`, listing the fact when there is one.
function addSearch(wiki: TmpWiki, i: number, sessionId: string | null, factId?: string): void {
  recordSearch(wiki.store, {
    id: `search-${i}`,
    sessionId,
    query: "q",
    at: searchTime(i),
    durationMs: 1,
    results:
      factId === undefined
        ? []
        : [{ kind: SearchHitKind.Fact, targetId: factId, rank: 1, ref: `search-${i}:${factId}` }],
  });
}

describe("Operator console requirements", () => {
  // The bar is checked on fake timings: the wall time of real pages is measured by `npm run console:timing`.
  it("Fast page", () => {
    const pages = [
      { page: "under", ms: BAR_MS - 1 },
      { page: "at", ms: BAR_MS },
      { page: "over", ms: BAR_MS + 1 },
    ];
    expect(slowPages(pages, BAR_MS).map((p) => p.page)).toEqual(["at", "over"]);
    expect(slowPages(pages.slice(0, 1), BAR_MS)).toEqual([]);
  });

  it("Reads not counted", async () => {
    const seeded = await startSeeded();
    const { wiki } = seeded;
    const before = { retrievals: count(wiki.store, "retrievals") };
    const pages = await renderAll(seeded);
    // The pages did read the facts, so the check is not on empty pages.
    const sample = pages.find((p) => p.name === "search sample");
    expect(parse(sample?.html ?? "").results()).not.toEqual([]);
    expect(count(wiki.store, "retrievals")).toBe(before.retrievals);
  });

  it("No model call", async () => {
    // The deps of a page hold no question transport, so a page has no way to reach a model. The spies prove that no
    // page asks a question through the caller of the pipeline or opens a network connection.
    const ask = vi.spyOn(Caller.prototype, "ask").mockRejectedValue(new Error("model call"));
    const net = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network call"));
    try {
      const pages = await renderAll(await startSeeded());
      expect(pages.length).toBeGreaterThan(10);
      expect(ask).not.toHaveBeenCalled();
      expect(net).not.toHaveBeenCalled();
    } finally {
      ask.mockRestore();
      net.mockRestore();
    }
  });

  it("Plain words", async () => {
    const labels = Object.values(QuestionId).map(questionLabel);
    for (const label of labels) expect(label).not.toMatch(/^Q\d+$/);
    expect(new Set(labels).size).toBe(labels.length);

    // No page, in the text a reader reads, shows a question number, a step number or a module name.
    const pages = await renderAll(await startSeeded());
    for (const { name, html } of pages) {
      const text = parse(html).text;
      expect(text, name).not.toMatch(/\bQ\d+\b/);
      expect(text, name).not.toMatch(/\bsteps? \d/i);
      expect(text, name).not.toMatch(/\bsrc\//);
      expect(text, name).not.toMatch(/\.(ts|js|mjs)\b/);
    }
  });

  it("Stored text", async () => {
    const { wiki, factId } = await start();
    const sent = await seedChange(
      wiki.store,
      accepted([
        draft({
          factId,
          header: "Creeper damage",
          content: "A creeper deals 12 damage.",
          justification: "I measured <12> twice.",
        }),
      ]),
      { now: T0 + 1000, change: "Damage is <different>", justification: "I checked it" },
    );

    const request = parse(await requestPage(wiki.ctx({ id: sent.requestId })));
    const submission = request.section("Submission");
    expect(submission?.text).toContain("Damage is <different>");
    expect(submission?.text).toContain("I checked it");

    const fact = parse(await factPage(wiki.ctx({ id: factId }))).section("Fact");
    expect(fact?.text).toContain("A creeper deals 12 damage.");
    expect(fact?.text).toContain("I measured <12> twice.");
    expect(fact?.text).toContain("test reasoning");

    // The request and requests pages show the stored text with the characters that HTML escapes.
    const seeded = await startSeeded();
    const change = await textOf(seeded, requestPage, { id: seeded.requestId });
    expect(change).toContain(CHANGE_REASONING);
    expect(change).toContain(QUEUED_CHANGE);
    expect(await textOf(seeded, requestsPage)).toContain(QUEUED_CHANGE);
  });

  it("Local edits only", async () => {
    const path = "/console/w/alpha/jobs/reindex";
    const send = (base: string, headers: Record<string, string> = {}): Promise<Response> =>
      fetch(`${base}${path}`, {
        method: "POST",
        redirect: "manual",
        headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
        body: new URLSearchParams({ confirm: "1", note: "n" }).toString(),
      });

    // Local mode on the loopback takes the form; a form from another web site is refused, and nothing is written.
    const local = await start({ mode: Mode.Local });
    expect(writesAllowed({ mode: Mode.Local, host: "127.0.0.1" })).toBe(true);
    expect((await send(local.server.base, { Origin: "http://evil.example" })).status).toBe(403);
    expect((await send(local.server.base, { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    const seeded = count(local.wiki.store, "change_requests");
    expect((await send(local.server.base)).status).toBe(303);
    expect(count(local.wiki.store, "change_requests")).toBe(seeded + 1);

    // A host that is not this machine refuses every edit.
    const remote = await start({ mode: Mode.Local, host: "10.0.0.5" });
    expect(writesAllowed({ mode: Mode.Local, host: "10.0.0.5" })).toBe(false);
    expect((await send(remote.server.base)).status).toBe(403);
    expect(count(remote.wiki.store, "change_requests")).toBe(seeded);
  });

  it("Wiki growth", async () => {
    // 4 searches; an addition after the 1st, an addition after the 2nd, a correction after the 3rd.
    const wiki = signalsWiki();
    const last = 4;
    for (let i = 0; i < last; i++) addSearch(wiki, i, null);
    const first = await seedChange(wiki.store, accepted([draft({ header: "A" })]), { now: searchTime(0) + 1 });
    await seedChange(wiki.store, accepted([draft({ header: "B" })]), { now: searchTime(1) + 1 });
    await seedChange(wiki.store, accepted([draft({ header: "A", factId: first.factIds[0], content: "Changed." })]), {
      now: searchTime(2) + 1,
    });

    const stage = parse(await overviewPage(wiki.ctx())).section("Wiki growth");
    // 2 charts on the searches of the wiki so far: the live facts, and the change per search with its 2 series named.
    expect(stage?.$$("svg.chart")).toHaveLength(2);
    const texts = stage?.$$("svg text").map((t) => squash(t.textContent)) ?? [];
    expect(texts).toContain(String(last));
    expect(texts).toContain("searches so far");
    expect(texts).toContain("additions");
    expect(texts).toContain("corrections");
    // The hover of a stretch (1 search each here) shows the live facts and the rates of that stretch alone, never a count from the start.
    const tips = (stage?.$$("svg title").map((t) => t.textContent ?? "") ?? []).slice(0, last);
    expect(tips).toHaveLength(last);
    expect(tips[0]).toContain("search 1\n0 live facts\n1.00 additions per search\n0.00 corrections per search");
    expect(tips[1]).toContain("search 2\n1 live fact\n1.00 additions per search\n0.00 corrections per search");
    expect(tips[2]).toContain("search 3\n2 live facts\n0.00 additions per search\n1.00 corrections per search");
    expect(tips[3]).toContain("search 4\n2 live facts\n0.00 additions per search\n0.00 corrections per search");
    // The side stats: the live facts with the change over the span, and the rates over the whole span.
    expect(stage?.stat("Live facts")).toBe("2");
    expect(stage?.text).toContain("+2 in the span");
    expect(stage?.stat("Additions per search")).toBe("0.50");
    expect(stage?.stat("Corrections per search")).toBe("0.25");
    expect(stage?.text).toContain(`in ${last} searches`);

    // Over the recent span the chart starts at the first search of the span, and the x axis counts the searches of the wiki.
    const long = signalsWiki();
    for (let i = 0; i < SPAN_RECENT_SEARCHES + 2; i++) addSearch(long, i, null);
    await seedChange(long.store, accepted([draft({ header: "C" })]), { now: searchTime(SPAN_RECENT_SEARCHES) + 1 });
    const recent = parse(await overviewPage(long.ctx())).section("Wiki growth");
    // The 2 searches before the span are not on the chart: its first stretch ends past them.
    expect(Number(/(\d+)\n/.exec(recent?.$$("svg title")[0]?.textContent ?? "")?.[1])).toBeGreaterThan(2);
  });

  it("Search quality", async () => {
    // 4 searches with 0, 1, 2 and 3 reads each, 1 search with no result, and 2 change requests after a search of their
    // session: 1 addition and 1 duplicate of a fact that no search lists.
    const wiki = signalsWiki();
    openSession(wiki.store, { id: "s1", startedAt: T0 });
    const unlisted = await seedChange(wiki.store, accepted([draft({ header: "Unlisted" })]), { now: searchTime(0) });
    const kept = await seedChange(wiki.store, accepted([draft({ header: "Kept" })]), {
      now: searchTime(0),
      sessionId: "s1",
    });
    const factId = kept.factIds[0] ?? "";
    for (const [i, reads] of [0, 1, 2, 3].entries()) {
      addSearch(wiki, i * 10, "s1", factId);
      for (let r = 1; r <= reads; r++)
        recordRetrieval(wiki.store, factId, { now: searchTime(i * 10) + r, ref: `search-${i * 10}:${factId}` });
    }
    addSearch(wiki, 40, "s1");
    wiki.store.db.prepare("UPDATE change_requests SET search_id = 'search-0' WHERE id = ?").run(kept.requestId);
    const duplicate = enqueueRequest(
      wiki.store,
      { change: "c", justification: "j", sessionId: "s1", searchId: "search-40" },
      searchTime(0) + 1,
    );
    finishRequest(wiki.store, duplicate, searchTime(0) + 2);
    wiki.store.db
      .prepare("INSERT INTO changes(request_id, outcome, summary, created_at, duplicate_of) VALUES (?, ?, 's', ?, ?)")
      .run(duplicate, ChangeOutcome.Duplicate, searchTime(0) + 2, unlisted.factIds[0] ?? "");

    const quality = parse(await overviewPage(wiki.ctx({}, "span=all"))).section("Search quality");
    const bars = quality?.$$("svg title").map((t) => t.textContent ?? "") ?? [];
    // The share of the searches with 0, 1, 2 and 3 or more reads: 1 of 4 each.
    expect(bars.map((b) => /^searches, (\S+): 1, 25% /.exec(b)?.[1])).toEqual(["0", "1", "2", "3+"]);
    // The searches with no result: the 1 of 5, in no bar.
    const noResult = quality?.stats()["Searches with no result"];
    expect(noResult?.value).toBe("20%");
    expect(noResult?.under).toBe("1 of 5 searches");
    // The searches with no read: the search with 0 reads, of the 4 with results.
    const noRead = quality?.stats()["Searches with no read"];
    expect(noRead?.value).toBe("25%");
    expect(noRead?.under).toBe("1 of 4 searches with a minted id");
    // The facts the search missed: the duplicate of an unlisted fact (after a search) and the addition (not a miss) make 1 of 2.
    const missed = quality?.stats()["Facts the search missed"];
    expect(missed?.value).toBe("50%");
    expect(missed?.under).toBe("1 of 2 change requests after a search");
    expect(quality?.$("div.subsection > p.note")?.textContent).toBe("Poor searches");
  });

  it("Cost", async () => {
    // 2 writes that took 100 and 50 tokens, and 1 request that wrote nothing and took 30.
    const wiki = signalsWiki();
    const a = await seedChange(wiki.store, accepted([draft({ header: "A" })]), { now: T0 + 1 });
    const b = await seedChange(wiki.store, accepted([draft({ header: "B" })]), { now: T0 + 2 });
    const nothing = enqueueRequest(wiki.store, { change: "c", justification: "j" }, T0 + 3);
    finishRequest(wiki.store, nothing, T0 + 4);
    for (const [requestId, tokensIn] of [
      [a.requestId, 100],
      [b.requestId, 50],
      [nothing, 30],
    ] as const) {
      recordModelCall(wiki.store, {
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

    const cost = parse(await overviewPage(wiki.ctx({}, "span=all"))).section("Cost");
    // At the fake price of 1 cent per input token: $1.80 over 2 writes. The share spent on the request that wrote nothing: $0.30 of $1.80.
    expect(cost?.stats()["Cost per write"]).toMatchObject({ value: "$0.9000", under: "$1.80 over 2 writes" });
    expect(cost?.stats()["Spent on requests that wrote nothing"]).toMatchObject({
      value: "17%",
      under: "$0.30 of $1.80",
    });
  });

  it("Service health", async () => {
    // A clock for the page and for the counter of the endpoint, half way into an hour.
    const hour = 3_600_000;
    const now = Math.floor(T0 / hour) * hour + hour / 2;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    const wiki = openTmpWiki("alpha", { childRunning: true, workerRestarts: 2 });
    cleanups.push(() => {
      wiki.close();
      vi.useRealTimers();
    });
    recordToolCall(wiki.store, { at: now, tool: McpToolName.Search, ok: true, durationMs: SEARCH_BAR_MS - 1 });
    recordToolCall(wiki.store, { at: now, tool: McpToolName.Search, ok: false, durationMs: SEARCH_BAR_MS + 1 });
    recordToolCall(wiki.store, { at: now, tool: McpToolName.GetFact, ok: true, durationMs: 1 });
    // 1 failed request in the window and 2 queued.
    const failed = enqueueRequest(wiki.store, { change: "f", justification: "j" }, now - 1000);
    for (let i = 0; i < 3; i++) failAttempt(wiki.store, failed, "model down", now - 1000 + i);
    enqueueRequest(wiki.store, { change: "q1", justification: "j" }, now - 10);
    enqueueRequest(wiki.store, { change: "q2", justification: "j" }, now - 5);
    writeWorkerStatus(wiki.store, { pid: 4242, startedAt: now - 5000, lastPollAt: now - 1000, consecutiveFailures: 0 });

    const page = parse(await healthPage(wiki.ctx()));
    // One page, two parts of the service side by side, each with its present above its last 24 hours.
    expect(page.headings("h1")[0]).toContain("warning");
    for (const title of ["MCP server, now", "MCP server, 24 hours", "Queue worker, now", "Queue worker, 24 hours"]) {
      expect(page.section(title), title).toBeDefined();
    }
    // The worker: its state, the queue length and the rate; the restarts and the failures are in the last 24 hours.
    const worker = page.section("Queue worker, now");
    expect(worker?.stat("State")).toBe("running");
    expect(worker?.stat("Queue")).toBe("2");
    expect(worker?.stats().Rate?.under).toBe("per hour");
    const history = page.section("Queue worker, 24 hours");
    expect(history?.stat("Restarts")).toBe("2");
    // The failed request, with its error, is in the last 24 hours.
    expect(history?.stat("Failed change requests")).toBe("1");
    expect(history?.text).toContain("model down");
    expect(page.section("MCP server, 24 hours")?.stat("Failed tool calls")).toBe("1");
    // The change requests processed per hour above the queue length per hour: 3 accepted and the failed one above, 4 in the hour.
    for (let i = 0; i < 3; i++) {
      const id = enqueueRequest(wiki.store, { change: `p${i}`, justification: "j" }, now - 5000);
      wiki.store.db
        .prepare("UPDATE change_requests SET status = 'done', started_at = ?, finished_at = ? WHERE id = ?")
        .run(now - 3000, now - 1000, id);
      wiki.store.db
        .prepare("INSERT INTO changes(request_id, outcome, summary, created_at) VALUES (?, 'accepted', 's', ?)")
        .run(id, now - 1000);
    }
    const busy = parse(await healthPage(wiki.ctx())).section("Queue worker, 24 hours");
    const processed = busy?.$$("svg title").map((t) => t.textContent ?? "") ?? [];
    expect(processed.some((t) => t.includes("requests: 4"))).toBe(true);
    expect(processed.some((t) => t.includes("queued: 2"))).toBe(true);
    // The endpoint: the calls, the failed calls and the time of a search against its bar, and the calls per hour in the chart.
    const endpoint = page.section("MCP server, now");
    expect(endpoint?.stat("Tool calls")).toBe("3");
    expect(endpoint?.stats()["Tool calls"]?.under).toBe("1 failed");
    expect(endpoint?.stat("Last tool call")).not.toBe("-");
    const searchTime = endpoint?.stats()["Search time"];
    expect(searchTime?.value).toBe(`${SEARCH_BAR_MS + 1} ms`);
    expect(searchTime?.under).toContain(`bar ${SEARCH_BAR_MS} ms`);
    const hours =
      page
        .section("MCP server, 24 hours")
        ?.$$("svg title")
        .map((t) => t.textContent ?? "") ?? [];
    expect(hours.some((t) => t.includes("calls: 3"))).toBe(true);
    // No button repairs it: the service does that. The controls are the pause of the queue and the Run buttons of the jobs.
    expect(page.section("Queue worker, now")?.buttons()).toEqual(["Run a batch now", "Pause"]);
    expect(page.section("Jobs")?.headings()).toEqual(["Jobs"]);
  });

  it("Queue pause", async () => {
    const { wiki, server } = await start();
    const first = enqueueRequest(wiki.store, { change: "Creepers do 10 damage.", justification: "I saw it." });
    // The operator pauses the queue from the console.
    const done = await post(server.base, "/console/w/alpha/health/pause", { confirm: "1", note: "measuring" });
    expect(done.status).toBe(303);
    expect(readQueuePause(wiki.store)).toMatchObject({ note: "measuring" });

    // requestChange still accepts a request while the queue is paused, and tells the caller why it waits.
    writeWorkerStatus(wiki.store, { pid: 1, startedAt: T0, lastPollAt: Date.now(), consecutiveFailures: 0 });
    const mcp = createServer({
      dbPath: wiki.wiki.dbPath,
      config: wiki.wiki.config,
      writeStore: wiki.store,
      log: () => undefined,
    });
    const client = new Client({ name: "test", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([mcp.connect(a), client.connect(b)]);
    cleanups.push(() => client.close());
    const sent = (await client.callTool({
      name: "requestChange",
      arguments: { change: "Zombies do 5 damage.", justification: "I saw it." },
    })) as unknown as { structuredContent: { requestId: string; status: RequestStatus; warning?: string } };
    const second = sent.structuredContent.requestId;
    expect(sent.structuredContent.status).toBe(RequestStatus.Queued);
    expect(sent.structuredContent.warning).toContain("measuring");
    expect(getRequest(wiki.store, second)?.status).toBe(RequestStatus.Queued);

    // The worker starts no request while the key exists, and a new worker after a restart holds the same pause.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    try {
      for (let run = 0; run < 2; run++) {
        const abort = new AbortController();
        let seen!: () => void;
        const paused = new Promise<void>((resolve) => (seen = resolve));
        const worker = runWorker({
          dbPath: wiki.wiki.dbPath,
          config: wiki.wiki.config,
          questions: new StubQuestions(),
          pollMs: 10,
          signal: abort.signal,
          log: (l) => {
            if (l.event === LogEvent.QueuePause) seen();
          },
        });
        await paused;
        await vi.advanceTimersByTimeAsync(100);
        abort.abort();
        await worker;
      }
    } finally {
      vi.useRealTimers();
    }
    for (const id of [first, second]) {
      expect(getRequest(wiki.store, id)).toMatchObject({ status: RequestStatus.Queued, attempts: 0 });
    }

    // The key survives a reopen of the store.
    const reopened = openStoreFor(wiki.wiki.config, wiki.wiki.dbPath);
    try {
      expect(readQueuePause(reopened)).toMatchObject({ note: "measuring" });
    } finally {
      closeStore(reopened);
    }

    // The operator resumes the queue.
    expect((await post(server.base, "/console/w/alpha/health/resume", { confirm: "1" })).status).toBe(303);
    expect(readQueuePause(wiki.store)).toBeUndefined();
  });

  it("Jobs", async () => {
    const { wiki, server } = await start();
    // 1 row per job, each with its trigger, last run, next run and result.
    const before = parse(await healthPage(wiki.ctx()));
    const jobs = before.rows().map((r) => r[0] ?? "");
    expect(jobs).toHaveLength(enumValues(CleanupFinder).length + 1);
    expect(jobs.at(-1)).toBe("Rebuild the search index");
    expect(before.headers().map((h) => h.label)).toEqual(
      expect.arrayContaining(["Job", "Every", "Last run", "Next run", "Result"]),
    );
    const missing = before.row("Merge duplicate facts");
    expect(missing?.[1]).toContain(`${CLEANUP_EVERY[CleanupFinder.DuplicateFact]} write`);
    expect(missing?.[3]).toMatch(/^in \d+ writes?$/);
    expect(before.row("Rebuild the search index")?.[1]).toBe("manual");
    expect(before.row("Rebuild the search index")?.[3]).toBe("-");

    // The operator starts a run at once: the request is queued, and the result column links it.
    const done = await post(server.base, "/console/w/alpha/jobs/reindex", { confirm: "1", note: "run now" });
    expect(done.status).toBe(303);
    const id = done.headers.get("location")?.split("/").pop() ?? "";
    expect(getRequest(wiki.store, id)?.operatorEdit).toEqual({ edit: OperatorEditKind.Reindex, note: "run now" });
    const after = parse(await healthPage(wiki.ctx()));
    expect(after.linkTo(`/requests/${id}`)).toBeDefined();
    // A time of today is the hour and the minute alone.
    expect(after.row("Rebuild the search index")?.[2]).toMatch(/^(\d{4}-\d\d-\d\d )?\d\d:\d\d$/);
    const cleanup = await post(server.base, "/console/w/alpha/jobs/cleanup", { confirm: "1", note: "run now" });
    expect(cleanup.status).toBe(303);
    const cleanupId = cleanup.headers.get("location")?.split("/").pop() ?? "";
    expect(getRequest(wiki.store, cleanupId)?.operatorEdit).toEqual({
      edit: OperatorEditKind.Cleanup,
      note: "run now",
    });
  });

  it("Data and interpretation", async () => {
    const wiki = signalsWiki();
    openSession(wiki.store, { id: "s1", startedAt: T0 });
    const written = await seedChange(wiki.store, accepted([draft({ header: "A" })]), {
      now: searchTime(0),
      sessionId: "s1",
    });
    addSearch(wiki, 0, "s1", written.factIds[0] ?? "");
    for (let i = 1; i < 2 * SEARCHES_FOR_DEFINITIONS; i++) addSearch(wiki, i, "s1");
    wiki.store.db.prepare("UPDATE change_requests SET search_id = 'search-0' WHERE id = ?").run(written.requestId);
    const page = parse(await overviewPage(wiki.ctx({}, "span=all")));

    // Hard data: every signal has its definition on its label, which a screen reader reads by `aria-describedby`.
    const labels = page.$$("[data-definition]");
    const described = labels.map((l) => squash(page.$(`#${l.getAttribute("aria-describedby")}`)?.textContent));
    for (const signal of enumValues(Signal)) {
      expect(
        described.some((f) => f.includes(SIGNAL_DEFINITIONS[signal])),
        signal,
      ).toBe(true);
    }
    // Interpretation: the page has no reading line. A number with a rule carries the sentence that reads the current data of this
    // wiki (100 searches, none of them read, 1 change request, 1 session that searched) in its hover text, and a screen reader
    // reads it through `aria-describedby`; a number without a rule carries none.
    expect(page.$$("p.reading, ul.interps")).toEqual([]);
    const readingOf = (label: string): { title: string | null; described: string | null } => {
      const stat = page.$$(".stat").find((s) => squash(s.querySelector(".l .defined")?.textContent) === label);
      const n = stat?.querySelector(".n");
      const id = n?.getAttribute("aria-describedby");
      return {
        title: n?.getAttribute("title") ?? null,
        described: id === null || id === undefined ? null : squash(page.$(`#${id}`)?.textContent),
      };
    };
    // Each reading leads with its verdict word and holds no number.
    const withRule: [string, string][] = [
      ["Additions per search", "Growing. Agents add and correct in step: quality should rise slowly."],
      ["Facts the search missed", "Good. The search finds the facts the wiki has."],
    ];
    for (const [label, sentence] of withRule) {
      const got = readingOf(label);
      expect(got.title, label).toContain(sentence);
      expect(got.described, label).toBe(squash(got.title));
    }
    for (const label of [
      "Searches with no result",
      "Searches with no read",
      "Corrections per search",
      "Cost per write",
    ]) {
      expect(readingOf(label), label).toEqual({ title: null, described: null });
    }
  });
});
