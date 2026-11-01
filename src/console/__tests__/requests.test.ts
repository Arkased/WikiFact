import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { ChangeOutcome, RejectReason, RequestKind, RequestStatus } from "../../domain/enums.js";
import {
  applyChange,
  enqueueRequest,
  failAttempt,
  finishRequest,
  seedChange,
  takeNextRequest,
} from "../../store/index.js";
import { DAY, T0, accepted, draft } from "../../../__tests__/helpers/store.js";
import { ConsoleError } from "../errors.js";
import { requestsPage, followsQueue } from "../pages/requests.js";
import { parse, queryOf, type Page } from "./helpers/dom.js";
import { openTmpWiki, type TmpWiki } from "./helpers/tmp-wiki.js";

let w: TmpWiki;
beforeEach(() => {
  w = openTmpWiki();
});
afterEach(() => w.close());

interface Seeded {
  factId: string;
  first: string;
  update: string;
  rejected: string;
  failed: string;
  queued: string;
  repair: string;
}

async function seed(): Promise<Seeded> {
  const a = await seedChange(w.store, accepted([draft({ header: "Alpha", content: "Alpha content." })]), {
    now: T0,
    change: "Alpha is so <b>",
    justification: "I saw alpha",
  });
  const factId = a.factIds[0] ?? "";
  const update = enqueueRequest(w.store, { change: "Alpha is different", justification: "I checked" }, T0 + DAY);
  takeNextRequest(w.store, T0 + DAY + 1000);
  await applyChange(w.store, update, accepted([draft({ factId, header: "Alpha", content: "Alpha 2." })]), {
    now: T0 + DAY + 4000,
  });
  finishRequest(w.store, update, T0 + DAY + 5000);
  const rejected = await seedChange(
    w.store,
    {
      outcome: ChangeOutcome.Rejected,
      rejectReason: RejectReason.Unsupported,
      summary: "no support",
      changeReasoning: "r",
      facts: [],
    },
    { now: T0 + 2 * DAY, change: "Beta is so", justification: "I believe" },
  );
  const failed = enqueueRequest(w.store, { change: "Gamma is so", justification: "j" }, T0 + 3 * DAY);
  for (let i = 0; i < 3; i++) failAttempt(w.store, failed, "boom", T0 + 3 * DAY + i);
  const queued = enqueueRequest(w.store, { change: "Delta is so", justification: "j" }, T0 + 4 * DAY);
  const repair = enqueueRequest(w.store, { kind: RequestKind.LookupRepair, targets: [factId] }, T0 + 5 * DAY);
  return { factId, first: a.requestId, update, rejected: rejected.requestId, failed, queued, repair };
}

async function open(query = ""): Promise<Page> {
  return parse(await requestsPage(w.ctx({}, query)));
}

// The ids of the requests a page lists, in page order.
function listed(page: Page): string[] {
  return page
    .links()
    .map((l) => /\/requests\/([^/?]+)$/.exec(l.href)?.[1])
    .filter((id): id is string => id !== undefined);
}

const reqPath = (id: string): string => `/console/w/alpha/requests/${id}`;

