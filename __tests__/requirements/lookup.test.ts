// The requirement tests of docs/requirements/lookup.md: one test for each row, named by the Name cell.
import { afterEach, expect, it } from "vitest";
import { RelevanceQueryForm } from "../../eval/lib/enums.js";
import type { RelevanceCase } from "../../eval/relevance/cases.js";
import { NO_ANSWER_SHARE, judgeCase, summarize, type RelevanceCaseResult } from "../../eval/relevance/run.js";
import { SPEED_BAR_MS, speedPasses } from "../../eval/speed/report.js";
import { SearchHitKind, Span } from "../../src/domain/enums.js";
import { EMBED_WINDOW } from "../../src/embed/index.js";
import { SEARCH_TRIGGER } from "../../src/mcp/instructions.js";
import { CORRECTION_DUTY } from "../../src/mcp/server.js";
import {
  DEFAULT_WEIGHTS,
  applyChange,
  closeStore,
  confidence,
  enqueueRequest,
  getFact,
  openStore,
  readsPerSearch,
  search,
  spanBounds,
  type ChangeSet,
  type SearchResult,
  type Store,
} from "../../src/store/index.js";
import { mcpPerTest, startManagement } from "../helpers/mcp.js";
import { DAY, T0, accepted, draft, factIdOf, makeStore, write } from "../helpers/store.js";

interface SearchHit {
  kind: SearchHitKind;
  header?: string;
  ref: string;
}
interface SearchOut {
  searchId: string;
  results: SearchHit[];
}
interface FactOut {
  current: { content: string };
}

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/**
 * Opens an in-memory store that the test closes at its end.
 *
 * @returns the open store
 * @sideEffects registers a cleanup that closes the store
 */
function openMem(): Store {
  const s = makeStore();
  cleanups.push(() => closeStore(s));
  return s;
}

const mcp = mcpPerTest();

/**
 * Applies a change set through the async path, which embeds the facts, under a fresh request.
 *
 * @param s - the open store
 * @param cs - the change set
 * @param now - the clock value, in milliseconds
 * @returns the apply result
 * @sideEffects enqueues a request and writes the change
 */
const writeAsync = (s: Store, cs: ChangeSet, now: number) =>
  applyChange(s, enqueueRequest(s, { change: "c", justification: "j" }, now), cs, { now });

/**
 * Builds a fact result that carries only the header, which is all that `judgeCase` reads.
 *
 * @param header - the header of the fact
 * @returns the fake result
 * @sideEffects none
 */
const factHit = (header: string): SearchResult => ({ kind: SearchHitKind.Fact, header }) as unknown as SearchResult;

/**
 * Judges case `n` of a form when the expected fact stands at `rank` among 5 results.
 *
 * @param n - the case number
 * @param form - the form of the query
 * @param rank - the place of the expected fact, 1 is best
 * @returns the judged case
 * @sideEffects none
 */
function atRank(n: number, form: RelevanceQueryForm, rank: number): RelevanceCaseResult {
  const c: RelevanceCase = { id: `c${n}`, query: `query ${n}`, expectHeader: `want ${n}`, form, note: "n" };
  const hits = Array.from({ length: 5 }, (_, i) => factHit(i + 1 === rank ? `want ${n}` : `other ${n}-${i}`));
  return judgeCase(c, hits);
}

it("Search speed", () => {
  // The p95 passes under the bar and fails at it and above it.
  expect(speedPasses(SPEED_BAR_MS - 1)).toBe(true);
  expect(speedPasses(SPEED_BAR_MS)).toBe(false);
  expect(speedPasses(SPEED_BAR_MS + 1)).toBe(false);
});

it("Key-word search", () => {
  const terms = (ranks: number[]) => summarize(ranks.map((r, n) => atRank(n, RelevanceQueryForm.Terms, r)));
  // 9 of 10 at rank 1 and the tenth at rank 2: the pass bar holds.
  expect(terms([1, 1, 1, 1, 1, 1, 1, 1, 1, 2]).pass).toBe(true);
  // 8 of 10 at rank 1: below 90 percent.
  expect(terms([1, 1, 1, 1, 1, 1, 1, 1, 2, 3]).pass).toBe(false);
  // A correct fact outside the first 3 results fails, however many others are first.
  expect(terms([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 4]).pass).toBe(false);
});

