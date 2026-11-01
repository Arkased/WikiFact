import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ChangeOutcome,
  LogEvent,
  LogLevel,
  OperatorEditKind,
  RejectReason,
  RequestKind,
  RunOnceStatus,
} from "../../domain/enums.js";
import {
  applyChange,
  enqueueOperatorEdit,
  enqueueRequest,
  failAttempt,
  finishRequest,
  seedChange,
  takeNextRequest,
} from "../../store/index.js";
import { DAY, T0, accepted, draft } from "../../../__tests__/helpers/store.js";
import { ConsoleError } from "../errors.js";
import { parseLogLine, isRawLine } from "../logs.js";
import { requestPage, traceWords } from "../pages/request.js";
import { parse, type Page } from "./helpers/dom.js";
import { openTmpWiki, type TmpWiki } from "./helpers/tmp-wiki.js";

let w: TmpWiki;
beforeEach(() => {
  w = openTmpWiki();
});
afterEach(() => w.close());

interface Seeded {
  factId: string;
  update: string;
  duplicate: string;
}

async function seed(): Promise<Seeded> {
  const a = await seedChange(
    w.store,
    accepted([
      draft({ header: "Alpha", content: "Alpha content here." }),
      draft({ header: "Anchor", content: "Anchor content." }),
    ]),
    { now: T0, change: "Alpha is so", justification: "I saw alpha" },
  );
  const factId = a.factIds[0] ?? "";
  const update = enqueueRequest(
    w.store,
    { change: "Alpha is <different>", justification: "I checked it", targets: [factId, "01NOPE"] },
    T0 + DAY,
  );
  takeNextRequest(w.store, T0 + DAY + 1000);
  await applyChange(
    w.store,
    update,
    accepted([draft({ factId, header: "Alpha", content: "Alpha content changed." })]),
    { now: T0 + DAY + 4000 },
  );
  finishRequest(w.store, update, T0 + DAY + 5000);
  const duplicate = await seedChange(
    w.store,
    {
      outcome: ChangeOutcome.Duplicate,
      duplicateOf: factId,
      summary: "same",
      changeReasoning: "r",
      facts: [],
    },
    { now: T0 + 2 * DAY, change: "Alpha again", justification: "me too" },
  );
  return { factId, update, duplicate: duplicate.requestId };
}

function failedRequest(store = w.store): string {
  const id = enqueueRequest(store, { change: "q", justification: "j" }, T0);
  for (let i = 0; i < 3; i++) failAttempt(store, id, "boom", T0 + i);
  return id;
}

// The lines follow the receive time of `update` (T0 + DAY), one second apart; a line may bring its own `ts`.
function writeWorkerLog(lines: Record<string, unknown>[]): void {
  const text = lines
    .map((l, i) => JSON.stringify({ ts: new Date(T0 + DAY + i * 1000).toISOString(), ...l }))
    .join("\n");
  writeFileSync(join(w.logDir, "worker-alpha.1.log"), `${text}\n`);
}

async function open(id: string, wiki: TmpWiki = w): Promise<Page> {
  return parse(await requestPage(wiki.ctx({ id })));
}

