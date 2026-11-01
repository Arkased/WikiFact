import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BatchReconciliation,
  ChangeOutcome,
  McpToolName,
  Mode,
  PauseReason,
  RequestStatus,
  WorkerState,
} from "../../domain/enums.js";
import {
  RECENT_WINDOW_MS,
  enqueueRequest,
  failAttempt,
  recordToolCall,
  setQueuePause,
  writeBatchProgress,
  writeWorkerStatus,
} from "../../store/index.js";
import { T0 } from "../../../__tests__/helpers/store.js";
import { ConsoleError } from "../errors.js";
import { SEARCH_BAR_MS, healthPage } from "../pages/health.js";
import { parse, squash, type Page, type View } from "./helpers/dom.js";
import { openTmpWiki, type TmpWiki } from "./helpers/tmp-wiki.js";

const CALL_BUCKET_MS = 3_600_000;
const DAY_MS = 24 * CALL_BUCKET_MS;

/** The clock of the page and of the stored tool calls in these tests: a fixed hour, 30 minutes past a whole hour. */
const NOW = Math.floor(T0 / CALL_BUCKET_MS) * CALL_BUCKET_MS + CALL_BUCKET_MS / 2;

const MCP_NOW = "MCP server, now";
const MCP_DAY = "MCP server, 24 hours";
const WORKER_NOW = "Queue worker, now";
const WORKER_DAY = "Queue worker, 24 hours";

let w: TmpWiki;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  w = openTmpWiki();
});
afterEach(() => {
  w.close();
  vi.useRealTimers();
});

async function open(wiki: TmpWiki = w): Promise<Page> {
  return parse(await healthPage(wiki.ctx()));
}

// The level class of the number of a stat by its label: `ok`, `warning`, `failing`, or "" for a number with no rule.
function levelOfStat(view: View | undefined, label: string): string {
  const stat = (view?.$$(".stat") ?? []).find((s) => squash(s.querySelector(".l")?.textContent) === label);
  const cls = (stat?.querySelector(".n")?.getAttribute("class") ?? "").split(" ");
  return cls.filter((c) => c !== "n").join(" ");
}

// The stat labels of a view, in order.
const statLabels = (view: View | undefined): string[] => Object.keys(view?.stats() ?? {});

// The lines under the page header, outside every panel.
const topLines = (page: Page): string[] => page.$$("ul.interps.flush p.reading").map((p) => squash(p.textContent));

const pad2 = (n: number): string => String(n).padStart(2, "0");
const clock = (ms: number): string => `${pad2(new Date(ms).getHours())}:${pad2(new Date(ms).getMinutes())}`;
const dayClock = (ms: number): string =>
  `${new Date(ms).getFullYear()}-${pad2(new Date(ms).getMonth() + 1)}-${pad2(new Date(ms).getDate())} ${clock(ms)}`;
const hourLabel = (ms: number): string => `${pad2(new Date(ms).getHours())}:00`;

// The tooltip titles of the drawings of a view.
const titlesOf = (view: View | undefined): string[] => view?.$$("svg title").map((t) => t.textContent ?? "") ?? [];

// A running worker that polled just now: the worker row is ok.
function pollNow(store: TmpWiki["store"] = w.store): void {
  writeWorkerStatus(store, { pid: 4242, startedAt: T0, lastPollAt: NOW, consecutiveFailures: 0 });
}

// The failure is recent, so it counts in the 24-hour window of the failed requests.
function failedRequest(error: string): { id: string; at: number } {
  const at = NOW - 1000;
  const id = enqueueRequest(w.store, { change: "Gamma", justification: "j" }, at);
  for (let i = 0; i < 3; i++) failAttempt(w.store, id, error, at + i);
  return { id, at: at + 2 };
}

function call(tool: McpToolName, ok: boolean, durationMs: number, at = NOW - 1000): void {
  recordToolCall(w.store, { at, tool, ok, durationMs });
}

