// technical/console.md, "Operator actions": the operator actions. The 2 "Run now" routes of Jobs (the cleanup and the reindex), and create,
// archive and restore a wiki. Each is a write route (`write.ts`) with a preview first.
import { z } from "zod";
import { ConsoleAction, ConsoleErrorKind, ConsoleSection, OperatorEditKind, Quality } from "../domain/enums.js";
import {
  clearQueuePause,
  countQueuedSubmissions,
  enqueueOperatorEdit,
  readQueuePause,
  setQueuePause,
  writeBatchNow,
} from "../store/index.js";
import { ConsoleError } from "./errors.js";
import { CONSOLE_PREFIX, html, wikiPath } from "./html.js";
import { noteSchema } from "./pages/forms.js";
import { JOBS_ANCHOR } from "./pages/jobs.js";
import { objectPath } from "./pages/parts/index.js";
import { defineWrite, needWiki, refusing, withWriteStore, type WriteRoute } from "./write.js";

const noFields = z.object({});

const noteOnly = z.object({ note: noteSchema });

// An empty `quality` is the form's "default": the key stays out of `wikifact.json`.
const createFields = z.object({
  name: z.string().trim().min(1, "a name is required"),
  subject: z.string().trim().min(1, "a subject is required"),
  quality: z.preprocess((v) => (v === "" ? undefined : v), z.enum(Quality).optional()),
});

function requestPath(wiki: string, id: string): string {
  return objectPath(wiki, ConsoleSection.Requests, id);
}

function jobsPath(wiki: string): string {
  return `${wikiPath(wiki, ConsoleSection.Health)}#${JOBS_ANCHOR}`;
}

// "Run now" of the cleanup row (technical/console.md, "Jobs"): the document `{ edit: "cleanup", note }` runs the duplicate-fact check now.
const cleanupRoute = defineWrite({
  action: ConsoleAction.RunCleanup,
  title: "Run the cleanup",
  button: "Queue",
  schema: noteOnly,
  describe: (ctx, f) => {
    needWiki(ctx);
    return html`<p>
        Queue an operator edit: a run of the cleanup. The worker merges duplicate facts in queue order, also when the
        interval of the check has not passed.
      </p>
      <p>Note: ${f.note}</p>`;
  },
  run: (ctx, f) => {
    const wiki = needWiki(ctx);
    const id = withWriteStore(wiki, (store) =>
      enqueueOperatorEdit(store, { edit: OperatorEditKind.Cleanup, note: f.note }),
    );
    return { location: requestPath(wiki.name, id), id };
  },
  back: (ctx) => jobsPath(ctx.params.w ?? ""),
});

// "Run now" of the reindex row (technical/console.md, "Jobs").
const reindexRoute = defineWrite({
  action: ConsoleAction.Reindex,
  title: "Rebuild the search index",
  button: "Queue",
  schema: noteOnly,
  describe: (ctx, f) => {
    needWiki(ctx);
    return html`<p>
        Queue an operator edit: a rebuild of the search index. The worker rebuilds every index table in queue order,
        after the request it runs now.
      </p>
      <p>Note: ${f.note}</p>`;
  },
  run: (ctx, f) => {
    const wiki = needWiki(ctx);
    const id = withWriteStore(wiki, (store) =>
      enqueueOperatorEdit(store, { edit: OperatorEditKind.Reindex, note: f.note }),
    );
    return { location: requestPath(wiki.name, id), id };
  },
  back: (ctx) => jobsPath(ctx.params.w ?? ""),
});

const createWikiRoute = defineWrite({
  action: ConsoleAction.CreateWiki,
  title: "Create a wiki",
  button: "Create",
  schema: createFields,
  describe: (_ctx, f) =>
    html`<p>
      Create the wiki <code>${f.name}</code> with the subject "${f.subject}" and the quality ${f.quality ?? "default"}.
    </p>`,
  run: async (ctx, f) => {
    const created = await refusing(() => ctx.deps.writes.addWiki(f.name, f.subject, f.quality));
    return { location: CONSOLE_PREFIX, wiki: created.name };
  },
  back: () => CONSOLE_PREFIX,
});

const archiveRoute = defineWrite({
  action: ConsoleAction.ArchiveWiki,
  title: "Archive a wiki",
  button: "Archive",
  schema: noFields,
  describe: (ctx) => {
    const wiki = needWiki(ctx);
    return html`<p>
      Archive ${wiki.name}: its worker stops, and its folder moves to <code>.archive/</code>. A wiki with no fact (live
      or deleted) and 0 queued requests is removed instead. The MCP URL ${wiki.url} stops answering.
    </p>`;
  },
  run: async (ctx) => {
    const wiki = needWiki(ctx);
    await refusing(() => ctx.deps.writes.archiveWiki(wiki.name));
    return { location: CONSOLE_PREFIX };
  },
  back: (ctx) => wikiPath(ctx.params.w ?? "", ConsoleSection.Settings),
});

