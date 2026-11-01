import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, parseConfig } from "../../config/index.js";
import {
  CallFailureKind,
  ChangeOutcome,
  LogEvent,
  QuestionId,
  RequestKind,
  RequestStatus,
} from "../../domain/enums.js";
import { EMPTY_NOTE, RESULT_NOTE } from "../instructions.js";
import { CORRECTION_DUTY, createServer } from "../server.js";
import {
  MAX_ATTEMPTS,
  applyChange,
  closeStore,
  enqueueRequest,
  failAttempt,
  finishRequest,
  newId,
  openStoreFor,
  setQueuePause,
  writeWorkerStatus,
  type ChangeSet,
  type FactDraft,
  type Store,
  type WorkerStatus,
} from "../../store/index.js";

let dir: string;
let dbPath: string;
let store: Store;
let client: Client;
let logs: Record<string, unknown>[];

interface SearchHit {
  kind: string;
  id: string;
  ref: string;
  header?: string;
  confidence?: number;
}
interface SearchOut {
  searchId: string;
  results: SearchHit[];
  note: string;
}
interface FactOut {
  id: string;
  isDeleted: boolean;
  confidence: number;
  note: string;
  current: { isDeleted: boolean; justification: string };
}
interface RequestOut {
  status: string;
  requestId: string;
}
interface ChangeRequestRow {
  status: string;
  kind: string;
  change: string;
  targets: string;
  justification: string;
  search_id: string | null;
}

/**
 * Returns x, or throws when it is null or undefined.
 *
 * @param x - the value to check
 * @returns x, narrowed
 * @throws {Error} when x is null or undefined
 */
function must<T>(x: T | null | undefined): T {
  if (x === null || x === undefined) throw new Error("expected a value");
  return x;
}

const draft = (over: Partial<FactDraft> = {}): FactDraft => ({
  header: "Creeper damage",
  content: "Creepers do 10 damage.",
  justification: "I measured 10 damage.",
  references: [],
  ...over,
});
const accepted = (facts: FactDraft[]): ChangeSet => ({
  outcome: ChangeOutcome.Accepted,
  summary: "test",
  changeReasoning: "test reasoning",
  facts,
});
async function write(cs: ChangeSet) {
  return applyChange(store, enqueueRequest(store, { change: "c", justification: "j" }), cs);
}
const count = (table: string, where = "1=1") =>
  (store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number }).n;

async function call<T = Record<string, unknown>>(name: string, args: Record<string, unknown>) {
  return (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    structuredContent: T;
    content: { type: string; text: string }[];
  };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "wikifact-mcp-"));
  dbPath = join(dir, "wiki.sqlite");
  const config = parseConfig({ embeddingModel: "test-model" });
  store = openStoreFor(config, dbPath);
  logs = [];
  const server = createServer({ dbPath, config, writeStore: store, log: (l) => logs.push(l) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
});
afterEach(async () => {
  await client.close();
  closeStore(store);
});

describe("tool list", () => {
  it("has the 4 tools without a wiki argument, and search and getFact end with the correction duty", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["getFact", "getRequest", "requestChange", "search"]);
    for (const t of tools) expect(Object.keys(t.inputSchema.properties ?? {})).not.toContain("wiki");
    expect(tools.find((t) => t.name === "getRequest")?.annotations).toMatchObject({ readOnlyHint: true });
    for (const name of ["search", "getFact"]) {
      expect(must(must(tools.find((t) => t.name === name)).description).endsWith(CORRECTION_DUTY)).toBe(true);
    }
  });

  it("marks search, getFact and requestChange as always loaded, and no other tool", async () => {
    const { tools } = await client.listTools();
    const marked = tools.filter((t) => t._meta?.["anthropic/alwaysLoad"] === true).map((t) => t.name);
    expect(marked.sort()).toEqual(["getFact", "requestChange", "search"]);
    expect(tools.filter((t) => t._meta !== undefined).length).toBe(3);
  });

  it("carries the correction duty rule text, with the words of the result note", () => {
    expect(CORRECTION_DUTY).toContain("what you observed that the wiki lacks or gets wrong");
    expect(RESULT_NOTE).toContain("what you observed that the wiki lacks or gets wrong");
  });
});

