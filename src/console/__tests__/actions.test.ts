import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConsoleAction, LogEvent, Mode, OperatorEditKind, RequestKind, RequestStatus } from "../../domain/enums.js";
import type { LogLine } from "../../log/index.js";
import { getRequest, MAX_NOTE_LENGTH, readQueuePause, setQueuePause } from "../../store/index.js";
import { matchWriteRoute } from "../post.js";
import { fakeWrites, linesOf, post, serveConsole, type FakeWrites, type RunningConsole } from "./helpers/serve.js";
import { parse } from "./helpers/dom.js";
import { openTmpWiki, type TmpWiki } from "./helpers/tmp-wiki.js";

let wiki: TmpWiki;
let server: RunningConsole;
let fake: FakeWrites;
let lines: LogLine[];

beforeEach(async () => {
  fake = fakeWrites();
  lines = [];
  wiki = openTmpWiki("alpha", { writes: fake.writes, log: (l) => lines.push(l) });
  server = await serveConsole(wiki.deps);
});
afterEach(async () => {
  await server.close();
  wiki.close();
});

const requestCount = (): number =>
  (wiki.store.db.prepare("SELECT COUNT(*) AS n FROM change_requests").get() as { n: number }).n;

// The 2 "Run now" routes of Jobs: they differ in the document they queue and nothing else.
const RUN_NOW = [
  {
    name: "the cleanup",
    path: "/console/w/alpha/jobs/cleanup",
    edit: OperatorEditKind.Cleanup,
    action: ConsoleAction.RunCleanup,
  },
  {
    name: "the reindex",
    path: "/console/w/alpha/jobs/reindex",
    edit: OperatorEditKind.Reindex,
    action: ConsoleAction.Reindex,
  },
];

describe.each(RUN_NOW)("Run now of $name", ({ path, edit, action }) => {
  it("previews, then queues an operatorEdit request with the note and redirects to its page", async () => {
    const preview = await post(server.base, path, { confirm: "0", note: "after the model fix" });
    expect(preview.status).toBe(200);
    const page = parse(await preview.text());
    expect(page.text).toContain("after the model fix");
    // The preview comes back to the section Jobs of the Operation page when the operator cancels.
    expect(page.href("Cancel")).toBe("/console/w/alpha/health#jobs");
    expect(requestCount()).toBe(0);

    const done = await post(server.base, path, { confirm: "1", note: "after the model fix" });
    expect(done.status).toBe(303);
    const id = done.headers.get("location")?.split("/").pop() ?? "";
    expect(done.headers.get("location")).toBe(`/console/w/alpha/requests/${id}`);
    const row = getRequest(wiki.store, id);
    expect(row).toMatchObject({ kind: RequestKind.OperatorEdit, status: RequestStatus.Queued });
    expect(row?.operatorEdit).toEqual({ edit, note: "after the model fix" });
    expect(linesOf(lines, LogEvent.ConsoleAction)).toEqual([expect.objectContaining({ action, wiki: "alpha", id })]);
  });

  it("is a 400 without a note or with one over the cap", async () => {
    expect((await post(server.base, path, { confirm: "1" })).status).toBe(400);
    expect((await post(server.base, path, { confirm: "1", note: "  " })).status).toBe(400);
    expect((await post(server.base, path, { confirm: "1", note: "x".repeat(MAX_NOTE_LENGTH + 1) })).status).toBe(400);
    expect(requestCount()).toBe(0);
  });

  it("is a 403 from another origin, and in a mode that does not write, and writes nothing", async () => {
    const send = (base: string, headers: Record<string, string>): Promise<Response> =>
      fetch(`${base}${path}`, {
        method: "POST",
        redirect: "manual",
        headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
        body: new URLSearchParams({ confirm: "1", note: "n" }).toString(),
      });
    expect((await send(server.base, { Origin: "http://evil.example" })).status).toBe(403);
    const deployed = openTmpWiki("alpha", { mode: Mode.Deployed });
    const other = await serveConsole(deployed.deps);
    try {
      expect((await send(other.base, {})).status).toBe(403);
    } finally {
      await other.close();
      deployed.close();
    }
    expect(requestCount()).toBe(0);
    expect(linesOf(lines, LogEvent.ConsoleAction)).toHaveLength(0);
  });

  it("is a 404 on an unknown wiki", async () => {
    const unknown = path.replace("/w/alpha/", "/w/nope/");
    expect((await post(server.base, unknown, { confirm: "1", note: "n" })).status).toBe(404);
  });
});