// A finished request with its outcome: a `done` request has a change row of that outcome.
function done(outcome: ChangeOutcome, startedAt: number, finishedAt: number): void {
  const id = enqueueRequest(w.store, { change: "c", justification: "j" }, startedAt - 10);
  w.store.db
    .prepare("UPDATE change_requests SET status = ?, started_at = ?, finished_at = ? WHERE id = ?")
    .run(RequestStatus.Done, startedAt, finishedAt, id);
  w.store.db
    .prepare("INSERT INTO changes(request_id, outcome, summary, created_at) VALUES (?, ?, 's', ?)")
    .run(id, outcome, finishedAt);
}

describe("the Operation page", () => {
  it("renders the verdict, the refresh, and the pause of the queue as the one control of the worker", async () => {
    const page = await open();
    expect(page.title).toBe("Operation - alpha - WikiFact");
    expect(page.headings("h1")[0]).toContain("failing");
    expect(page.$("main")?.getAttribute("data-refresh")).toBeTruthy();
    expect(page.section(WORKER_NOW)?.buttons()).toEqual(["Run a batch now", "Pause"]);
    // The batch and pause controls and the dialog of the pause; the Run buttons of the jobs and their dialogs.
    expect(page.buttons().filter((b) => b !== "Run")).toEqual([
      "Run a batch now",
      "Pause",
      "Pause",
      "Cancel",
      "Preview",
      "Cancel",
      "Preview",
      "Cancel",
    ]);
  });

  it("puts the MCP server left and the queue worker right, the present row above the 24 hours row, then the jobs", async () => {
    const page = await open();
    // The grid has 2 rows, the present of both then the history of both; Jobs is the last section, and the dialogs come after it.
    expect(page.headings("h2").slice(0, 5)).toEqual([MCP_NOW, WORKER_NOW, MCP_DAY, WORKER_DAY, "Jobs"]);
    for (const title of [MCP_NOW, MCP_DAY, WORKER_NOW, WORKER_DAY, "Jobs"]) {
      expect(page.section(title), title).toBeDefined();
    }
    // The jobs table is in the section Jobs, and no other section holds a job.
    expect(page.section("Jobs")?.row("Rebuild the search index")).toBeDefined();
    expect(page.section(WORKER_DAY)?.row("Rebuild the search index")).toBeUndefined();
  });

  it("holds no verdict line in a panel: the only reading is the status line under the heading", async () => {
    call(McpToolName.Search, true, 5);
    failedRequest("boom");
    const page = await open();
    expect(page.$$("section.panel p.reading")).toEqual([]);
    expect(page.$$("p.reading").length).toBe(page.$$("ul.interps.flush p.reading").length);
    expect(page.text).not.toMatch(/The endpoint answers|A submission waits|Nothing failed in 24 hours/);
  });

  it("has no check of the index, the schema or the database, no log, no pid and no lock", async () => {
    const page = await open();
    for (const heading of ["Checks", "Log", "Service"]) expect(page.section(heading)).toBeUndefined();
    expect(page.text).not.toMatch(/\bpid\b|\block\b/i);
  });

  it("refuses an unknown wiki", async () => {
    await expect(healthPage(w.ctx({ w: "nope" }))).rejects.toBeInstanceOf(ConsoleError);
  });
});

describe("the status line", () => {
  it("shows nothing under the heading when every row is ok", async () => {
    pollNow();
    const page = await open();
    expect(page.$$("ul.interps")).toHaveLength(0);
    expect(page.text).not.toContain("All good");
  });

  it("gives 1 line per row that is not ok, with its detail, in its level color", async () => {
    const { at } = failedRequest("boom");
    const page = await open();
    expect(topLines(page)).toEqual([
      "Failing. The worker has not polled yet.",
      `Warning. 1 request failed in the last 24 hours, the last at ${clock(at)}.`,
    ]);
    expect(page.$$("ul.interps.flush p.reading.red")).toHaveLength(1);
    expect(page.$$("ul.interps.flush p.reading.yellow")).toHaveLength(1);
  });

  it("says since when a worker has not polled", async () => {
    writeWorkerStatus(w.store, { pid: 4242, startedAt: T0, lastPollAt: NOW - 180_000, consecutiveFailures: 0 });
    expect(topLines(await open())).toEqual(["Failing. The worker has not polled for 3 min."]);
  });

  it("names a failed call row of the last hour", async () => {
    pollNow();
    for (let i = 0; i < 4; i++) call(McpToolName.GetFact, true, 1);
    call(McpToolName.GetFact, false, 1);
    expect(topLines(await open())).toEqual(["Warning. 1 tool call failed in the last hour."]);
    for (let i = 0; i < 4; i++) call(McpToolName.GetFact, false, 1);
    expect(topLines(await open())).toEqual(["Failing. 5 of 9 tool calls failed in the last hour."]);
  });
});