describe("requestsPage", () => {
  it("shows no table on an empty wiki, and no link to a comparison of 2 points", async () => {
    const page = await open();
    expect(page.title).toBe("Requests - alpha - WikiFact");
    expect(page.tables()).toEqual([]);
    expect(page.link("Compare two points")).toBeUndefined();
    expect(page.$("main")?.hasAttribute("data-refresh")).toBe(false);
  });

  it("links each request through its received time and shows no id", async () => {
    const s = await seed();
    const page = await open();
    for (const id of [s.first, s.update, s.rejected, s.failed, s.queued, s.repair]) {
      const link = page.links().find((l) => l.href === reqPath(id));
      expect(link?.text, id).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d$/);
      expect(page.text).not.toContain(id);
    }
  });

  it("shows the status, the outcome, the duration, the kind in words and the change text as text", async () => {
    const s = await seed();
    const page = await open();
    const cells = (id: string): string[] => page.rowOf(reqPath(id)) ?? [];
    expect(cells(s.first)[3]).toContain("Alpha is so <b>");
    expect(page.$("main b")).toBeNull();
    // The Result column holds 1 marker: the outcome of a done request, else its status.
    expect(cells(s.update)[2]).toBe("accepted");
    expect(cells(s.update)[4]).toContain("4 s");
    expect(cells(s.failed)[2]).toBe("failing");
    expect(cells(s.queued)[2]).toBe("queued");
    expect(cells(s.rejected)[2]).toContain("rejected");
    expect(cells(s.rejected)[2]).toContain("unsupported");
    expect(cells(s.repair)[1]).toBe("lookup repair");
    expect(cells(s.update)[1]).toBe("submission");
  });

  it("shows the facts each request wrote as header links with the kind of write", async () => {
    const s = await seed();
    const page = await open();
    for (const [id, kind] of [
      [s.first, "new"],
      [s.update, "changed"],
    ] as const) {
      const cell = page.rowOf(reqPath(id))?.[3] ?? "";
      expect(cell).toContain("Alpha");
      expect(cell).toContain(kind);
    }
    expect(page.hrefs("Alpha")).toEqual(Array(2).fill(`/console/w/alpha/facts/${s.factId}`));
  });

  it("lists the newest request first and marks the sort in the headers", async () => {
    const s = await seed();
    const page = await open();
    expect(listed(page)).toEqual([s.repair, s.queued, s.failed, s.rejected, s.update, s.first]);
    expect(page.header("Received")?.sort).toBe("descending");
    expect(page.header("Duration")?.sort).toBe("none");
    expect(queryOf(page.header("Duration")?.href ?? "").get("sort")).toBe("duration");
    const byDuration = await open("sort=duration&status=done");
    expect(byDuration.header("Duration")?.sort).toBe("descending");
    expect(Object.fromEntries(queryOf(byDuration.header("Received")?.href ?? ""))).toEqual({
      sort: "received",
      status: "done",
    });
  });

  it("filters by status and shows the segmented control with the current value", async () => {
    const s = await seed();
    const failed = await open("status=failed");
    expect(listed(failed)).toEqual([s.failed]);
    expect(
      failed
        .within("main")
        ?.current()
        .map((v) => v.text),
    ).toEqual(["failed"]);
    expect(queryOf(failed.href("failed") ?? "").get("status")).toBe("failed");
    expect(failed.href("All")).toBe("?");
    expect(failed.field("status")?.value).toBe("failed");
    const all = await open();
    expect(
      all
        .within("main")
        ?.current()
        .map((v) => v.text),
    ).toEqual(["All"]);
    expect(all.field("status")).toBeUndefined();
  });

  it("applies the filters of the query and shows each as a removable chip", async () => {
    const s = await seed();
    const page = await open("q=alpha&outcome=accepted");
    expect(listed(page)).toContain(s.update);
    expect(listed(page)).not.toContain(s.rejected);
    expect(Object.fromEntries(queryOf(page.href("Outcome: accepted ×") ?? ""))).toEqual({ q: "alpha" });
    expect(Object.fromEntries(queryOf(page.href("Text: alpha ×") ?? ""))).toEqual({ outcome: "accepted" });
    expect(page.selected("outcome")).toEqual(["accepted"]);
    expect(page.field("q")?.value).toBe("alpha");
    // The text filter is a box with a placeholder and no label.
    expect(page.placeholder("q")).toBe("Filter by text");
    expect(page.labelOf("q")).toBe("");
    const since = await open(`since=${T0 + 4 * DAY}`);
    expect(listed(since)).toContain(s.queued);
    expect(listed(since)).not.toContain(s.first);
    // The chip and the date field show the day, never the unix milliseconds.
    const sinceDay = new Date(T0 + 4 * DAY).toISOString().slice(0, 10);
    expect(since.link(`Since: ${sinceDay} ×`)).toBeDefined();
    expect(since.field("since")).toMatchObject({ type: "date", value: sinceDay });
    const repairs = await open("kind=lookupRepair");
    expect(listed(repairs)).toEqual([s.repair]);
    expect(repairs.link("Kind: lookup repair ×")).toBeDefined();
    expect(repairs.selected("kind")).toEqual(["lookup repair"]);
    expect(repairs.options("kind").map((o) => o.label)).toEqual([
      "any",
      "submission",
      "lookup repair",
      "operator edit",
      "cleanup",
    ]);
    expect(repairs.options("kind")[2]?.value).toBe(RequestKind.LookupRepair);
    expect(repairs.options("rejectReason").map((o) => o.label)).toEqual([
      "any",
      "unsupported",
      "contradicted",
      "compound",
    ]);
  });

  it("keeps the less used filters behind More filters and none applied shows no chip", async () => {
    await seed();
    const page = await open();
    const more = page.fold("More filters");
    expect(more?.fieldNames()).toEqual(expect.arrayContaining(["kind", "rejectReason", "fact", "since"]));
    expect(page.links().filter((l) => l.text.endsWith("×"))).toEqual([]);
  });

  it("shows no table when the filters match none", async () => {
    await seed();
    const page = await open("q=nothing-like-this");
    expect(page.tables()).toEqual([]);
    expect(listed(page)).toEqual([]);
  });

  it("pages with a next link that keeps the filters", async () => {
    const s = await seed();
    const page = await open("limit=2&sort=received");
    expect(listed(page)).toEqual([s.repair, s.queued]);
    const next = queryOf(page.href("Next page") ?? "");
    expect(next.get("limit")).toBe("2");
    expect(next.get("sort")).toBe("received");
    expect(next.get("cursor")).toBeTruthy();
    expect((await open()).link("Next page")).toBeUndefined();
  });

  it("refreshes in place while the status filter follows the queue", async () => {
    await seed();
    const refresh = async (query: string): Promise<boolean> =>
      (await open(query)).$("main")?.hasAttribute("data-refresh") ?? false;
    expect(await refresh("status=queued")).toBe(true);
    expect(await refresh("status=running")).toBe(true);
    expect(await refresh("status=done")).toBe(false);
    expect(await refresh("")).toBe(false);
  });

  it("rejects a bad query and an unknown wiki", async () => {
    await expect(requestsPage(w.ctx({}, "status=lost"))).rejects.toBeInstanceOf(ZodError);
    await expect(requestsPage(w.ctx({}, "since=yesterday"))).rejects.toBeInstanceOf(ZodError);
    await expect(requestsPage(w.ctx({ w: "nope" }))).rejects.toBeInstanceOf(ConsoleError);
  });
});

describe("followsQueue", () => {
  it("is true for queued and running only", () => {
    expect(followsQueue(RequestStatus.Queued)).toBe(true);
    expect(followsQueue(RequestStatus.Running)).toBe(true);
    expect(followsQueue(RequestStatus.Done)).toBe(false);
    expect(followsQueue(RequestStatus.Failed)).toBe(false);
  });
});