describe("pause and resume of the queue", () => {
  const PAUSE = "/console/w/alpha/health/pause";
  const RESUME = "/console/w/alpha/health/resume";

  it("previews the pause, writes nothing, then writes the key and redirects to Service health", async () => {
    const preview = await post(server.base, PAUSE, { confirm: "0", note: "before the eval" });
    expect(preview.status).toBe(200);
    const page = parse(await preview.text());
    expect(page.text).toContain("before the eval");
    expect(page.href("Cancel")).toBe("/console/w/alpha/health");
    expect(readQueuePause(wiki.store)).toBeUndefined();

    const done = await post(server.base, PAUSE, { confirm: "1", note: "before the eval" });
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe("/console/w/alpha/health");
    expect(readQueuePause(wiki.store)).toMatchObject({ note: "before the eval" });
    // The pause is not a queued request.
    expect(requestCount()).toBe(0);
    expect(linesOf(lines, LogEvent.ConsoleAction)).toEqual([
      expect.objectContaining({ action: ConsoleAction.PauseQueue, wiki: "alpha" }),
    ]);
  });

  it("is a 400 without a note or with one over the cap, and a 409 on a queue that is paused", async () => {
    expect((await post(server.base, PAUSE, { confirm: "1" })).status).toBe(400);
    expect((await post(server.base, PAUSE, { confirm: "1", note: "x".repeat(MAX_NOTE_LENGTH + 1) })).status).toBe(400);
    expect(readQueuePause(wiki.store)).toBeUndefined();
    setQueuePause(wiki.store, "first", 1);
    expect((await post(server.base, PAUSE, { confirm: "0", note: "second" })).status).toBe(409);
    expect((await post(server.base, PAUSE, { confirm: "1", note: "second" })).status).toBe(409);
    expect(readQueuePause(wiki.store)).toMatchObject({ note: "first" });
  });

  it("resumes a paused queue, and refuses a resume of a running one with a 409", async () => {
    const refused = await post(server.base, RESUME, { confirm: "1" });
    expect(refused.status).toBe(409);
    setQueuePause(wiki.store, "first", 1);
    expect((await post(server.base, RESUME, { confirm: "0" })).status).toBe(200);
    expect(readQueuePause(wiki.store)).toBeDefined();
    const done = await post(server.base, RESUME, { confirm: "1" });
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe("/console/w/alpha/health");
    expect(readQueuePause(wiki.store)).toBeUndefined();
    expect(linesOf(lines, LogEvent.ConsoleAction)).toEqual([
      expect.objectContaining({ action: ConsoleAction.ResumeQueue, wiki: "alpha" }),
    ]);
  });

  it("is a 403 where the console does not write, and a 404 on an unknown wiki", async () => {
    const deployed = openTmpWiki("alpha", { mode: Mode.Deployed });
    const other = await serveConsole(deployed.deps);
    try {
      expect((await post(other.base, PAUSE, { confirm: "1", note: "n" })).status).toBe(403);
      expect(readQueuePause(deployed.store)).toBeUndefined();
    } finally {
      await other.close();
      deployed.close();
    }
    expect((await post(server.base, PAUSE.replace("alpha", "nope"), { confirm: "1", note: "n" })).status).toBe(404);
  });
});