describe(MCP_NOW, () => {
  it("shows the stats Last tool call, Tool calls and Search time, with the failed calls under the calls", async () => {
    call(McpToolName.Search, true, SEARCH_BAR_MS - 1);
    call(McpToolName.Search, true, SEARCH_BAR_MS + 1);
    call(McpToolName.GetFact, false, 1);
    const now = (await open()).section(MCP_NOW);
    expect(statLabels(now)).toEqual(["Last tool call", "Tool calls", "Search time"]);
    expect(now?.stats()["Tool calls"]).toMatchObject({ value: "3", under: "1 failed" });
    const time = now?.stats()["Search time"];
    expect(time?.value).toBe(`${SEARCH_BAR_MS + 1} ms`);
    expect(time?.under).toContain(`p50 ${SEARCH_BAR_MS - 1} ms`);
    expect(time?.under).toContain(`bar ${SEARCH_BAR_MS} ms`);
  });

  it("says how long ago the last tool call was, in ink, and a dash with no call", async () => {
    const none = (await open()).section(MCP_NOW);
    expect(none?.stats()["Last tool call"]).toMatchObject({ value: "-" });
    expect(levelOfStat(none, "Last tool call")).toBe("");
    call(McpToolName.GetFact, true, 1, NOW - 5000);
    call(McpToolName.GetFact, true, 1, NOW - 90_000);
    const last = (await open()).section(MCP_NOW)?.stats()["Last tool call"];
    expect(last?.value).toBe("5 s");
    expect(last?.under).toBe("ago");
  });

  it("names the newest call even when it is older than the window of the counts", async () => {
    call(McpToolName.GetFact, true, 1, NOW - 3 * CALL_BUCKET_MS);
    const now = (await open()).section(MCP_NOW);
    expect(now?.stats()["Tool calls"]).toMatchObject({ value: "0", under: "0 failed" });
    expect(now?.stats()["Last tool call"]?.value).toBe("3 h");
  });

  it("shows no search and a dash when the window has none", async () => {
    const now = (await open()).section(MCP_NOW);
    expect(now?.stats()["Search time"]).toMatchObject({ value: "-", under: `no search, bar ${SEARCH_BAR_MS} ms` });
    expect(levelOfStat(now, "Search time")).toBe("");
  });

  it("reads the calls and the search time over the recent window, 1 under and 1 over its edge", async () => {
    call(McpToolName.Search, true, 77, NOW - RECENT_WINDOW_MS);
    call(McpToolName.GetFact, true, 1, NOW - RECENT_WINDOW_MS);
    let now = (await open()).section(MCP_NOW);
    expect(now?.stats()["Tool calls"]?.value).toBe("0");
    expect(now?.stats()["Search time"]?.value).toBe("-");
    call(McpToolName.Search, true, 33, NOW - RECENT_WINDOW_MS + 1);
    now = (await open()).section(MCP_NOW);
    expect(now?.stats()["Tool calls"]?.value).toBe("1");
    expect(now?.stats()["Search time"]?.value).toBe("33 ms");
  });

  it("colors '0 failed' ok when the fault is older than the window but inside the hour, while the status line still names it", async () => {
    pollNow();
    call(McpToolName.GetFact, false, 1, NOW - RECENT_WINDOW_MS - 1000);
    call(McpToolName.GetFact, true, 1);
    const page = await open();
    const now = page.section(MCP_NOW);
    expect(now?.stats()["Tool calls"]).toMatchObject({ value: "1", under: "0 failed" });
    expect(now?.$$(".stat .u .ok")).toHaveLength(1);
    expect(now?.$$(".stat .u .warning, .stat .u .failing")).toHaveLength(0);
    expect(topLines(page)).toEqual(["Warning. 1 tool call failed in the last hour."]);
  });

  it("colors the search time ok at the bar and warning over it", async () => {
    call(McpToolName.Search, true, SEARCH_BAR_MS);
    expect(levelOfStat((await open()).section(MCP_NOW), "Search time")).toBe("ok");
    call(McpToolName.Search, true, SEARCH_BAR_MS + 1);
    expect(levelOfStat((await open()).section(MCP_NOW), "Search time")).toBe("warning");
  });

  it("leaves the number of the calls in ink and colors the failed calls under it by the failed calls row", async () => {
    for (let i = 0; i < 4; i++) call(McpToolName.GetFact, true, 1);
    let now = (await open()).section(MCP_NOW);
    expect(levelOfStat(now, "Tool calls")).toBe("");
    expect(now?.$$(".stat .u .ok")).toHaveLength(1);
    call(McpToolName.GetFact, false, 1);
    now = (await open()).section(MCP_NOW);
    expect(now?.$$(".stat .u .warning")).toHaveLength(1);
    for (let i = 0; i < 4; i++) call(McpToolName.GetFact, false, 1);
    now = (await open()).section(MCP_NOW);
    expect(now?.$$(".stat .u .failing")).toHaveLength(1);
  });
});