describe("requestPage", () => {
  it("shows the change text and the justification as stored, and the heading with its outcome", async () => {
    const s = await seed();
    const page = await open(s.update);
    expect(page.title).toBe("Request - alpha - WikiFact");
    // One marker: the outcome of a done request, never "done" beside it.
    expect(page.headings("h1")[0]).toBe("Request accepted");
    const submission = page.section("Submission");
    expect(submission?.text).toContain("Alpha is <different>");
    expect(submission?.$("different")).toBeNull();
    expect(submission?.text).toContain("I checked it");
    expect(page.$("main")?.hasAttribute("data-refresh")).toBe(false);
  });

  it("shows the timing and the targets with their headers", async () => {
    const s = await seed();
    const page = await open(s.update);
    const timing = page.section("Timing");
    expect(Object.keys(timing?.kv() ?? {})).toEqual(expect.arrayContaining(["Received", "Started", "Finished"]));
    expect(timing?.kvValue("Started")).toContain("1 s");
    expect(timing?.kvValue("Finished")).toContain("4 s");
    expect(timing?.kvValue("Failed attempts")).toBeUndefined();
    const targets = timing?.kvView("Targets");
    expect(targets?.href("Alpha")).toBe(`/console/w/alpha/facts/${s.factId}`);
    expect(targets?.text).toContain("01NOPE");
    expect(targets?.links().map((l) => l.text)).not.toContain("01NOPE");
    expect(timing?.kvValue("Prior query")).toBeUndefined();
  });

  it("shows the result with the outcome and the time, the diff and the fold of the agent's text, and no seq", async () => {
    const s = await seed();
    const result = (await open(s.update)).section("Result");
    expect(result).toBeDefined();
    expect(result?.text).not.toMatch(/seq/);
    // The console has no change page.
    expect(result?.links().find((l) => l.href.includes("/changes/"))).toBeUndefined();
    expect(result?.$("header.panel-head")?.textContent).toMatch(/accepted\s+\d{4}-\d\d-\d\d \d\d:\d\d/);
    expect(result?.href("Alpha")).toBe(`/console/w/alpha/facts/${s.factId}`);
    expect(result?.text).toContain("changed");
    expect(result?.removed()).toEqual(expect.arrayContaining(["here."]));
    expect(result?.inserted()).toContain("changed.");
    const reasoning = result?.fold("Justification and reasoning");
    expect(reasoning?.text).toContain("I measured 10 damage.");
    expect(reasoning?.text).toContain("test reasoning");
  });

  it("shows a new fact plain, and its references as header links with a deleted one keeping its header and a marker", async () => {
    const s = await seed();
    const gone =
      (await seedChange(w.store, accepted([draft({ header: "Gone base", content: "G." })]), { now: T0 + DAY }))
        .factIds[0] ?? "";
    await seedChange(
      w.store,
      accepted([{ factId: gone, header: "", content: "", justification: "x", references: [], isDeleted: true }]),
      { now: T0 + DAY + 1 },
    );
    const dependent = await seedChange(
      w.store,
      accepted([draft({ header: "Dependent", content: "Dependent body.", references: [s.factId, gone] })]),
      { now: T0 + 3 * DAY },
    );
    const result = (await open(dependent.requestId)).section("Result");
    expect(result?.text).toContain("new");
    expect(result?.text).toContain("Dependent body.");
    expect(result?.inserted()).toEqual([]);
    expect(result?.href("Alpha")).toBe(`/console/w/alpha/facts/${s.factId}`);
    expect(result?.href("Gone base")).toBe(`/console/w/alpha/facts/${gone}`);
    expect(result?.itemWith(`/facts/${gone}`)?.text).toContain("deleted");
    expect(result?.links().map((l) => l.text)).not.toEqual(expect.arrayContaining([gone]));
    expect(result?.links().map((l) => l.text)).not.toEqual(expect.arrayContaining([s.factId]));
  });

  it("shows the Submission and Timing panels", async () => {
    const s = await seed();
    expect((await open(s.update)).headings()).toEqual(expect.arrayContaining(["Submission", "Timing"]));
  });

  it("shows the duplicate target with its header in the timing", async () => {
    const s = await seed();
    const page = await open(s.duplicate);
    expect(page.text).toContain("duplicate");
    expect(page.section("Timing")?.kvView("Duplicate of")?.href("Alpha")).toBe(`/console/w/alpha/facts/${s.factId}`);
    expect(page.section("Result")?.text).toContain("duplicate");
    expect(
      page
        .section("Result")
        ?.links()
        .filter((l) => l.href.includes("/facts/")),
    ).toEqual([]);
  });

  it("shows a split request with the word split and a link to each child, and a child with a link to its parent", async () => {
    const parent = enqueueRequest(w.store, { change: "A and B", justification: "j" }, T0);
    takeNextRequest(w.store, T0 + 1);
    const split = await applyChange(
      w.store,
      parent,
      {
        outcome: ChangeOutcome.Split,
        summary: "Split into 2 claims.",
        changeReasoning: "r",
        claims: ["Claim A.", "Claim B."],
        facts: [],
      },
      { now: T0 + 2 },
    );
    finishRequest(w.store, parent, T0 + 3);
    const page = await open(parent);
    expect(page.headings("h1")[0]).toMatch(/\bsplit\b/);
    const children = page.section("Split into");
    expect(children?.text).toContain("Claim A.");
    expect(children?.links().map((l) => l.href)).toEqual(split.childIds.map((id) => `/console/w/alpha/requests/${id}`));
    const child = await open(split.childIds[1] ?? "");
    const from = child.section("Timing")?.kvView("Split from");
    expect(from?.links().map((l) => l.href)).toEqual([`/console/w/alpha/requests/${parent}`]);
    // The link text is the received time of the parent, never its id.
    expect(from?.links()[0]?.text).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d$/);
    expect(from?.text).not.toContain(parent);
  });

  it("follows a queued request in place, shows the retry wait and the error of a failed attempt", async () => {
    const queued = enqueueRequest(w.store, { change: "q", justification: "j" }, T0);
    failAttempt(w.store, queued, "first failure", T0 + 1);
    const page = await open(queued);
    expect(page.$("main")?.getAttribute("data-refresh")).toBeTruthy();
    expect(page.section("Error")?.text).toContain("first failure");
    expect(page.headings("h1")[0]).toContain("queued");
    expect(page.section("Timing")?.kvValue("Failed attempts")).toContain("1");
    expect(page.section("Timing")?.text).toMatch(/\d+ s/);
  });

  it("shows the stored message of a rejected request as its reason, not as an error", async () => {
    const rejected = await seedChange(
      w.store,
      {
        outcome: ChangeOutcome.Rejected,
        rejectReason: RejectReason.Compound,
        summary: "two claims",
        changeReasoning: "r",
        facts: [],
      },
      { now: T0, change: "Beta is so and Gamma is so", justification: "I saw both" },
    );
    finishRequest(w.store, rejected.requestId, T0 + 1, "The change holds two claims.");
    const page = await open(rejected.requestId);
    expect(page.section("Reason")?.text).toContain("two claims");
    expect(page.section("Error")).toBeUndefined();
  });

  it("shows a request the worker has not run with no change and no error", async () => {
    const queued = enqueueRequest(w.store, { change: "q", justification: "j" }, T0);
    const page = await open(queued);
    expect(page.section("Result")?.links()).toEqual([]);
    expect(page.section("Result")?.text).toBeTruthy();
    expect(page.section("Error")).toBeUndefined();
  });

  it("shows a failed request as a record with its error, and offers no Requeue button", async () => {
    const failed = failedRequest();
    const page = await open(failed);
    expect(page.within("main")?.buttons()).toEqual([]);
    expect(page.forms().filter((f) => f.method === "post")).toEqual([]);
    expect(page.$("main")?.hasAttribute("data-refresh")).toBe(false);
    expect(page.text).toContain("boom");
  });

  it("shows an operator edit as its document and a lookup repair as having no text", async () => {
    const edit = enqueueOperatorEdit(w.store, { edit: OperatorEditKind.Reindex, note: "after the <fix>" }, T0);
    const page = await open(edit);
    const submission = page.section("Submission");
    expect(submission?.kvValue("Operator edit")).toBe("reindex");
    expect(submission?.kvValue("Why")).toBe("after the <fix>");
    expect(submission?.text).not.toContain("Justification");
    const s = await seed();
    const repair = enqueueRequest(w.store, { kind: RequestKind.LookupRepair, targets: [s.factId] }, T0 + 3 * DAY);
    const repairPage = await open(repair);
    expect(repairPage.section("Submission")?.text).toBeTruthy();
    expect(repairPage.href("Alpha")).toBe(`/console/w/alpha/facts/${s.factId}`);
  });

  it("renders the trace in words from the worker log, oldest first, this request only", async () => {
    const s = await seed();
    writeWorkerLog([
      // Before the request was received: outside the trace, and the read stops there (an id reused by a stale line).
      {
        ts: new Date(T0).toISOString(),
        event: LogEvent.Gather,
        level: LogLevel.Info,
        request_id: s.update,
        droppedTarget: "stale",
      },
      { event: LogEvent.Gather, level: LogLevel.Info, request_id: s.update, droppedTarget: "01NOPE" },
      { event: LogEvent.Change, level: LogLevel.Info, request_id: "other", seq: 9, tokens: { input: 7771, output: 1 } },
      {
        event: LogEvent.Change,
        level: LogLevel.Info,
        request_id: s.update,
        seq: 2,
        outcome: "accepted",
        passes: 1,
        rejudged: 0,
        tokens: { input: 1200, output: 340 },
        duration_ms: 31_000,
      },
    ]);
    const trace = (await open(s.update)).section("Trace");
    // The change line is 4 plain rows; every other line is 1 row.
    expect(trace?.kvValue("Model tokens")).toBe("1,200 in, 340 out");
    expect(trace?.kvValue("Duration")).toBe("31 s");
    expect(trace?.kvValue("Dependents checked")).toBe("1");
    expect(trace?.kvValue("Dependents re-judged")).toBe("0");
    expect(trace?.kvValue("Claim check")).toContain("01NOPE");
    expect(Object.keys(trace?.kv() ?? {})).toHaveLength(5);
    expect(trace?.text).not.toContain("committed");
    expect(trace?.text).not.toContain("7771");
    expect(trace?.text).not.toContain("stale");
  });

  it("says when the trace is gone, there is no log file yet, or there is no log directory", async () => {
    const s = await seed();
    const noFile = (await open(s.update)).section("Trace")?.text ?? "";
    expect(noFile).toContain("worker-alpha");
    writeWorkerLog([{ event: LogEvent.Gather, level: LogLevel.Info, request_id: "other", droppedTarget: "x" }]);
    const rolled = (await open(s.update)).section("Trace");
    expect(rolled?.rows()).toEqual([]);
    expect(rolled?.text).not.toBe(noFile);
    expect(rolled?.text).toContain("No trace");
    const noLogs = openTmpWiki("beta", { withLogDir: false });
    try {
      const r = await seedChange(noLogs.store, accepted([draft()]), { now: T0 });
      const none = (await open(r.requestId, noLogs)).section("Trace");
      expect(none?.text).toContain("log directory");
    } finally {
      noLogs.close();
    }
  });

  it("is 404 for an unknown request", async () => {
    await expect(requestPage(w.ctx({ id: "nope" }))).rejects.toBeInstanceOf(ConsoleError);
  });
});