describe("search", () => {
  it('returns facts only with the shapes of technical/lookup.md, "search", and records no retrieval', async () => {
    await write(accepted([draft()]));
    const r = await call<SearchOut>("search", { query: "creeper damage" });
    expect(r.isError).toBeFalsy();
    const results = r.structuredContent.results;
    expect(results.length).toBeGreaterThan(0);
    const fact = must(results.find((x) => x.kind === "fact"));
    expect(r.structuredContent.note).toBe(RESULT_NOTE);
    expect((JSON.parse(r.content[0]?.text ?? "{}") as { note?: string }).note).toBe(RESULT_NOTE);
    expect(Object.keys(r.structuredContent).sort()).toEqual(["note", "results", "searchId"]);
    expect(Object.keys(fact).sort()).toEqual(["confidence", "header", "id", "kind", "ref", "score"]);
    expect(fact.header).toBe("Creeper damage");
    expect(fact.confidence).toBeGreaterThan(0);
    for (const hit of results) expect(hit.kind).toBe("fact");
    expect(count("retrievals")).toBe(0);
  });

  it("mints a searchId and a distinct ref per result, and logs them", async () => {
    await write(accepted([draft(), draft({ header: "Creeper speed", content: "Creepers walk slowly." })]));
    const r = await call<SearchOut>("search", { query: "creeper damage" });
    const { searchId, results } = r.structuredContent;
    expect(results.length).toBeGreaterThan(1);
    expect(new Set(results.map((x) => x.ref)).size).toBe(results.length);
    expect(store.db.prepare("SELECT id, query FROM searches").all()).toEqual([
      { id: searchId, query: "creeper damage" },
    ]);
    expect(store.db.prepare("SELECT ref FROM search_results WHERE search_id = ? ORDER BY rank").all(searchId)).toEqual(
      results.map((x) => ({ ref: x.ref })),
    );
    const again = await call<SearchOut>("search", { query: "creeper damage" });
    expect(again.structuredContent.searchId).not.toBe(searchId);
    expect(again.structuredContent.results.map((x) => x.ref)).not.toContain(results[0]?.ref);
  });

  it("returns the results with no searchId and no ref when the log write fails, and logs the error", async () => {
    await write(accepted([draft()]));
    const id = (store.db.prepare("SELECT id FROM facts").get() as { id: string }).id;
    store.db.exec("DROP TABLE search_results");
    const r = await call<SearchOut>("search", { query: "creeper damage" });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).not.toHaveProperty("searchId");
    expect(r.structuredContent.results.length).toBeGreaterThan(0);
    for (const hit of r.structuredContent.results) expect(hit).not.toHaveProperty("ref");
    expect(logs.some((l) => l.event === LogEvent.RetrievalError && l.tool === "search")).toBe(true);
    expect((await call("getFact", { id })).isError).toBeFalsy();
  });

  it("respects searchCap and does not return deleted facts", async () => {
    await write(accepted([draft({ factId: newId() })]));
    const id = (store.db.prepare("SELECT id FROM facts").get() as { id: string }).id;
    await write({ ...accepted([draft({ factId: id, isDeleted: true, justification: "It is gone." })]) });
    const r = await call<SearchOut>("search", { query: "creeper damage" });
    expect(r.structuredContent.results).toEqual([]);
    expect(r.structuredContent.note).toBe(EMPTY_NOTE);
    expect((JSON.parse(r.content[0]?.text ?? "{}") as { note?: string }).note).toBe(EMPTY_NOTE);
  });

  it("rejects an empty query", async () => {
    expect((await call("search", { query: "   " })).isError).toBe(true);
  });
});