describe(MCP_DAY, () => {
  it("draws the calls per hour above the search time per hour, with the same hours on both", async () => {
    call(McpToolName.Search, true, 40);
    call(McpToolName.GetFact, true, 1);
    const day = (await open()).section(MCP_DAY);
    expect(day?.svgs()).toHaveLength(2);
    expect(day?.$$("figcaption").map((c) => squash(c.textContent))).toEqual([
      "Tool calls per hour",
      "Search time per hour",
    ]);
    const hourLabels = (svg: View): string[] =>
      svg
        .$$("g.axis text")
        .map((t) => squash(t.textContent))
        .filter((t) => /^\d\d:00$/.test(t));
    const [calls, search] = day?.svgs() ?? [];
    expect(hourLabels(calls)).toEqual(hourLabels(search));
    // The hit slots of the 2 charts sit at the same x positions.
    const slotXs = (svg: View): (string | null)[] => svg.$$("g.slot rect.hit").map((r) => r.getAttribute("x"));
    expect(slotXs(calls)).toEqual(slotXs(search));
    expect(day?.$$("svg g.axis-title text").map((t) => squash(t.textContent))).toEqual(
      expect.arrayContaining(["hour", "calls", "ms"]),
    );
    expect(day?.$$("svg g.reference").map((g) => squash(g.textContent))).toEqual([`${SEARCH_BAR_MS} ms`]);
    const tips = titlesOf(day);
    expect(tips.some((t) => t.startsWith(hourLabel(NOW)) && t.includes("calls: 2"))).toBe(true);
    expect(tips.some((t) => t.startsWith(hourLabel(NOW)) && t.includes("p95: 40"))).toBe(true);
    // 1 series: no split by tool.
    expect(tips.join("\n")).not.toMatch(/getFact|search:/);
  });

  it("says in each chart's place that nothing happened in 24 hours when nothing did", async () => {
    const day = (await open()).section(MCP_DAY);
    expect(day?.svgs()).toEqual([]);
    for (const text of ["No call in 24 hours", "No search in 24 hours"]) expect(day?.text).toContain(text);
  });

  it("counts the failed calls of the 24 hours and colors them by their own count: ok at 0, warning over 0", async () => {
    const none = (await open()).section(MCP_DAY);
    expect(none?.stat("Failed tool calls")).toBe("0");
    expect(levelOfStat(none, "Failed tool calls")).toBe("ok");
    // A failure older than the last hour counts, though the failed calls row (the last hour) stays ok.
    call(McpToolName.GetFact, false, 1, NOW - 5 * CALL_BUCKET_MS);
    const old = (await open()).section(MCP_DAY);
    expect(old?.stat("Failed tool calls")).toBe("1");
    expect(levelOfStat(old, "Failed tool calls")).toBe("warning");
    call(McpToolName.Search, false, 1);
    const recent = (await open()).section(MCP_DAY);
    expect(recent?.stat("Failed tool calls")).toBe("2");
    expect(levelOfStat(recent, "Failed tool calls")).toBe("warning");
  });
});

