// The requirement tests of docs/requirements/submit.md: one test for each row, named by the Name cell.
import { expect, it } from "vitest";
import { loadSet } from "../../eval/questions/sets.js";
import { scoreAnswer } from "../../eval/questions/score.js";
import { StubQuestions, draftOf } from "../../fakes/stub-questions.js";
import {
  ChangeOutcome,
  CleanupFinder,
  ProcessOutcome,
  QuestionId,
  RejectReason,
  RequestStatus,
  RunOnceStatus,
  SearchHitKind,
  SupportKind,
} from "../../src/domain/enums.js";
import {
  DEFAULT_SEARCH_CAP,
  enqueueRequest,
  enqueueCleanupRepair,
  finishRequest,
  getChangeForRequest,
  getRequest,
  getSearchQuery,
  search,
} from "../../src/store/index.js";
import { runOnce, type RunOnceResult } from "../../src/updates/index.js";
import { mcpPerTest, startManagement } from "../helpers/mcp.js";
import { factIdOf } from "../helpers/store.js";
import { must } from "../helpers/must.js";
import { changesOf, cfg, count, world } from "../helpers/updates.js";

interface RequestOut {
  status: string;
  requestId: string;
  position?: number;
  estimatedSeconds?: number;
}
interface ChangeRequestRow {
  targets: string;
  search_id: string | null;
}
interface SearchOut {
  searchId: string;
}
interface RequestState {
  status: string;
  outcome?: string;
  error?: string;
}

const mcp = mcpPerTest();

/**
 * Returns the result of a finished run.
 *
 * @param r - the result of `runOnce`
 * @returns the processing result
 * @throws {Error} when the run did not finish a request
 * @sideEffects none
 */
function done(r: RunOnceResult) {
  if (r.status !== RunOnceStatus.Done) throw new Error(`expected done, got ${JSON.stringify(r)}`);
  return r.result;
}

/**
 * Picks the cases of the question set of Q7 by their label.
 *
 * @param oneClaim - whether the label says one claim
 * @param support - the support kind of the label; absent matches any
 * @returns the matching cases
 * @sideEffects reads the question set file
 */
const q7Cases = (oneClaim: boolean, support?: SupportKind) =>
  loadSet(QuestionId.Q7).cases.filter(
    (c) => c.expect.oneClaim === oneClaim && (support === undefined || c.expect.support === support),
  );

it("One call", async () => {
  const w = await mcp();
  const { tools } = await w.client.listTools();
  const required = tools.find((t) => t.name === "requestChange")?.inputSchema.required ?? [];
  expect([...required].sort()).toEqual(["change", "justification"]);
  const r = await w.call<RequestOut>("requestChange", {
    change: "Zombies drop no diamonds.",
    justification: "I killed 50.",
  });
  expect(r.structuredContent.status).toBe(RequestStatus.Queued);
  const row = w.store.db
    .prepare("SELECT * FROM change_requests WHERE id = ?")
    .get(r.structuredContent.requestId) as ChangeRequestRow;
  expect(JSON.parse(row.targets)).toEqual([]);
  expect(row.search_id).toBeNull();
});

it("Queue position", async () => {
  const w = await mcp();
  const first = await w.call<RequestOut>("requestChange", { change: "c1", justification: "j" });
  expect(first.structuredContent.position).toBe(1);
  expect(first.structuredContent).not.toHaveProperty("estimatedSeconds");

  // Two worker runs of 40 s each, before c1 is taken.
  for (let i = 0; i < 2; i++) {
    const id = enqueueRequest(w.store, { change: "old", justification: "j" }, 1_699_999_000_000 + i);
    w.store.db
      .prepare("UPDATE change_requests SET status = ?, started_at = ? WHERE id = ?")
      .run(RequestStatus.Running, 1_700_000_000_000, id);
    finishRequest(w.store, id, 1_700_000_040_000);
  }
  const second = await w.call<RequestOut>("requestChange", { change: "c2", justification: "j" });
  // The 2 done rows stay out of the line: c1 and c2 are queued. 2 requests times 40 s.
  expect(second.structuredContent.position).toBe(2);
  expect(second.structuredContent.estimatedSeconds).toBe(80);

  // Queued cleanup repairs run after every submission, so they stay out of the place.
  for (const pair of [["f1", "f2"] as [string, string], ["f3", "f4"] as [string, string]])
    enqueueCleanupRepair(w.store, { finder: CleanupFinder.DuplicateFact, factIds: pair });
  const third = await w.call<RequestOut>("requestChange", { change: "c3", justification: "j" });
  expect(third.structuredContent.position).toBe(3);
  expect(third.structuredContent.estimatedSeconds).toBe(120);
});