describe("getFact", () => {
  it('returns the shape of technical/lookup.md, "getFact" and records one retrieval row', async () => {
    await write(accepted([draft()]));
    const id = (store.db.prepare("SELECT id FROM facts").get() as { id: string }).id;
    const r = await call<FactOut>("getFact", { id });
    expect(r.isError).toBeFalsy();
    const out = r.structuredContent;
    expect(Object.keys(out).sort()).toEqual(["confidence", "current", "id", "isDeleted", "note"]);
    expect(out.note).toBe(RESULT_NOTE);
    expect((JSON.parse(r.content[0]?.text ?? "{}") as { note?: string }).note).toBe(RESULT_NOTE);
    expect(out.id).toBe(id);
    expect(out.isDeleted).toBe(false);
    expect(out.confidence).toBeGreaterThan(0);
    expect(Object.keys(out.current).sort()).toEqual([
      "changeReasoning",
      "content",
      "created",
      "header",
      "isDeleted",
      "justification",
      "references",
      "seq",
    ]);
    expect(count("retrievals")).toBe(1);
    await call("getFact", { id });
    expect(count("retrievals")).toBe(2);
    expect(count("retrievals", "kind = 'read'")).toBe(2);
  });

  it("returns a deleted fact with isDeleted true, confidence 0, and records nothing", async () => {
    await write(accepted([draft()]));
    const id = (store.db.prepare("SELECT id FROM facts").get() as { id: string }).id;
    await write(accepted([draft({ factId: id, isDeleted: true, justification: "It was removed in the update." })]));
    const r = await call<FactOut>("getFact", { id });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.isDeleted).toBe(true);
    expect(r.structuredContent.confidence).toBe(0);
    expect(r.structuredContent.current.isDeleted).toBe(true);
    expect(r.structuredContent.current.justification).toBe("It was removed in the update.");
    expect(count("retrievals")).toBe(0);
  });

  it("returns a tool error for an unknown id and records nothing", async () => {
    const r = await call("getFact", { id: "01NOPE" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/01NOPE/);
    expect(count("retrievals")).toBe(0);
  });

  it("reads by ref, records the ref, and records NULL for a read by id", async () => {
    await write(accepted([draft()]));
    const id = (store.db.prepare("SELECT id FROM facts").get() as { id: string }).id;
    const found = (await call<SearchOut>("search", { query: "creeper damage" })).structuredContent.results;
    const ref = must(found.find((x) => x.kind === "fact")).ref;
    const r = await call<FactOut>("getFact", { ref });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.id).toBe(id);
    await call("getFact", { id });
    expect(store.db.prepare("SELECT ref FROM retrievals ORDER BY at, rowid").all()).toEqual([{ ref }, { ref: null }]);
  });

  it("returns a tool error for a ref that no search minted, and for no argument or both", async () => {
    await write(accepted([draft()]));
    const id = (store.db.prepare("SELECT id FROM facts").get() as { id: string }).id;
    const found = (await call<SearchOut>("search", { query: "creeper damage" })).structuredContent.results;
    const bad = await call("getFact", { ref: "01NOPE" });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toMatch(/no result has this ref/);
    expect((await call("getFact", {})).isError).toBe(true);
    expect((await call("getFact", { ref: must(found.find((x) => x.kind === "fact")).ref, id })).isError).toBe(true);
    expect(count("retrievals")).toBe(0);
  });
});

describe("requestChange", () => {
  it("queues a row and returns at once", async () => {
    await write(accepted([draft()]));
    const { searchId } = (await call<SearchOut>("search", { query: "explosion damage" })).structuredContent;
    const factId = (store.db.prepare("SELECT id FROM facts").get() as { id: string }).id;
    const r = await call<RequestOut>("requestChange", {
      change: "Creepers do 12 damage now.",
      targets: [factId],
      justification: "I stood next to one and lost 12 health.",
      searchId,
    });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.status).toBe(RequestStatus.Queued);
    const row = store.db
      .prepare("SELECT * FROM change_requests WHERE id = ?")
      .get(r.structuredContent.requestId) as ChangeRequestRow;
    expect(row.status).toBe(RequestStatus.Queued);
    expect(row.kind).toBe(RequestKind.Submission);
    expect(row.change).toBe("Creepers do 12 damage now.");
    expect(JSON.parse(row.targets)).toEqual([factId]);
    expect(row.justification).toBe("I stood next to one and lost 12 health.");
    expect(row.search_id).toBe(searchId);
  });

  it("stores NULL for a call with no searchId, and rejects a searchId that is no search", async () => {
    const r = await call<RequestOut>("requestChange", { change: "c", justification: "j" });
    const row = store.db
      .prepare("SELECT * FROM change_requests WHERE id = ?")
      .get(r.structuredContent.requestId) as ChangeRequestRow;
    expect(row.search_id).toBeNull();
    const bad = await call("requestChange", { change: "c", justification: "j", searchId: "01NOPE" });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toMatch(/searchId/);
    expect(count("change_requests")).toBe(1);
  });

  it("accepts a deleted fact id as a target", async () => {
    await write(accepted([draft(), draft({ header: "Other", content: "Other." })]));
    const factId = (
      store.db.prepare("SELECT fact_id AS id FROM fact_versions WHERE header = 'Creeper damage'").get() as {
        id: string;
      }
    ).id;
    await write(accepted([draft({ factId, isDeleted: true, justification: "It was removed in the update." })]));
    const before = count("change_requests");
    const r = await call<RequestOut>("requestChange", { change: "c", justification: "j", targets: [factId] });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.status).toBe(RequestStatus.Queued);
    expect(count("change_requests")).toBe(before + 1);
  });

  it("rejects a call with a missing field", async () => {
    let failed: boolean;
    try {
      const r = await call("requestChange", { change: "c" });
      failed = r.isError === true;
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    expect(count("change_requests")).toBe(0);
  });
});