describe(WORKER_NOW, () => {
  it("shows the stats State, Queue and Rate, with no group title", async () => {
    const worker = (await open()).section(WORKER_NOW);
    expect(statLabels(worker)).toEqual(["State", "Queue", "Rate"]);
    expect(worker?.$$("div.subsection")).toEqual([]);
  });

  it("shows the requests processed in the last hour as the rate, in ink", async () => {
    expect((await open()).section(WORKER_NOW)?.stats().Rate).toMatchObject({ value: "0", under: "per hour" });
    for (let i = 0; i < 3; i++) done(ChangeOutcome.Accepted, NOW - 4000 - i, NOW - 1000 - i);
    // A split is not a request processed, and an older one is outside the rolling hour.
    done(ChangeOutcome.Split, NOW - 3000, NOW - 2000);
    done(ChangeOutcome.Accepted, NOW - 3 * CALL_BUCKET_MS - 10, NOW - 3 * CALL_BUCKET_MS);
    const worker = (await open()).section(WORKER_NOW);
    expect(worker?.stats().Rate?.value).toBe("3");
    expect(levelOfStat(worker, "Rate")).toBe("");
  });

  it("shows the state of the worker and the time of its last poll", async () => {
    expect((await open()).section(WORKER_NOW)?.stat("State")).toBe("stopped");
    writeWorkerStatus(w.store, { pid: 4242, startedAt: T0, lastPollAt: NOW - 5000, consecutiveFailures: 0 });
    const running = (await open()).section(WORKER_NOW);
    expect(running?.stat("State")).toBe("running");
    expect(running?.stats().State?.under).toBe("polled 5 s ago");
  });

  it("shows a paused worker as paused, in the warning color, with the reason and the end of the wait; ok again after a call", async () => {
    const until = NOW + 5 * 60_000;
    writeWorkerStatus(w.store, {
      pid: 4242,
      startedAt: T0,
      lastPollAt: NOW,
      consecutiveFailures: 0,
      state: WorkerState.Paused,
      pausedUntil: until,
      pauseReason: PauseReason.RateLimit,
    });
    const paused = (await open()).section(WORKER_NOW);
    expect(paused?.stat("State")).toBe("paused");
    const sameDay = new Date(until).toDateString() === new Date(NOW).toDateString();
    expect(paused?.stats().State?.under).toBe(`rate limit, until ${sameDay ? clock(until) : dayClock(until)}`);
    expect(levelOfStat(paused, "State")).toBe("warning");
    writeWorkerStatus(w.store, {
      pid: 4242,
      startedAt: T0,
      lastPollAt: NOW,
      consecutiveFailures: 0,
      lastCall: { ok: true, at: NOW },
    });
    const resumed = (await open()).section(WORKER_NOW);
    expect(resumed?.stat("State")).toBe("running");
    expect(levelOfStat(resumed, "State")).toBe("ok");
  });

  it("shows the end of a rate limit as a time of day when it is today, and with its date when it is on a later day", async () => {
    const pause = (until: number): void =>
      writeWorkerStatus(w.store, {
        pid: 4242,
        startedAt: T0,
        lastPollAt: Date.now(),
        consecutiveFailures: 0,
        state: WorkerState.Paused,
        pausedUntil: until,
        pauseReason: PauseReason.RateLimit,
      });
    // Noon of the day of the clock: an end at 23:59 is today, and 3 days later is not.
    const today = new Date(NOW);
    const endOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59).getTime();
    vi.setSystemTime(new Date(today.getFullYear(), today.getMonth(), today.getDate(), 12, 0).getTime());
    pause(endOfToday);
    expect((await open()).section(WORKER_NOW)?.stats().State?.under).toBe(`rate limit, until ${clock(endOfToday)}`);
    const nextWeek = endOfToday + 3 * DAY_MS;
    pause(nextWeek);
    const page = await open();
    expect(page.section(WORKER_NOW)?.stats().State?.under).toBe(`rate limit, until ${dayClock(nextWeek)}`);
    // The status line names the end of the wait the same way.
    expect(topLines(page)[0]).toContain(`next try at ${dayClock(nextWeek)}`);
  });

  it("offers the buttons Run a batch now and Pause in the head of the panel, with the dialog of the pause or of the resume, which confirm at once", async () => {
    pollNow();
    const page = await open();
    expect(page.section(WORKER_NOW)?.buttons().slice(0, 2)).toEqual(["Run a batch now", "Pause"]);
    const pause = page.formTo("/console/w/alpha/health/pause");
    expect(pause?.fields.map((f) => f.name)).toContain("note");
    expect(pause?.fields.find((f) => f.name === "confirm")?.value).toBe("1");
    expect(page.headings("h2")).toContain("Pause the queue");
    enqueueRequest(w.store, { change: "a", justification: "j" }, NOW - 10);
    enqueueRequest(w.store, { change: "b", justification: "j" }, NOW - 5);
    setQueuePause(w.store, "measuring", NOW);
    const paused = await open();
    expect(paused.section(WORKER_NOW)?.buttons().slice(0, 2)).toEqual(["Run a batch now", "Resume"]);
    const resume = paused.formTo("/console/w/alpha/health/resume");
    expect(resume?.fields.map((f) => f.name)).toEqual(["confirm"]);
    expect(resume?.fields[0]?.value).toBe("1");
    expect(paused.headings("h2")).toContain("Resume the queue");
    // The dialog carries the number of queued requests.
    expect(paused.text).toMatch(/\b2 queued requests\b/);
  });

  it("says that the queue is on hold while the key exists, in place of a wait", async () => {
    pollNow();
    enqueueRequest(w.store, { change: "a", justification: "j" }, NOW - 10);
    setQueuePause(w.store, "measuring", NOW);
    const queued = (await open()).section(WORKER_NOW)?.stats().Queue;
    expect(queued?.value).toBe("1");
    expect(queued?.under).toBe("on hold");
  });

  it("shows no control to pause where the console does not write", async () => {
    const remote = openTmpWiki("alpha", { mode: Mode.Deployed });
    try {
      expect(parse(await healthPage(remote.ctx())).buttons()).toEqual([]);
    } finally {
      remote.close();
    }
  });

  it("shows the queue paused by the operator as paused, in the warning color, with the time; the status line names the note", async () => {
    const since = NOW - 10 * 60_000;
    pollNow();
    // The key alone is enough: the worker has not seen it yet.
    setQueuePause(w.store, "before the eval", since);
    const page = await open();
    const paused = page.section(WORKER_NOW);
    expect(paused?.stat("State")).toBe("paused");
    expect(paused?.stats().State?.under).toBe(`operator, ${clock(since)}`);
    expect(levelOfStat(paused, "State")).toBe("warning");
    expect(topLines(page)).toEqual([`Warning. The operator paused the queue at ${clock(since)}: “before the eval”`]);
    expect(page.headings("h1")[0]).toContain("warning");
  });

  it("shows a running worker, with no status line, when the key is gone but the status still says paused by the operator", async () => {
    writeWorkerStatus(w.store, {
      pid: 4242,
      startedAt: T0,
      lastPollAt: NOW,
      consecutiveFailures: 0,
      state: WorkerState.Paused,
      pauseReason: PauseReason.Operator,
      pausedSince: NOW - 60_000,
    });
    const page = await open();
    const worker = page.section(WORKER_NOW);
    expect(worker?.stat("State")).toBe("running");
    expect(levelOfStat(worker, "State")).toBe("ok");
    expect(topLines(page)).toEqual([]);
  });

  it("shows the queue length with its estimated wait, and no wait for an empty queue", async () => {
    expect((await open()).section(WORKER_NOW)?.stats().Queue?.under).toBe("no wait");
    enqueueRequest(w.store, { change: "a", justification: "j" }, NOW - 10);
    enqueueRequest(w.store, { change: "b", justification: "j" }, NOW - 5);
    const queued = (await open()).section(WORKER_NOW)?.stats().Queue;
    expect(queued?.value).toBe("2");
    expect(queued?.under).toContain("wait");
  });

  it("colors the state by the worker row: ok when it polled, failing when it did not", async () => {
    expect(levelOfStat((await open()).section(WORKER_NOW), "State")).toBe("failing");
    pollNow();
    expect(levelOfStat((await open()).section(WORKER_NOW), "State")).toBe("ok");
    const stopped = openTmpWiki("alpha", { childRunning: false });
    try {
      pollNow(stopped.store);
      expect(levelOfStat((await open(stopped)).section(WORKER_NOW), "State")).toBe("failing");
    } finally {
      stopped.close();
    }
  });

  it("leaves the queue in ink and says nothing about it in the status line, however long it is", async () => {
    pollNow();
    for (let i = 0; i < 606; i++) enqueueRequest(w.store, { change: `q${i}`, justification: "j" }, NOW - 10);
    const page = await open();
    expect(levelOfStat(page.section(WORKER_NOW), "Queue")).toBe("");
    expect(page.section(WORKER_NOW)?.stats().Queue).toMatchObject({ value: "606" });
    expect(page.section(WORKER_NOW)?.stats().Queue?.under).toMatch(/ h wait$/);
    expect(topLines(page)).toEqual([]);
  });
});

