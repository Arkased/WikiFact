// The read of one wiki through its own read-only connection (technical/console.md, "Architecture") and the status pill of its frame
// (technical/console.md, "The shell").
import { ConsoleSection, HealthLevel, HealthRow, assertNever } from "../../../domain/enums.js";
import { closeStore, openStoreFor, type Store } from "../../../store/index.js";
import type { ConsoleWiki } from "../../deps.js";
import { unknownWiki } from "../../errors.js";
import { liveHealth } from "../../health.js";
import { wikiPath, type LayoutOptions, type StatusPill } from "../../html.js";
import type { PageContext } from "../../page.js";
import { levelWord } from "./markers.js";

/**
 * What a page handler gets for one wiki: the wiki, its open read-only store, the clock, and what the frame needs
 * (the wiki list, the status pill, the service version), ready to spread into the layout options.
 */
export interface WikiRead {
  wiki: ConsoleWiki;
  store: Store;
  /** The one instant of the request, in ms since the epoch; every score on the page is from it (technical/console.md, "Non-functional rules"). */
  now: number;
  /** The names of every wiki, for the wiki switcher. */
  wikis: string[];
  /** The layout options the frame needs: `wikis`, `wiki`, `status` and `version`. */
  frame: Pick<LayoutOptions, "wikis" | "wiki" | "status" | "version">;
}

// The name of a live row in the pill text and its title.
function pillLabel(row: HealthRow): string {
  switch (row) {
    case HealthRow.Worker:
      return "worker";
    case HealthRow.FailedRequests:
      return "failed change requests";
    case HealthRow.FailedCalls:
      return "failed tool calls";
  }
  return assertNever(row);
}

/** The text of a pill whose 3 rows are all green. */
const PILL_OK = "ok";

/**
 * Builds the status pill of a wiki from the 3 live rows of the health rules (technical/console.md, "The shell"). The
 * queue is load and is not among them.
 *
 * @param store - the open store of the wiki
 * @param wiki - the wiki
 * @param now - the clock, in ms since the epoch
 * @returns the pill: the worst level; the text "ok" when the 3 rows are green, else "<level> · <row>" of the first
 *   worst row; the title with the 3 row details; the link to Service health
 * @sideEffects reads the store and the lock file, and signals the pid in it with 0 to see whether it lives
 */
export function readStatusPill(store: Store, wiki: ConsoleWiki, now: number): StatusPill {
  const live = liveHealth(store, wiki, now);
  const worst = live.rows.find((r) => r.level === live.verdict);
  const text =
    live.verdict === HealthLevel.Green || worst === undefined
      ? PILL_OK
      : `${levelWord(live.verdict)} · ${pillLabel(worst.row)}`;
  return {
    level: live.verdict,
    text,
    title: live.rows.map((r) => `${pillLabel(r.row)}: ${r.detail}`).join("\n"),
    href: wikiPath(wiki.name, ConsoleSection.Health),
  };
}

/** What a write validation or the export gets for one wiki: the wiki, its open read-only store and the clock. */
export interface WikiStoreRead {
  wiki: ConsoleWiki;
  store: Store;
  /** The one instant of the request, in ms since the epoch. */
  now: number;
}

/**
 * Finds the wiki of the `w` path parameter, opens its read-only store, runs `fn` and closes the store; builds no
 * status pill and no frame.
 *
 * @param ctx - the context with the deps and the path parameters
 * @param fn - reads from the store
 * @returns what `fn` returns
 * @throws {ConsoleError} `NotFound` when the wiki is unknown; whatever `fn` throws
 * @sideEffects opens and closes one read-only connection; reads the clock once
 */
export async function withWikiStore<T>(
  ctx: Pick<PageContext, "deps" | "params">,
  fn: (read: WikiStoreRead) => T | Promise<T>,
): Promise<T> {
  const name = ctx.params.w ?? "";
  const wiki = ctx.deps.getWiki(name);
  if (wiki === undefined) throw unknownWiki(name);
  const store = openStoreFor(wiki.config, wiki.dbPath, { readonly: true });
  try {
    return await fn({ wiki, store, now: Date.now() });
  } finally {
    closeStore(store);
  }
}

/**
 * Finds the wiki of the `w` path parameter, opens its read-only store, reads the status pill, runs the page and
 * closes the store.
 *
 * @param ctx - the page context
 * @param page - builds the page from the read
 * @returns what `page` returns
 * @throws {ConsoleError} `NotFound` when the wiki is unknown; whatever `page` throws
 * @sideEffects opens and closes one read-only connection; reads the clock once; reads the lock file and signals its
 *   pid with 0 for the pill
 */
export async function withWiki<T>(
  ctx: Pick<PageContext, "deps" | "params">,
  page: (read: WikiRead) => T | Promise<T>,
): Promise<T> {
  const name = ctx.params.w ?? "";
  const wiki = ctx.deps.getWiki(name);
  if (wiki === undefined) throw unknownWiki(name);
  const store = openStoreFor(wiki.config, wiki.dbPath, { readonly: true });
  try {
    const now = Date.now();
    const wikis = ctx.deps.listWikis().map((w) => w.name);
    const status = readStatusPill(store, wiki, now);
    const frame = { wikis, wiki: wiki.name, status, version: ctx.deps.service().version };
    return await page({ wiki, store, now, wikis, frame });
  } finally {
    closeStore(store);
  }
}
