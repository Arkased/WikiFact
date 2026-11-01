// technical/console.md, "Search": the search page, the spot-check. The consumer search of technical/lookup.md, "search" by default, the agent search with
// history of technical/updates.md, "Store API reads for the update agent" with `history=1`, and a random sample
// with `sample=1`. The results show the content. The page waits for the embedder and checks the 512-token cap as a
// `search` tool call does, and records nothing (requirements/console.md, "Reads not counted").
import { z } from "zod";
import { ConsoleErrorKind, ConsoleSection, MarkerClass, SearchHitKind } from "../../domain/enums.js";
import { EMBED_WINDOW, countTokens } from "../../embed/index.js";
import {
  getFact,
  sampleFacts,
  search,
  type AgentSearchResult,
  type FactVersion,
  type SearchResult,
  type Store,
} from "../../store/index.js";
import { ConsoleError } from "../errors.js";
import { html, layout, sectionLabel, type SafeHtml } from "../html.js";
import type { PageContext } from "../page.js";
import {
  checkboxField,
  empty,
  factLink,
  flag,
  marker,
  parseQuery,
  results,
  withWiki,
  type ResultItem,
} from "./parts/index.js";

/** The facts the random sample shows (technical/console.md, "Search"). */
export const SAMPLE_SIZE = 10;

const searchQuery = z.object({
  q: z.string().optional(),
  sample: flag,
  history: flag,
});

type SearchQuery = z.infer<typeof searchQuery>;

/** What the results of a page need: the store, the wiki name, the clock and the relevance floor of the wiki. */
interface SearchContext {
  store: Store;
  wiki: string;
  now: number;
  /** The relevance floor, as a cosine distance. */
  floor: number;
}

/** What a search shows: the results. */
interface Hits {
  items: ResultItem[];
}

/** The version a hit names and the fact as it stands now. */
interface FactRead {
  current: FactVersion;
  matched: FactVersion;
}

// Every version of the fact, so that a history hit shows the version that matched, not the current one.
function readVersions(store: Store, id: string, seq: number | undefined, now: number): FactRead | null {
  const fact = getFact(store, id, { now, agent: true });
  const [current] = fact?.factVersions ?? [];
  if (fact === null || current === undefined) return null;
  const matched = seq === undefined ? current : (fact.factVersions.find((v) => v.seq === seq) ?? current);
  return { current, matched };
}

function versionMarkers(read: FactRead | null): SafeHtml | null {
  if (read === null) return null;
  return html`${read.current.isDeleted ? marker("deleted", MarkerClass.Bad) : null}
  ${read.matched.seq === read.current.seq ? null : marker("old version", MarkerClass.Derived, `seq ${read.matched.seq}`)}`;
}

/** What a fact result shows besides the read: the id, the header and the hit's confidence. */
interface FactHit {
  id: string;
  header: string;
  confidence: number;
  /** The seq of the matched version, with history. */
  seq?: number;
}

function factItem(cx: SearchContext, hit: FactHit): ResultItem {
  const read = readVersions(cx.store, hit.id, hit.seq, cx.now);
  const markers = versionMarkers(read);
  return {
    title: factLink(cx.wiki, hit.id, hit.header),
    content: read?.matched.content ?? "",
    confidence: hit.confidence,
    ...(markers === null ? {} : { markers }),
  };
}

function consumerHits(cx: SearchContext, found: SearchResult[]): Hits {
  return { items: found.flatMap((h) => (h.kind === SearchHitKind.Fact ? [factItem(cx, h)] : [])) };
}

function agentHits(cx: SearchContext, found: AgentSearchResult[]): Hits {
  const items: ResultItem[] = [];
  for (const h of found) {
    if (h.kind === SearchHitKind.Fact) items.push(factItem(cx, { ...h, id: h.factId }));
  }
  return { items };
}