describe("traceWords", () => {
  const rec = (fields: Record<string, unknown>) => {
    const line = parseLogLine(JSON.stringify({ ts: new Date(T0).toISOString(), level: "info", ...fields }));
    if (isRawLine(line)) throw new Error("raw");
    return line;
  };
  const words = (fields: Record<string, unknown>) => parse(traceWords("alpha", rec(fields)));

  it("carries the ids, the results and the numbers of each pipeline line", () => {
    const overmatch = words({ event: LogEvent.ScopeOvermatch, existingFactId: "F1", reason: "x" });
    expect(overmatch.href("F1")).toBe("/console/w/alpha/facts/F1");
    expect(words({ event: LogEvent.PriorQuery, result: "hit", factId: "F1" }).text).toContain("hit");
    expect(words({ event: LogEvent.LookupRepair, skipped: "found" }).text).toContain("found");
    const failed = words({ event: LogEvent.AttemptFailed, attempt: 3, status: RunOnceStatus.Failed, error: "e" });
    expect(failed.text).toContain("3");
    expect(failed.text).toContain("e");
    const requeued = words({ event: LogEvent.AttemptFailed, attempt: 2, status: RunOnceStatus.Queued, error: "e" });
    expect(requeued.text).not.toBe(failed.text);
    expect(words({ event: LogEvent.Scope, droppedMatch: "F2" }).href("F2")).toBe("/console/w/alpha/facts/F2");
    expect(words({ event: LogEvent.Judge, droppedWrongRelated: "F3" }).href("F3")).toBe("/console/w/alpha/facts/F3");
    expect(words({ event: "custom_thing", a: 1 }).text).toContain("custom_thing");
  });
});