describe(WORKER_DAY, () => {
  it("draws the requests processed per hour above the queue length per hour, with the same hours on both", async () => {
    const id = enqueueRequest(w.store, { change: "c", justification: "j" }, NOW - 5000);
    w.store.db
      .prepare("UPDATE change_requests SET status = 'done', started_at = ?, finished_at = ? WHERE id = ?")
      .run(NOW - 3000, NOW - 1000, id);
    w.store.db
      .prepare("INSERT INTO changes(request_id, outcome, summary, created_at) VALUES (?, 'accepted', 's', ?)")
      .run(id, NOW - 1000);
    // A request that waits now: the queue length of the current hour is 1.
    enqueueRequest(w.store, { change: "q", justification: "j" }, NOW - 500);
    const day = (await open()).section(WORKER_DAY);
    expect(day?.svgs()).toHaveLength(2);
    // The first caption is a defined label: its hidden definition follows the label.
    const captions = day?.$$("figcaption").map((c) => squash(c.textContent)) ?? [];
    expect(captions[0]).toMatch(/^Change requests processed per hour/);
    expect(captions[1]).toBe("Queue length per hour");
    const [processed, queue] = day?.svgs() ?? [];
    const slotXs = (svg: View): (string | null)[] => svg.$$("g.slot rect.hit").map((r) => r.getAttribute("x"));
    expect(slotXs(processed)).toEqual(slotXs(queue));
    const tips = titlesOf(day);
    expect(tips.some((t) => t.startsWith(hourLabel(NOW)) && t.includes("requests: 1"))).toBe(true);
    expect(tips.some((t) => t.startsWith(hourLabel(NOW)) && t.includes("queued: 1"))).toBe(true);
    // 1 series: no split by outcome.
    expect(tips.join("\n")).not.toContain("accepted");
  });

  it("says what processed counts in the caption of the chart, as a definition", async () => {
    done(ChangeOutcome.Accepted, NOW - 3000, NOW - 1000);
    const caption = (await open()).section(WORKER_DAY)?.$$("figcaption .defined")[0];
    expect(caption?.textContent).toBe("Change requests processed per hour");
    expect(caption?.getAttribute("title")).toMatch(/accepted, duplicate, rejected or failed/i);
    expect(caption?.getAttribute("title")).toMatch(/split is not counted/i);
  });

  it("says in each chart's place that nothing happened in 24 hours when nothing did", async () => {
    const day = (await open()).section(WORKER_DAY);
    expect(day?.svgs()).toEqual([]);
    expect(day?.text).toContain("No request in 24 hours");
  });

  it("shows the 3 stats by label", async () => {
    expect(statLabels((await open()).section(WORKER_DAY))).toEqual([
      "Failed change requests",
      "Restarts",
      "Per change request",
    ]);
  });

  it("shows the time per request, in ink, and a dash when none finished", async () => {
    const empty = (await open()).section(WORKER_DAY);
    expect(empty?.stats()["Per change request"]).toMatchObject({ value: "-" });
    for (let i = 0; i < 12; i++) done(ChangeOutcome.Accepted, NOW - 4000 - i, NOW - 1000 - i);
    done(ChangeOutcome.Duplicate, NOW - CALL_BUCKET_MS - 4000, NOW - CALL_BUCKET_MS);
    const history = (await open()).section(WORKER_DAY);
    expect(history?.stats()["Per change request"]).toMatchObject({ value: "3 s" });
    expect(levelOfStat(history, "Per change request")).toBe("");
  });

  it("shows the restarts since the service started, or that the worker is outside the service", async () => {
    const outside = (await open()).section(WORKER_DAY)?.stats().Restarts;
    expect(outside?.under).toContain("outside the service");
    const supervised = openTmpWiki("alpha", { childRunning: true, workerRestarts: 3 });
    try {
      const page = await open(supervised);
      const restarts = page.section(WORKER_DAY)?.stats().Restarts;
      expect(restarts?.value).toBe("3");
      expect(restarts?.under).toBe("since start");
      expect(levelOfStat(page.section(WORKER_DAY), "Restarts")).toBe("warning");
    } finally {
      supervised.close();
    }
    const calm = openTmpWiki("alpha", { childRunning: true, workerRestarts: 0 });
    try {
      expect(levelOfStat((await open(calm)).section(WORKER_DAY), "Restarts")).toBe("ok");
    } finally {
      calm.close();
    }
  });

  it("shows the failed requests, each by its received time, with its error and no button", async () => {
    const { id } = failedRequest("boom &");
    const page = await open();
    const history = page.section(WORKER_DAY);
    expect(history?.stat("Failed change requests")).toBe("1");
    expect(levelOfStat(history, "Failed change requests")).toBe("warning");
    const link = history?.links().find((l) => l.href === `/console/w/alpha/requests/${id}`);
    expect(link?.text).toMatch(/^(\d{4}-\d\d-\d\d )?\d\d:\d\d$/);
    expect(history?.text).not.toContain(id);
    expect(history?.rowOf(`/requests/${id}`)).toEqual(expect.arrayContaining(["3", "boom &"]));
    expect(history?.buttons()).toEqual([]);
  });

  it("colors the failed requests failing when one failed on a credential", async () => {
    failedRequest("401 invalid x-api-key");
    expect(levelOfStat((await open()).section(WORKER_DAY), "Failed change requests")).toBe("failing");
  });

  it("shows no table and no line when no request failed", async () => {
    const page = await open();
    const history = page.section(WORKER_DAY);
    expect(history?.tables()).toEqual([]);
    expect(history?.$("p.note")).toBeNull();
    expect(levelOfStat(history, "Failed change requests")).toBe("ok");
    expect(page.text).not.toContain("Nothing failed in 24 hours.");
  });

  it("cuts a long error and keeps the whole text in a fold", async () => {
    const long = `${"e".repeat(500)}TAIL-OF-THE-ERROR`;
    failedRequest(long);
    const failed = (await open()).section(WORKER_DAY);
    const cell = failed?.rows()[0]?.find((c) => c.startsWith("eee")) ?? "";
    const shown = cell.split("Full error")[0] ?? "";
    expect(shown).toContain("…");
    expect(shown).not.toContain("TAIL-OF-THE-ERROR");
    expect(failed?.folds()).toHaveLength(1);
    expect(failed?.folds()[0]?.view.text).toContain(long);
  });
});