describe("the routes of the removed actions", () => {
  it("are not write routes, so a POST there writes nothing, as on any unknown path", async () => {
    const gone = [
      "/console/w/alpha/requests/x/requeue",
      "/console/w/alpha/worker/restart",
      "/console/w/alpha/index/reindex",
      "/console/w/alpha/facts/x/correct",
      "/console/w/alpha/facts/x/delete",
      "/console/w/alpha/facts/add",
    ];
    for (const path of gone) {
      expect(matchWriteRoute(path), path).toBeUndefined();
      expect((await post(server.base, path, { confirm: "1", note: "n" })).status, path).toBe(405);
    }
    expect(requestCount()).toBe(0);
  });
});

describe("create, archive and restore a wiki", () => {
  it("creates a wiki through the registry and redirects to the wikis page", async () => {
    const fields = { name: "beta", subject: "Beta things.", quality: "budget" };
    const preview = await post(server.base, "/console/wikis", { ...fields, confirm: "0" });
    expect(preview.status).toBe(200);
    const page = parse(await preview.text());
    expect(page.text).toContain("Beta things.");
    // A write with no wiki has no status pill.
    expect(page.links().filter((l) => l.href.endsWith("/health"))).toEqual([]);
    expect(page.href("Cancel")).toBe("/console/");
    expect(fake.calls).toEqual([]);
    const done = await post(server.base, "/console/wikis", { ...fields, confirm: "1" });
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe("/console/");
    expect(fake.calls).toEqual(['addWiki ["beta","Beta things.","budget"]']);
    expect(linesOf(lines, LogEvent.ConsoleAction)).toEqual([
      expect.objectContaining({ action: ConsoleAction.CreateWiki, wiki: "beta" }),
    ]);
  });

  it("takes an empty quality as the default", async () => {
    await post(server.base, "/console/wikis", { name: "beta", subject: "S", quality: "", confirm: "1" });
    expect(fake.calls).toEqual(['addWiki ["beta","S",null]']);
  });

  it("is a 400 for a bad quality or a missing name, and a 409 for a registry refusal", async () => {
    expect((await post(server.base, "/console/wikis", { name: "b", subject: "S", quality: "gold" })).status).toBe(400);
    expect((await post(server.base, "/console/wikis", { subject: "S" })).status).toBe(400);
    fake.refuse = 'a wiki named "beta" exists';
    const res = await post(server.base, "/console/wikis", { name: "beta", subject: "S", confirm: "1" });
    expect(res.status).toBe(409);
    expect(parse(await res.text()).text).toContain("exists");
  });

  it("archives a wiki and redirects to the wikis page", async () => {
    expect((await post(server.base, "/console/w/alpha/archive", { confirm: "0" })).status).toBe(200);
    const done = await post(server.base, "/console/w/alpha/archive", { confirm: "1" });
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe("/console/");
    expect(fake.calls).toEqual(['archiveWiki ["alpha"]']);
    expect((await post(server.base, "/console/w/nope/archive", { confirm: "1" })).status).toBe(404);
  });

  it("restores an archive that the service lists, and 404s on one it does not", async () => {
    const service = wiki.deps.service();
    wiki.deps.service = () => ({
      ...service,
      archives: [{ name: "old", folder: "old-20260101", archivedAt: "2026-01-01T00:00:00.000Z" }],
    });
    expect((await post(server.base, "/console/w/old-20260101/unarchive", { confirm: "0" })).status).toBe(200);
    const done = await post(server.base, "/console/w/old-20260101/unarchive", { confirm: "1" });
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe("/console/");
    expect(fake.calls).toEqual(['unarchiveWiki ["old-20260101"]']);
    expect(linesOf(lines, LogEvent.ConsoleAction)).toEqual([
      expect.objectContaining({ action: ConsoleAction.UnarchiveWiki, wiki: "restored" }),
    ]);
    expect((await post(server.base, "/console/w/ghost/unarchive", { confirm: "0" })).status).toBe(404);
  });
});