const unarchiveRoute = defineWrite({
  action: ConsoleAction.UnarchiveWiki,
  title: "Restore an archived wiki",
  button: "Restore",
  schema: noFields,
  describe: (ctx) => {
    const name = ctx.params.w ?? "";
    if (!ctx.deps.service().archives.some((a) => a.folder === name || a.name === name)) {
      throw new ConsoleError(ConsoleErrorKind.NotFound, `no archive named "${name}"`);
    }
    return html`<p>Move the archive <code>${name}</code> back to a wiki folder and mount it.</p>`;
  },
  run: async (ctx) => {
    const restored = await refusing(() => ctx.deps.writes.unarchiveWiki(ctx.params.w ?? ""));
    return { location: CONSOLE_PREFIX, wiki: restored.name };
  },
  back: () => CONSOLE_PREFIX,
});

function healthPath(wiki: string): string {
  return wikiPath(wiki, ConsoleSection.Health);
}

// A direct write of the `queue_pause` key (technical/console.md, "Operator actions"; design/console.md, "The pause of the queue"). A pause of a
// paused queue and a resume of a running one are refused with a 409.
function refuseUnless(paused: boolean, wanted: boolean): void {
  if (paused === wanted) return;
  throw new ConsoleError(ConsoleErrorKind.Refused, wanted ? "the queue is not paused" : "the queue is already paused");
}

const pauseRoute = defineWrite({
  action: ConsoleAction.PauseQueue,
  title: "Pause the queue",
  button: "Pause the queue",
  schema: noteOnly,
  describe: (ctx, f) => {
    const wiki = needWiki(ctx);
    refuseUnless(
      withWriteStore(wiki, (store) => readQueuePause(store) !== undefined),
      false,
    );
    return html`<p>
        Pause the queue: the worker finishes the request it runs, then starts no request, no cleanup and no job until
        the queue is resumed. The pause stays after a restart. A change request is still accepted and waits.
      </p>
      <p>Note: ${f.note}</p>`;
  },
  run: (ctx, f) => {
    const wiki = needWiki(ctx);
    withWriteStore(wiki, (store) => {
      refuseUnless(readQueuePause(store) !== undefined, false);
      setQueuePause(store, f.note, Date.now());
    });
    return { location: healthPath(wiki.name) };
  },
  back: (ctx) => healthPath(ctx.params.w ?? ""),
});

const resumeRoute = defineWrite({
  action: ConsoleAction.ResumeQueue,
  title: "Resume the queue",
  button: "Resume the queue",
  schema: noFields,
  describe: (ctx) => {
    const wiki = needWiki(ctx);
    refuseUnless(
      withWriteStore(wiki, (store) => readQueuePause(store) !== undefined),
      true,
    );
    return html`<p>Resume the queue: the worker takes the next request at its next poll.</p>`;
  },
  run: (ctx) => {
    const wiki = needWiki(ctx);
    withWriteStore(wiki, (store) => {
      refuseUnless(readQueuePause(store) !== undefined, true);
      clearQueuePause(store);
    });
    return { location: healthPath(wiki.name) };
  },
  back: (ctx) => healthPath(ctx.params.w ?? ""),
});

// A direct write of the `batch_now` key (technical/console.md, "Service health", "Run a batch now"): the worker starts a batch with the
// queued submissions at its next poll. The button is disabled with no queued submission, so a POST with none is refused with a 409.
function refuseWithoutSubmission(queued: number): void {
  if (queued > 0) return;
  throw new ConsoleError(ConsoleErrorKind.Refused, "no submission is queued");
}

const batchRoute = defineWrite({
  action: ConsoleAction.RunBatch,
  title: "Run a batch now",
  button: "Run a batch now",
  schema: noFields,
  describe: (ctx) => {
    const wiki = needWiki(ctx);
    refuseWithoutSubmission(withWriteStore(wiki, countQueuedSubmissions));
    return html`<p>Run a batch now: the worker starts a batch with the queued submissions at its next poll.</p>`;
  },
  run: (ctx) => {
    const wiki = needWiki(ctx);
    withWriteStore(wiki, (store) => {
      refuseWithoutSubmission(countQueuedSubmissions(store));
      writeBatchNow(store, Date.now());
    });
    return { location: healthPath(wiki.name) };
  },
  back: (ctx) => healthPath(ctx.params.w ?? ""),
});

/** The write routes of technical/console.md, "Operator actions". */
export const ACTION_ROUTES: WriteRoute[] = [
  cleanupRoute,
  reindexRoute,
  createWikiRoute,
  archiveRoute,
  unarchiveRoute,
  pauseRoute,
  resumeRoute,
  batchRoute,
];
