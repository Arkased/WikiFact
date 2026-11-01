// technical/console.md, "Service health", the button "Run a batch now" and the route that writes the key `batch_now`.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConsoleAction, LogEvent, Mode } from "../../domain/enums.js";
import type { LogLine } from "../../log/index.js";
import { enqueueRequest, readBatchNow } from "../../store/index.js";
import { T0 } from "../../../__tests__/helpers/store.js";
import { healthPage } from "../pages/health.js";
import { parse, type Page } from "./helpers/dom.js";
import { linesOf, post, serveConsole, type RunningConsole } from "./helpers/serve.js";
import { openTmpWiki, type TmpWiki } from "./helpers/tmp-wiki.js";

const HOUR_MS = 3_600_000;
const NOW = Math.floor(T0 / HOUR_MS) * HOUR_MS + HOUR_MS / 2;
const BATCH = "/console/w/alpha/health/batch";
const BUTTON = "Run a batch now";

let w: TmpWiki;
let lines: LogLine[];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  lines = [];
  w = openTmpWiki("alpha", { log: (l) => lines.push(l) });
});
afterEach(() => {
  w.close();
  vi.useRealTimers();
});

async function open(wiki: TmpWiki = w): Promise<Page> {
  return parse(await healthPage(wiki.ctx()));
}

const queueSubmission = (wiki: TmpWiki = w): string =>
  enqueueRequest(wiki.store, { change: "Creepers explode", justification: "I saw it." }, NOW);

const batchButton = (page: Page): Element | undefined =>
  page.$$("button").find((b) => (b.textContent ?? "").trim() === BUTTON);

describe("the button Run a batch now", () => {
  it("is disabled with no queued submission", async () => {
    const page = await open();
    expect(page.buttons()).toContain(BUTTON);
    expect(batchButton(page)?.hasAttribute("disabled")).toBe(true);
    expect(page.formTo(BATCH)?.fields.find((f) => f.name === "confirm")?.value).toBe("1");
  });

  it("is enabled with a queued submission", async () => {
    queueSubmission();
    expect(batchButton(await open())?.hasAttribute("disabled")).toBe(false);
  });

  it("is not on the page where the console does not write", async () => {
    const remote = openTmpWiki("alpha", { mode: Mode.Deployed });
    try {
      queueSubmission(remote);
      const page = await open(remote);
      expect(page.buttons()).not.toContain(BUTTON);
      expect(page.formTo(BATCH)).toBeUndefined();
    } finally {
      remote.close();
    }
  });

  it("leaves no stat Mode and no dialog to set it", async () => {
    const page = await open();
    expect(page.section("Queue worker, now")?.stats().Mode).toBeUndefined();
    expect(page.headings("h2")).not.toContain("Set the mode");
  });
});

describe("POST run a batch now", () => {
  let server: RunningConsole;
  beforeEach(async () => {
    server = await serveConsole(w.deps);
  });
  afterEach(async () => {
    await server.close();
  });

  it("writes the key batch_now, redirects to the page and logs the action", async () => {
    queueSubmission();
    const res = await post(server.base, BATCH, { confirm: "1" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/console/w/alpha/health");
    expect(readBatchNow(w.store)).toEqual({ at: NOW });
    expect(linesOf(lines, LogEvent.ConsoleAction)).toContainEqual(
      expect.objectContaining({ action: ConsoleAction.RunBatch, wiki: "alpha" }),
    );
  });

  it("is a 409 with no queued submission and writes nothing", async () => {
    expect((await post(server.base, BATCH, { confirm: "1" })).status).toBe(409);
    expect(readBatchNow(w.store)).toBeUndefined();
  });

  it("is a 404 for an unknown wiki", async () => {
    queueSubmission();
    expect((await post(server.base, BATCH.replace("alpha", "nope"), { confirm: "1" })).status).toBe(404);
    expect(readBatchNow(w.store)).toBeUndefined();
  });

  it("is a 403 where the console does not write", async () => {
    const remote = openTmpWiki("alpha", { mode: Mode.Deployed });
    const other = await serveConsole(remote.deps);
    try {
      queueSubmission(remote);
      expect((await post(other.base, BATCH, { confirm: "1" })).status).toBe(403);
      expect(readBatchNow(remote.store)).toBeUndefined();
    } finally {
      await other.close();
      remote.close();
    }
  });
});