async function checkLength(query: string): Promise<void> {
  const tokens = await countTokens(query);
  if (tokens > EMBED_WINDOW) {
    throw new ConsoleError(
      ConsoleErrorKind.BadQuery,
      `the query is ${tokens} tokens; the limit is ${EMBED_WINDOW} tokens (the input window of the embedding model)`,
    );
  }
}

function searchForm(q: SearchQuery): SafeHtml {
  return html`<form method="get" data-auto>
    <div class="search-row">
      <input
        class="search"
        type="search"
        name="q"
        data-search
        value="${q.q ?? ""}"
        placeholder="Search as an agent would: a phrase or a claim"
      />
      <button type="submit" class="primary">Search</button>
    </div>
    <div class="search-options">
      <a href="?sample=1">Random sample</a>
      ${checkboxField("history", "Include old and deleted versions", q.history)}
    </div>
  </form>`;
}

const CONSUMER_NOTE = "Live facts only.";
const AGENT_NOTE = "All versions, deleted facts too.";
const RECORDS_NOTE = "Nothing is recorded.";

function countLine(hits: Hits, history: boolean): SafeHtml {
  const note = history ? AGENT_NOTE : CONSUMER_NOTE;
  return html`<p class="count">${hits.items.length} facts. ${note} ${RECORDS_NOTE}</p>`;
}

// The list under the box.
function resultList(cx: SearchContext, hits: Hits): SafeHtml {
  const noHit = `No fact matches. The relevance floor drops a hit whose cosine distance is over ${cx.floor}.`;
  return results(hits.items, noHit);
}

// The page under the box: the sample or the search.
async function resultsBlock(cx: SearchContext, q: SearchQuery): Promise<SafeHtml> {
  if (q.q === undefined) {
    if (!q.sample) return empty(`${CONSUMER_NOTE} ${RECORDS_NOTE}`);
    const sample = sampleFacts(cx.store, SAMPLE_SIZE, cx.now);
    const items = sample.map((f): ResultItem => ({
      title: factLink(cx.wiki, f.id, f.header),
      content: f.content,
      confidence: f.confidence,
    }));
    return html`<p class="count">${sample.length} random live facts.</p>
      ${results(items, "No live fact.")}`;
  }
  await checkLength(q.q);
  const hits = q.history
    ? agentHits(cx, await search(cx.store, q.q, { now: cx.now, includeHistory: true }))
    : consumerHits(cx, await search(cx.store, q.q, { now: cx.now }));
  return html`${countLine(hits, q.history)} ${resultList(cx, hits)}`;
}

/**
 * Renders the search page at `GET /console/w/:w/search`.
 *
 * @param ctx - the deps, the wiki in `params.w`, and in the query `q`, `history` and `sample`
 * @returns the HTML document: the box with the sample link and the 2 checkboxes, then the line that says what the
 *   search is and, with `q` or `sample=1`, the results; `q` wins over `sample`
 * @throws {ConsoleError} `NotFound` for an unknown wiki; `BadQuery` for a query over 512 tokens; `ZodError` for a bad
 *   query
 * @sideEffects one read-only connection, opened and closed; reads the clock once; reads the lock file and signals its
 *   pid with 0 for the status pill; with `q` the embedder runs for the query and the page waits for the `ready` hook
 *   of the deps; records no retrieval (requirements/console.md, "Reads not counted")
 */
export async function searchPage(ctx: PageContext): Promise<string> {
  const q = parseQuery(ctx.query, searchQuery);
  return withWiki(ctx, async ({ wiki, store, now, frame }) => {
    if (q.q !== undefined) await ctx.deps.ready?.();
    const cx: SearchContext = { store, wiki: wiki.name, now, floor: wiki.config.relevanceFloor };
    const body = await resultsBlock(cx, q);
    return layout(
      { ...frame, section: ConsoleSection.Search, title: sectionLabel(ConsoleSection.Search) },
      html`${searchForm(q)} ${body}`,
    );
  });
}