it("Bad input refused", async () => {
  const w = await mcp();
  await w.write({
    outcome: ChangeOutcome.Accepted,
    summary: "s",
    changeReasoning: "r",
    facts: [{ header: "Creeper damage", content: "Creepers do 10 damage.", justification: "j", references: [] }],
  });
  const factId = factIdOf(w.store);
  const queuedBefore = w.count("change_requests");
  expect((await w.call("requestChange", { change: "", justification: "j" })).isError).toBe(true);
  expect((await w.call("requestChange", { change: "c", justification: "  " })).isError).toBe(true);
  const bad = await w.call("requestChange", { change: "c", justification: "j", targets: [factId, "01NOPE"] });
  expect(bad.isError).toBe(true);
  expect(bad.content[0]?.text).toContain("01NOPE");
  expect(w.count("change_requests")).toBe(queuedBefore);
});

it("One claim", async () => {
  const claims = ["Skeletons are hostile.", "Skeletons spawn at night."];
  const justification = "I met skeletons only after dark, and they shot at me.";
  // The first Q7 call is the submission, the next ones are its children, which are one claim each.
  const w = world({
    q7: [
      { oneClaim: false, claims, support: SupportKind.Observation, reason: "Two claims." },
      { oneClaim: true, claims: [], support: SupportKind.Observation, reason: "One claim." },
    ],
    q5: [
      draftOf({ header: "Skeleton behavior", content: claims[0] ?? "" }),
      draftOf({ header: "Skeleton spawn time", content: claims[1] ?? "" }),
    ],
  });
  const { id, r } = await w.submit("Skeletons are hostile and spawn at night.", justification, {
    targets: [],
    priorQuery: "skeleton night",
  });
  const parentSearchId = must(must(getRequest(w.store, id)).searchId);
  expect(getSearchQuery(w.store, parentSearchId)).toBe("skeleton night");

  // The parent ends done with the outcome "split" and lists its children; the consumer sends nothing again.
  expect(done(r).outcome).toBe(ProcessOutcome.Split);
  expect(must(getRequest(w.store, id)).status).toBe(RequestStatus.Done);
  expect(changesOf(w.store, id).map((c) => c.outcome)).toEqual([ChangeOutcome.Split]);
  const children = w.store.db
    .prepare("SELECT id, change, justification, search_id FROM change_requests WHERE parent_id = ? ORDER BY rowid")
    .all(id) as { id: string; change: string; justification: string; search_id: string | null }[];
  expect(children.map((c) => c.change)).toEqual(claims);
  for (const c of children) expect(c).toMatchObject({ justification, search_id: parentSearchId });
  expect(done(r).childIds).toEqual(children.map((c) => c.id));
  expect(getChangeForRequest(w.store, id)).toMatchObject({
    outcome: ChangeOutcome.Split,
    childIds: children.map((c) => c.id),
  });

  // Each child goes through the whole process alone and writes its own fact; a child is never split again.
  for (const c of children) {
    expect(done(await w.run()).outcome).toBe(ProcessOutcome.Accepted);
    expect(must(getRequest(w.store, c.id)).status).toBe(RequestStatus.Done);
  }
  expect(count(w.store, "fact_versions")).toBe(2);
  expect(count(w.store, "change_requests", "parent_id IS NOT NULL")).toBe(2);

  // A belief stays a rejection: it is not split.
  const belief = world({
    q7: { oneClaim: false, claims, support: SupportKind.Belief, reason: "An opinion." },
  });
  const rejected = await belief.submit("Skeletons are hostile and spawn at night.", "I think so.");
  expect(done(rejected.r).outcome).toBe(ProcessOutcome.Rejected);
  expect(changesOf(belief.store, rejected.id)[0]?.reject_reason).toBe(RejectReason.Unsupported);
  expect(count(belief.store, "change_requests", "parent_id IS NOT NULL")).toBe(0);

  // A child that is still compound is rejected, never split again.
  const loop = world({ q7: { oneClaim: false, claims, support: SupportKind.Observation, reason: "Two claims." } });
  await loop.submit("Skeletons are hostile and spawn at night.", justification);
  expect(done(await loop.run()).outcome).toBe(ProcessOutcome.Rejected);
  expect(count(loop.store, "change_requests", "parent_id IS NOT NULL")).toBe(2);
});

it("No beliefs", async () => {
  const w = world({
    q7: { oneClaim: true, claims: [], support: SupportKind.Belief, reason: "An opinion, not an observation." },
  });
  const { id, r } = await w.submit("Spiders do 15 damage.", "I think so.");
  done(r);
  const changes = changesOf(w.store, id);
  expect(changes).toHaveLength(1);
  expect(changes[0].outcome).toBe(ChangeOutcome.Rejected);
  expect(changes[0].reject_reason).toBe(RejectReason.Unsupported);
  expect(count(w.store, "fact_versions")).toBe(0);

  // The eval of the claim check holds belief cases, and fails a model that takes them for an observation.
  const beliefs = q7Cases(true, SupportKind.Belief);
  expect(beliefs.length).toBeGreaterThan(0);
  for (const c of beliefs) {
    const wrong = scoreAnswer(
      QuestionId.Q7,
      { oneClaim: true, claims: [], support: SupportKind.Observation, reason: "x" },
      c.expect,
    );
    expect(wrong.pass, c.id).toBe(false);
  }
});