it("Question search", () => {
  const questions = (ranks: number[]) => summarize(ranks.map((r, n) => atRank(n, RelevanceQueryForm.Question, r)));
  // Rank 1 is not required for a question: the first 3 results are enough.
  expect(questions([3, 2]).pass).toBe(true);
  expect(questions([3, 4]).pass).toBe(false);
});

it("No answer", async () => {
  const store = openMem();
  await writeAsync(store, accepted([draft()]), T0);
  expect(await search(store, "zebra stripes", { now: T0 })).toEqual([]);
  // The eval passes an empty list and the labeled close neighbors, and fails an unrelated fact.
  const none: RelevanceCase = {
    id: "n",
    query: "zebra stripes",
    expectNone: true,
    allowNear: ["Creeper damage"],
    form: RelevanceQueryForm.Terms,
    note: "n",
  };
  expect(judgeCase(none, []).pass).toBe(true);
  expect(judgeCase(none, [factHit("Creeper damage")]).pass).toBe(true);
  expect(judgeCase(none, [factHit("Creeper damage"), factHit("Billing")]).pass).toBe(false);
  expect(judgeCase({ ...none, allowNear: undefined }, [factHit("Creeper damage")]).pass).toBe(false);
  // The run passes at NO_ANSWER_SHARE of the cases and fails under it.
  const total = 10;
  const run = (okCount: number) =>
    summarize(
      Array.from({ length: total }, (_, i) =>
        judgeCase({ ...none, id: `n${i}` }, i < okCount ? [] : [factHit("Billing")]),
      ),
    );
  const atBar = Math.ceil(NO_ANSWER_SHARE * total);
  expect(run(atBar).pass).toBe(true);
  expect(run(atBar - 1).pass).toBe(false);
});

it("Facts only", async () => {
  const w = await mcp();
  await w.write(accepted([draft()]));
  const r = await w.call<{ results: SearchHit[] }>("search", { query: "creepers" });
  expect(r.structuredContent.results.length).toBeGreaterThan(0);
  for (const hit of r.structuredContent.results) expect(hit.kind).toBe(SearchHitKind.Fact);
});

it("Result cap", async () => {
  const store = openStore(":memory:", { embeddingModel: "m", searchCap: 1 });
  cleanups.push(() => closeStore(store));
  const facts = [draft(), draft({ header: "Creeper speed", content: "Creepers walk slowly." })];
  await writeAsync(store, accepted(facts), T0);
  expect((await search(store, "creeper", { now: T0 })).length).toBe(1);
});

it("Headers only", async () => {
  const w = await mcp();
  await w.write(accepted([draft()]));
  const r = await w.call<{ results: SearchHit[] }>("search", { query: "creeper damage" });
  const fact = r.structuredContent.results.find((x) => x.kind === SearchHitKind.Fact);
  expect(fact?.header).toBe("Creeper damage");
  for (const hit of r.structuredContent.results) expect(hit).not.toHaveProperty("content");
  const opened = await w.call<FactOut>("getFact", { id: factIdOf(w.store) });
  expect(opened.structuredContent.current.content).toBe("Creepers do 10 damage.");
});

it("Chosen reads count", async () => {
  const w = await mcp();
  await w.write(accepted([draft()]));
  await w.call("search", { query: "creeper damage" });
  expect(w.count("retrievals")).toBe(0);
  // A read by the worker or the console goes through the store, not through the tools.
  getFact(w.store, factIdOf(w.store));
  await w.call("getFact", { id: factIdOf(w.store) });
  expect(w.count("retrievals")).toBe(1);
});