describe("Batch, now", () => {
  const BATCH = "Batch, now";
  const progress = { taken: 3, done: 1, staged: 2, stale: 0, reconciliation: BatchReconciliation.Pending };
  const statusWith = (at: number): void =>
    writeWorkerStatus(w.store, {
      pid: 4242,
      startedAt: T0,
      lastPollAt: NOW,
      consecutiveFailures: 0,
      lastBatchError: { message: "the live wiki moved", at },
    });

  it("shows the time and the error of a failed promotion, with the date when it is not today", async () => {
    writeBatchProgress(w.store, progress);
    const today = NOW - 120_000;
    statusWith(today);
    const text = squash((await open()).section(BATCH)?.text);
    expect(text).toContain(`dropped at ${clock(today)}: the live wiki moved.`);
    expect(text).toContain("run one at a time");
    const old = NOW - 2 * DAY_MS;
    statusWith(old);
    expect(squash((await open()).section(BATCH)?.text)).toContain(`dropped at ${dayClock(old)}:`);
  });

  it("shows no line when the worker status holds no batch error", async () => {
    writeBatchProgress(w.store, progress);
    pollNow();
    const text = squash((await open()).section(BATCH)?.text);
    expect(text).toContain("Staged changes");
    expect(text).not.toContain("dropped");
  });
});