it("Rejection reason", async () => {
  const w = await mcp();
  const reason = "Two claims: hostile and night.";
  const sent = await w.call<RequestOut>("requestChange", {
    change: "Skeletons are hostile and spawn at night.",
    justification: "I met them after dark.",
  });
  const stub = new StubQuestions({ q7: { oneClaim: false, claims: [], support: SupportKind.Observation, reason } });
  done(await runOnce(w.store, stub, cfg, { log: () => undefined }));
  const state = await w.call<RequestState>("getRequest", { requestId: sent.structuredContent.requestId });
  expect(state.structuredContent).toMatchObject({
    status: RequestStatus.Done,
    outcome: ChangeOutcome.Rejected,
    error: reason,
  });
});

it("Missed search repaired", async () => {
  const w = world();
  // More decoys than the default search cap share both query words, so the new fact falls below the cap.
  for (let i = 0; i < DEFAULT_SEARCH_CAP + 2; i++) {
    await w.seed({ header: `skellie health note ${i}`, content: `skellie health value ${i}` });
  }
  const query = "skellie health";
  const headers = async () =>
    (await search(w.store, query)).flatMap((h) => (h.kind === SearchHitKind.Fact ? [h.header] : []));
  const first = await w.submit("Skeletons have 20 health.", "I counted.", { priorQuery: query });
  expect(await headers()).not.toContain("Skeletons have 20 health.");
  const repairId = must(done(first.r).repairRequestId);
  const targetId = must(getRequest(w.store, repairId)).targets[0];

  expect(done(await w.run()).outcome).toBe(ProcessOutcome.Accepted);
  expect(must(getRequest(w.store, repairId)).status).toBe(RequestStatus.Done);
  // The repair fact names the target, and the same search now finds it.
  const refs = w.store.db.prepare("SELECT ref_fact_id FROM fact_version_refs").all() as { ref_fact_id: string }[];
  expect(refs.map((r) => r.ref_fact_id)).toContain(targetId);
  expect(await headers()).toContain(query);
});

it("Linked submissions", async () => {
  const w = await mcp();
  await w.write({
    outcome: ChangeOutcome.Accepted,
    summary: "s",
    changeReasoning: "r",
    facts: [{ header: "Creeper damage", content: "Creepers do 10 damage.", justification: "j", references: [] }],
  });
  const first = (await w.call<SearchOut>("search", { query: "creeper damage" })).structuredContent.searchId;
  const second = (await w.call<SearchOut>("search", { query: "creeper explosion" })).structuredContent.searchId;
  const searchIdOf = (requestId: string) =>
    (
      w.store.db.prepare("SELECT search_id FROM change_requests WHERE id = ?").get(requestId) as {
        search_id: string | null;
      }
    ).search_id;

  // A submission with the searchId of the first search links to that search and to no other.
  const linked = await w.call<RequestOut>("requestChange", {
    change: "Creepers do 12 damage now.",
    justification: "I lost 12 health.",
    searchId: first,
  });
  expect(searchIdOf(linked.structuredContent.requestId)).toBe(first);
  expect(searchIdOf(linked.structuredContent.requestId)).not.toBe(second);
  // The wiki reads the query of that search itself: the consumer sent no text.
  expect(getSearchQuery(w.store, first)).toBe("creeper damage");

  // A submission with no searchId follows no search.
  const bare = await w.call<RequestOut>("requestChange", { change: "c", justification: "j" });
  expect(searchIdOf(bare.structuredContent.requestId)).toBeNull();

  // A searchId that is no search is a tool error, and queues nothing.
  const queued = w.count("change_requests");
  const bad = await w.call("requestChange", { change: "c", justification: "j", searchId: "01NOPE" });
  expect(bad.isError).toBe(true);
  expect(bad.content[0]?.text).toContain("searchId");
  expect(w.count("change_requests")).toBe(queued);
  const tools = (await w.client.listTools()).tools;
  expect(Object.keys(tools.find((t) => t.name === "requestChange")?.inputSchema.properties ?? {})).not.toContain(
    "priorQuery",
  );
});

it("When to submit", async () => {
  // The instructions on connect name the tool that submits, on a wiki endpoint and on the management endpoint.
  const w = await mcp("Creeper mobs in a block game.");
  expect(w.client.getInstructions()).toContain("requestChange");
  const m = startManagement({ alpha: "Alpha things." });
  try {
    expect((await m.connect()).getInstructions()).toContain("requestChange");
  } finally {
    await m.close();
  }
});