it("Confidence", () => {
  const store = openMem();
  const f = write(store, accepted([draft()]), T0).factIds[0];
  const sum = (c: number) => -Math.log2(1 - c); // back to the weight sum, so that a half is plain
  const fresh = confidence(store, f, T0);
  const aged = confidence(store, f, T0 + DEFAULT_WEIGHTS.halfLifeConf);
  expect(sum(aged)).toBeCloseTo(sum(fresh) / 2, 10);
  expect(aged).toBeLessThan(fresh);
  for (const age of [0, DAY, 100 * DAY, 100_000 * DAY]) {
    const c = confidence(store, f, T0 + age);
    expect(c).toBeGreaterThanOrEqual(0);
    expect(c).toBeLessThanOrEqual(1);
  }
  write(store, accepted([draft({ factId: f, isDeleted: true, header: "", content: "" })]), T0 + 1);
  expect(confidence(store, f, T0 + 2)).toBe(0);
});

it("Query limit", async () => {
  const w = await mcp();
  const over = await w.call("search", {
    query: Array.from({ length: EMBED_WINDOW * 2 }, (_, i) => `word${i}`).join(" "),
  });
  expect(over.isError).toBe(true);
  expect(over.content[0].text).toContain(String(EMBED_WINDOW));
  const under = await w.call("search", {
    query: Array.from({ length: Math.floor(EMBED_WINDOW / 2) }, () => "the").join(" "),
  });
  expect(under.isError).toBeFalsy();
});

it("Correction duty", async () => {
  const w = await mcp();
  const { tools } = await w.client.listTools();
  for (const name of ["search", "getFact"]) {
    expect(tools.find((t) => t.name === name)?.description?.endsWith(CORRECTION_DUTY)).toBe(true);
  }
});

it("Linked reads", async () => {
  const w = await mcp();
  await w.write(accepted([draft()]));
  const factId = factIdOf(w.store);
  const run = async (query: string) => (await w.call<SearchOut>("search", { query })).structuredContent;
  // Two searches list the same fact; each result carries its own ref.
  const first = await run("creeper damage");
  const second = await run("creeper damage again");
  const firstRef = first.results.find((r) => r.kind === SearchHitKind.Fact)?.ref ?? "";
  expect(firstRef).not.toBe("");

  // A read by the ref of the first search links to the first search, and to no other.
  expect((await w.call("getFact", { ref: firstRef })).isError).toBeFalsy();
  // A read by id is an unlinked read, though both searches listed the fact.
  expect((await w.call("getFact", { id: factId })).isError).toBeFalsy();
  const linked = w.store.db
    .prepare("SELECT sr.search_id AS searchId FROM retrievals r JOIN search_results sr ON sr.ref = r.ref")
    .all();
  expect(linked).toEqual([{ searchId: first.searchId }]);
  expect(readsPerSearch(w.store, spanBounds(w.store, Span.All, 0))).toMatchObject({
    searches: 2,
    noResult: 0,
    counts: [1, 1, 0, 0],
    unlinkedReads: 1,
  });
  expect(second.searchId).not.toBe(first.searchId);

  // A ref that no search minted is refused, and records no read.
  expect((await w.call("getFact", { ref: "01NOPE" })).isError).toBe(true);
  expect(w.count("retrievals")).toBe(2);
});

it("When to search", async () => {
  // A wiki endpoint: the instructions on connect carry the subject and name the search tool.
  const subject = "Creeper mobs in a block game.";
  const w = await mcp(subject);
  const instructions = w.client.getInstructions() ?? "";
  expect(instructions).toContain(subject);
  expect(instructions).toContain("`search`");
  const { tools } = await w.client.listTools();
  expect(tools.find((t) => t.name === "search")?.description?.startsWith(SEARCH_TRIGGER)).toBe(true);

  // The management endpoint: each wiki by name and subject.
  const m = startManagement({ alpha: "Alpha things.", beta: "Beta things." });
  cleanups.push(() => m.close());
  const text = (await m.connect()).getInstructions() ?? "";
  for (const s of ["alpha", "Alpha things.", "beta", "Beta things."]) expect(text).toContain(s);
});