describe("getRequest", () => {
  interface GetRequestOut {
    requestId: string;
    status: string;
    outcome?: string;
    duplicateOf?: string;
    factIds?: string[];
    error?: string;
    attempts: number;
    finishedAt?: number;
  }

  it("reports a queued request with its attempts and nothing else", async () => {
    const queued = await call<RequestOut>("requestChange", { change: "c", justification: "j" });
    const r = await call<GetRequestOut>("getRequest", { requestId: queued.structuredContent.requestId });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toEqual({
      requestId: queued.structuredContent.requestId,
      status: RequestStatus.Queued,
      attempts: 0,
    });
  });

  it("reports a done request with the outcome of its change and its finish time", async () => {
    const id = enqueueRequest(store, { change: "c", justification: "j" });
    const { factIds } = await applyChange(store, id, accepted([draft()]));
    finishRequest(store, id, 1_700_000_000_000);
    const r = await call<GetRequestOut>("getRequest", { requestId: id });
    expect(factIds).toHaveLength(1);
    expect(r.structuredContent).toEqual({
      requestId: id,
      status: RequestStatus.Done,
      outcome: ChangeOutcome.Accepted,
      factIds,
      attempts: 0,
      finishedAt: 1_700_000_000_000,
    });
  });

  it("names the duplicated fact for a duplicate, and no factIds", async () => {
    const { factIds } = await write(accepted([draft()]));
    const id = enqueueRequest(store, { change: "c", justification: "j" });
    await applyChange(store, id, {
      ...accepted([]),
      outcome: ChangeOutcome.Duplicate,
      duplicateOf: factIds[0],
    });
    finishRequest(store, id, 1_700_000_000_000);
    const r = await call<GetRequestOut>("getRequest", { requestId: id });
    expect(r.structuredContent.outcome).toBe(ChangeOutcome.Duplicate);
    expect(r.structuredContent.duplicateOf).toBe(factIds[0]);
    expect(r.structuredContent).not.toHaveProperty("factIds");
  });

  it("reports a failed request with its error", async () => {
    const id = enqueueRequest(store, { change: "c", justification: "j" });
    for (let i = 0; i < MAX_ATTEMPTS; i++) failAttempt(store, id, "model said no", 1_700_000_000_000);
    const r = await call<GetRequestOut>("getRequest", { requestId: id });
    expect(r.structuredContent).toMatchObject({
      status: RequestStatus.Failed,
      error: "model said no",
      attempts: MAX_ATTEMPTS,
      finishedAt: 1_700_000_000_000,
    });
    expect(r.structuredContent).not.toHaveProperty("outcome");
  });

  it("returns a tool error for an unknown id", async () => {
    const r = await call("getRequest", { requestId: "01NOPE" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/01NOPE/);
  });
});

describe('requestChange warning (technical/submit.md, "requestChange")', () => {
  const NOW_AGO_MS = 1000;
  const STALE_MS = 61_000;
  const send = () => call<RequestOut & { warning?: string }>("requestChange", { change: "c", justification: "j" });
  const status = (over: Partial<WorkerStatus> = {}): WorkerStatus => ({
    pid: 1,
    startedAt: Date.now() - STALE_MS,
    lastPollAt: Date.now() - NOW_AGO_MS,
    consecutiveFailures: 0,
    ...over,
  });

  it("has no warning when the worker polls and its last call worked", async () => {
    writeWorkerStatus(store, status({ lastCall: { ok: true, at: Date.now() } }));
    const r = await send();
    expect(r.structuredContent).not.toHaveProperty("warning");
    expect(count("change_requests")).toBe(1);
  });

  it("warns when the worker has not polled for more than 60 seconds", async () => {
    const lastPollAt = Date.now() - STALE_MS;
    writeWorkerStatus(store, status({ lastPollAt }));
    const r = await send();
    expect(r.structuredContent.warning).toBe(`the worker has not polled since ${new Date(lastPollAt).toISOString()}`);
    expect(count("change_requests")).toBe(1);
  });

  it("warns that the operator paused the queue, with the note, and still queues the request", async () => {
    writeWorkerStatus(store, status({ lastCall: { ok: true, at: Date.now() } }));
    const at = Date.now() - NOW_AGO_MS;
    // The key alone: the worker status does not say paused.
    setQueuePause(store, "measuring", at);
    const r = await send();
    expect(r.structuredContent.warning).toBe(
      `the operator paused the queue at ${new Date(at).toISOString()}: measuring; the request waits until the operator resumes the queue`,
    );
    expect(count("change_requests")).toBe(1);
  });

  it("names a stale poll before the operator pause", async () => {
    writeWorkerStatus(store, status({ lastPollAt: Date.now() - STALE_MS }));
    setQueuePause(store, "measuring", Date.now());
    const r = await send();
    expect(r.structuredContent.warning).toContain("has not polled");
  });

  it("warns on a credential failure and names claude setup-token", async () => {
    const at = Date.now() - NOW_AGO_MS;
    writeWorkerStatus(
      store,
      status({
        lastCall: { ok: false, kind: CallFailureKind.Credential, message: "401 invalid x-api-key", at },
        consecutiveFailures: 1,
      }),
    );
    const r = await send();
    expect(r.structuredContent.warning).toBe(
      `the worker's model credential failed at ${new Date(at).toISOString()}: 401 invalid x-api-key; an expired token needs \`claude setup-token\``,
    );
    expect(count("change_requests")).toBe(1);
  });

  it("warns when the last model calls failed MAX_ATTEMPTS times in a row", async () => {
    writeWorkerStatus(
      store,
      status({
        lastCall: { ok: false, kind: CallFailureKind.Other, message: "boom", at: Date.now() },
        consecutiveFailures: MAX_ATTEMPTS,
      }),
    );
    const r = await send();
    expect(r.structuredContent.warning).toBe(`the worker's last ${MAX_ATTEMPTS} model calls failed: boom`);
  });

  it("has no warning for fewer failures than MAX_ATTEMPTS", async () => {
    writeWorkerStatus(
      store,
      status({
        lastCall: { ok: false, kind: CallFailureKind.RateLimit, message: "429", at: Date.now() },
        consecutiveFailures: MAX_ATTEMPTS - 1,
      }),
    );
    const r = await send();
    expect(r.structuredContent).not.toHaveProperty("warning");
  });
});

describe("logging", () => {
  it("writes one JSON-able line per tool call", async () => {
    await call("search", { query: "x" });
    await call("getFact", { id: "nope" });
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatchObject({ event: "tool", tool: "search", ok: true });
    expect(logs[1]).toMatchObject({ event: "tool", tool: "getFact", ok: true, error: 'no fact with id "nope"' });
    for (const l of logs) expect(() => JSON.stringify(l)).not.toThrow();
  });
});

describe("config", () => {
  it("gives the technical/README.md, Open settings defaults for every missing key", () => {
    const c = parseConfig({});
    expect(c.searchCap).toBe(10);
    expect(c.agentSearchCap).toBe(20);
    expect(c.questionTimeout).toBe(120);
    expect(c.embeddingModel).toBe("Xenova/bge-small-en-v1.5");
    expect(c.weights).toMatchObject({ wUpdate: 1, wConfirm: 1, wRead: 0, wUse: 0.01, useBound: 0.1 });
    expect(c.relevanceFloor).toBe(0.31);
    expect(c.weights.halfLifeConf).toBe(30 * 86_400_000);
    expect(Object.keys(c.questions)).toHaveLength(Object.values(QuestionId).length);
    expect(c.quality).toBe("standard");
  });

  it("merges partial overrides and rejects bad input", () => {
    const c = parseConfig({
      searchCap: 5,
      weights: { wRead: 0.5 },
      questions: { Q4: { model: "claude-opus-5-5", effort: "high" } },
    });
    expect(c.searchCap).toBe(5);
    expect(c.weights.wRead).toBe(0.5);
    expect(c.weights.wUpdate).toBe(1);
    expect(c.questions.Q4.model).toBe("claude-opus-5-5");
    expect(c.questions.Q1).toEqual(parseConfig({}).questions.Q1); // the other questions keep the preset
    expect(() => parseConfig({ searchCap: 0 })).toThrow();
    expect(() => parseConfig({ unknownKey: 1 })).toThrow();
    // Q13 is reserved for the future missing-reference question (future.md) and is no QuestionId.
    expect(() => parseConfig({ questions: { Q13: { model: "m", effort: "low" } } })).toThrow();
  });

  it("loads wikifact.json next to the database", () => {
    expect(loadConfig(dbPath).searchCap).toBe(10);
    writeFileSync(join(dir, "wikifact.json"), JSON.stringify({ subject: "A game", searchCap: 7 }));
    const c = loadConfig(dbPath);
    expect(c.subject).toBe("A game");
    expect(c.searchCap).toBe(7);
    writeFileSync(join(dir, "wikifact.json"), "{ nope");
    expect(() => loadConfig(dbPath)).toThrow(/not valid JSON/);
  });
});
