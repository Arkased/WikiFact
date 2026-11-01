import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChangeOutcome, CleanupFinder, Mode, OperatorEditKind, RejectReason } from "../../domain/enums.js";
import {
  CLEANUP_EVERY,
  CLEANUP_FINDERS,
  writeCleanupEvery,
  enqueueOperatorEdit,
  enqueueRequest,
  enqueueCleanupRepair,
  failAttempt,
  finishRequest,
  writeCleanupFull,
  writeCleanupPending,
  writeCleanupSeq,
} from "../../store/index.js";
import { T0 } from "../../../__tests__/helpers/store.js";
import { healthPage } from "../pages/health.js";
import { jobName, nextRun } from "../pages/jobs.js";
import { parse, type Page } from "./helpers/dom.js";
import { openTmpWiki, type TmpWiki } from "./helpers/tmp-wiki.js";

let w: TmpWiki;
beforeEach(() => {
  w = openTmpWiki();
});
afterEach(() => w.close());

async function open(wiki: TmpWiki = w): Promise<Page> {
  return parse(await healthPage(wiki.ctx()));
}

// 1 change of the given outcome, so that the highest seq rises by 1; returns the id of its request.
function write(at: number, outcome = ChangeOutcome.Accepted): string {
  const id = enqueueRequest(w.store, { change: "c", justification: "j" }, at);
  w.store.db
    .prepare("INSERT INTO changes(request_id, outcome, reject_reason, summary, created_at) VALUES (?, ?, ?, 's', ?)")
    .run(id, outcome, outcome === ChangeOutcome.Rejected ? RejectReason.Unsupported : null, at);
  return id;
}

// The whole cleanup state in 1 call: every finder last ran at `seq`.
function ranAt(seq: number): void {
  writeCleanupSeq(w.store, Object.fromEntries(CLEANUP_FINDERS.map((f) => [f, seq])) as Record<CleanupFinder, number>);
}

// The row of a job, by its first cell.
const rowOf = (page: Page, job: string): string[] => page.row(job) ?? [];
const FINDER = CleanupFinder.DuplicateFact;
const JOB = jobName(FINDER);
const REINDEX = "Rebuild the search index";
const PAIR: [string, string] = ["f1", "f2"];

