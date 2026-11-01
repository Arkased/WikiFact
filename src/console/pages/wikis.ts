// technical/console.md, "Wikis": the first page of the console. The wikis table, the service and the archives, and the dialog that
// creates a wiki. Each wiki opens its own read-only store and closes it (technical/console.md, "Architecture"), as the MCP tools do, and reads
// its counts and its live health once. The page is about no single wiki, so it has no status pill.
import {
  ConsoleAction,
  ConsoleSection,
  DialogId,
  GridColumns,
  HealthLevel,
  Quality,
  ServeTarget,
  enumValues,
} from "../../domain/enums.js";
import {
  closeStore,
  countLiveFacts,
  countQueued,
  listChanges,
  openStoreFor,
  readWorkerStatus,
} from "../../store/index.js";
import { writesAllowed } from "../auth.js";
import type { ConsoleWiki, ServiceFacts } from "../deps.js";
import { liveHealth, workerRunning } from "../health.js";
import { act, html, layout, num, table, time, wikiPath, type SafeHtml } from "../html.js";
import type { PageContext } from "../page.js";
import { actionPath } from "../write-paths.js";
import { actionForm, inputField, selectField } from "./forms.js";
import { dialogAction, grid, key, kv, levelBadge, panel, serviceRows } from "./parts/index.js";

/** What one row of the wikis table reads from the wiki's read-only connection. */
interface WikiRow {
  liveFacts: number;
  queued: number;
  /** `workerRunning` of the health rules: the child state when there is a child, else a recent poll. */
  workerRunning: boolean;
  /** The time of the last change, in ms since the epoch; absent on a wiki without a change. */
  lastChange?: number;
  health: HealthLevel;
}

function readRow(wiki: ConsoleWiki, now: number): WikiRow {
  const store = openStoreFor(wiki.config, wiki.dbPath, { readonly: true });
  try {
    const last = listChanges(store, { limit: 1 }).items[0];
    return {
      liveFacts: countLiveFacts(store),
      queued: countQueued(store),
      workerRunning: workerRunning(wiki, readWorkerStatus(store), now),
      ...(last === undefined ? {} : { lastChange: last.created }),
      health: liveHealth(store, wiki, now).verdict,
    };
  } finally {
    closeStore(store);
  }
}

function wikisTable(wikis: ConsoleWiki[], now: number, service: ServiceFacts, canManage: boolean): SafeHtml {
  const rows = [...wikis]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((wiki) => {
      const r = readRow(wiki, now);
      return [
        key(
          html`<a href="${wikiPath(wiki.name)}">${wiki.name}</a
            ><span class="muted subject" title="${wiki.subject}">${wiki.subject}</span>`,
        ),
        html`<a href="${wikiPath(wiki.name, ConsoleSection.Health)}">${levelBadge(r.health)}</a>`,
        num(r.liveFacts),
        num(r.queued),
        r.workerRunning ? "running" : "stopped",
        r.lastChange === undefined ? html`<span class="muted">none yet</span>` : time(r.lastChange),
        html`<code>${wiki.url}</code>`,
        ...(canManage
          ? [
              act(
                actionForm({
                  action: actionPath(ConsoleAction.ArchiveWiki, { w: wiki.name }),
                  button: "Archive",
                  danger: true,
                  inline: true,
                }),
              ),
            ]
          : []),
      ];
    });
  return table(
    ["Wiki", "Health", "Live facts", "Queued", "Worker", "Last change", "MCP URL", ...(canManage ? [""] : [])],
    rows,
    { empty: "No wiki is mounted." },
  );
}

function servicePanel(service: ServiceFacts): SafeHtml {
  return panel({ title: "Service" }, kv(serviceRows(service)));
}

function archivesPanel(service: ServiceFacts, canManage: boolean): SafeHtml {
  const restore = (folder: string): SafeHtml =>
    actionForm({ action: actionPath(ConsoleAction.UnarchiveWiki, { w: folder }), button: "Restore", inline: true });
  const rows = service.archives.map((a) => [
    a.name,
    time(Date.parse(a.archivedAt)),
    ...(canManage ? [act(restore(a.folder))] : []),
  ]);
  return panel(
    { title: "Archives" },
    table(["Wiki", "Archived", ...(canManage ? [""] : [])], rows, { empty: "No archive." }),
  );
}

// The dialog that creates a wiki (technical/console.md, "Operator actions"): it needs the registry, so service mode only, and the writes of
// technical/console.md, "Authentication".
function createWiki(): { button: SafeHtml; dialog: SafeHtml } {
  const quality = selectField("quality", "Quality", [
    { value: "", label: "default" },
    ...enumValues(Quality).map((q) => ({ value: q, label: q })),
  ]);
  return dialogAction(
    { id: DialogId.CreateWiki, label: "Create wiki", action: actionPath(ConsoleAction.CreateWiki), submit: "Create" },
    html`${inputField("name", "Name", undefined)} ${inputField("subject", "Subject", undefined)} ${quality}`,
  );
}

/**
 * Renders the wikis page at `GET /console/`.
 *
 * @param ctx - the deps; the page takes no path parameter and no query
 * @returns the HTML document: the wikis table, the service and archives panels and, when the console may manage
 *   wikis, the "Create a wiki" button in the page header and its dialog
 * @sideEffects opens and closes a read-only store per wiki; reads the clock once; reads the `.archive/` folder
 *   through the deps; reads the lock file and the error logs of each wiki for the health badge; reads the service's
 *   errors log
 */
export function wikisPage(ctx: PageContext): string {
  const wikis = ctx.deps.listWikis();
  const service = ctx.deps.service();
  const now = Date.now();
  // The wiki management needs the registry (`--db` has none) and the writes of technical/console.md, "Authentication".
  const canManage = writesAllowed(service) && service.target === ServeTarget.Wikis;
  const create = canManage ? createWiki() : null;
  return layout(
    {
      title: "Wikis",
      wikis: wikis.map((w) => w.name),
      version: service.version,
      ...(create === null ? {} : { controls: create.button }),
    },
    html`${wikisTable(wikis, now, service, canManage)}
    ${grid(GridColumns.Two, [servicePanel(service), archivesPanel(service, canManage)])} ${create?.dialog ?? null}`,
  );
}