describe("the section Jobs of the Operation page", () => {
  it("has 1 row per finder of the cleanup, in order, then the reindex, also on an empty wiki", async () => {
    const page = await open();
    // The table is the last section of the Operation page, under the heading Jobs.
    expect(page.headings()).toContain("Jobs");
    expect(page.section("Jobs")?.$("table")).not.toBeNull();
    expect(page.rows().map((r) => r[0])).toEqual([...CLEANUP_FINDERS.map(jobName), REINDEX]);
    expect(page.headers().map((h) => h.label)).toEqual(["Job", "Every", "Last run", "Next run", "Result", ""]);
    expect(page.$("main")?.getAttribute("data-refresh")).toBeTruthy();
  });

  it("names the jobs as verbs", async () => {
    const page = await open();
    expect(page.rows().map((r) => r[0])).toEqual(["Merge duplicate facts", "Rebuild the search index"]);
  });

  it("states the interval of each job in writes from meta, and manual for the reindex", async () => {
    const every = { ...CLEANUP_EVERY, [FINDER]: CLEANUP_EVERY[FINDER] * 2 };
    writeCleanupEvery(w.store, every);
    const page = await open();
    for (const finder of CLEANUP_FINDERS) {
      expect(rowOf(page, jobName(finder))[1]).toBe(`${every[finder]} writes`);
    }
    expect(rowOf(page, REINDEX)[1]).toBe("manual");
  });

  it("says never where there is no run, and a dash for the next run and the result of the reindex", async () => {
    const page = await open();
    expect(rowOf(page, JOB)[2]).toBe("never");
    expect(rowOf(page, REINDEX)[2]).toBe("never");
    expect(rowOf(page, REINDEX)[3]).toBe("-");
    expect(rowOf(page, REINDEX)[4]).toBe("-");
  });

  it("shows the next run as a condition: in N writes, then after the current request, 1 under and 1 over", async () => {
    write(T0 + 1);
    ranAt(1);
    const interval = CLEANUP_EVERY[FINDER];
    // 0 writes since the last run: all of the interval is left.
    expect(rowOf(await open(), JOB)[3]).toBe(`in ${interval} write${interval === 1 ? "" : "s"}`);
    for (let i = 0; i < interval; i++) write(T0 + 10 + i);
    // The interval has passed: the finder starts when the request that runs ends.
    expect(rowOf(await open(), JOB)[3]).toBe("after the current request");
    write(T0 + 100);
    expect(rowOf(await open(), JOB)[3]).toBe("after the current request");
  });

  it("does not count a rejection, a duplicate or a split as a write", async () => {
    write(T0 + 1);
    ranAt(1);
    const interval = CLEANUP_EVERY[FINDER];
    for (let i = 0; i < interval; i++) {
      write(T0 + 10 + i, [ChangeOutcome.Rejected, ChangeOutcome.Duplicate, ChangeOutcome.Split][i % 3]);
    }
    expect(rowOf(await open(), JOB)[3]).toBe(`in ${interval} write${interval === 1 ? "" : "s"}`);
  });

  it("shows at the next write for a finder that the cap cut", async () => {
    write(T0 + 1);
    ranAt(1);
    writeCleanupFull(w.store, [FINDER]);
    const page = await open();
    expect(rowOf(page, JOB)[3]).toBe("at the next write");
  });

  it("shows after its repairs for a pending finder with a queued repair, over the cap and the interval", async () => {
    write(T0 + 1);
    ranAt(1);
    writeCleanupFull(w.store, [FINDER]);
    writeCleanupPending(w.store, [FINDER]);
    enqueueCleanupRepair(w.store, { finder: FINDER, factIds: PAIR }, T0 + 2);
    expect(rowOf(await open(), JOB)[3]).toBe("after its repairs");
  });

  it("shows the last run as the time only", async () => {
    write(T0 + 1);
    ranAt(1);
    write(T0 + 2);
    write(T0 + 3);
    const last = rowOf(await open(), JOB)[2] ?? "";
    expect(last).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d$/);
  });

  it("links the result to the request of the last run: repaired, nothing found, failing, or the status", async () => {
    write(T0 + 1);
    ranAt(1);
    const link = (page: Page, id: string) => page.links().find((l) => l.href === `/console/w/alpha/requests/${id}`);
    // A request that wrote: repaired.
    const wrote = enqueueCleanupRepair(w.store, { finder: FINDER, factIds: PAIR }, T0 + 5);
    w.store.db
      .prepare("INSERT INTO changes(request_id, outcome, summary, created_at) VALUES (?, ?, 's', ?)")
      .run(wrote, ChangeOutcome.Accepted, T0 + 6);
    finishRequest(w.store, wrote, T0 + 7);
    let page = await open();
    expect(link(page, wrote)?.text).toBe("repaired");
    expect(rowOf(page, JOB)[4]).toBe("repaired");
    // A later request that wrote nothing: nothing found.
    const nothing = enqueueCleanupRepair(w.store, { finder: FINDER, factIds: ["f3", "f4"] }, T0 + 8);
    finishRequest(w.store, nothing, T0 + 9);
    page = await open();
    expect(link(page, nothing)?.text).toBe("nothing found");
    // A later failed request: the failing word.
    const failed = enqueueCleanupRepair(w.store, { finder: FINDER, factIds: ["f5", "f6"] }, T0 + 11);
    for (let i = 0; i < 3; i++) failAttempt(w.store, failed, "boom", T0 + 12 + i);
    page = await open();
    expect(link(page, failed)?.text).toBe("failing");
  });

  it("links a request that is still queued with its status word", async () => {
    write(T0 + 1);
    ranAt(1);
    const queued = enqueueCleanupRepair(w.store, { finder: FINDER, factIds: PAIR }, T0 + 10);
    const page = await open();
    expect(page.links().find((l) => l.href === `/console/w/alpha/requests/${queued}`)?.text).toBe("queued");
  });

  it("shows a dash as the result of a finder with no request", async () => {
    write(T0 + 1);
    ranAt(1);
    expect(rowOf(await open(), JOB)[4]).toBe("-");
  });

  it("shows the reindex as the time of its last request, with the link to it", async () => {
    const reindex = enqueueOperatorEdit(w.store, { edit: OperatorEditKind.Reindex, note: "n" }, T0 + 5);
    const page = await open();
    expect(rowOf(page, REINDEX)[2]).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d$/);
    expect(page.itemWith(`/requests/${reindex}`)?.text).toContain(REINDEX);
    expect(page.itemWith(`/requests/${reindex}`)?.text).toContain("queued");
  });

  it("offers Run on every row, as the forms of the 2 Run routes with a note", async () => {
    const page = await open();
    expect(page.buttons().filter((b) => b === "Run")).toHaveLength(CLEANUP_FINDERS.length + 1);
    for (const path of ["/console/w/alpha/jobs/cleanup", "/console/w/alpha/jobs/reindex"]) {
      const form = page.formTo(path);
      expect(form?.method, path).toBe("post");
      expect(
        form?.fields.map((f) => f.name),
        path,
      ).toContain("note");
      expect(form?.fields.find((f) => f.name === "confirm")?.value, path).toBe("0");
    }
  });

  it("offers no Run while the console's writes are off", async () => {
    const deployed = openTmpWiki("alpha", { mode: Mode.Deployed });
    try {
      const page = await open(deployed);
      expect(page.buttons()).toEqual([]);
      expect(page.forms().filter((f) => f.method === "post")).toEqual([]);
      expect(page.rows()).toHaveLength(CLEANUP_FINDERS.length + 1);
    } finally {
      deployed.close();
    }
  });
});

describe("nextRun", () => {
  it("counts down the writes of the interval and stops at 0, 1 under and 1 over", () => {
    const interval = CLEANUP_EVERY[FINDER];
    const at = (writesSince: number): string => nextRun({ pending: false, capped: false, interval, writesSince });
    expect(at(interval - 2)).toBe("in 2 writes");
    expect(at(interval - 1)).toBe("in 1 write");
    expect(at(interval)).toBe("after the current request");
    expect(at(interval + 1)).toBe("after the current request");
    expect(nextRun({ pending: false, capped: true, interval, writesSince: 0 })).toBe("at the next write");
    expect(nextRun({ pending: true, capped: true, interval, writesSince: interval })).toBe("after its repairs");
  });
});
