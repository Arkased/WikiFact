import { describe, expect, it } from "vitest";
import {
  ChangeOutcome,
  LogEvent,
  ProcessOutcome,
  Q2Stands,
  Q4Relation,
  RejectReason,
  RequestKind,
  RequestStatus,
  RunOnceStatus,
  SupportKind,
  WrongRelatedAction,
} from "../../domain/enums.js";
import { enqueueRequest, getRequest, getSearchQuery, searchAndLog } from "../../store/index.js";
import type { Q4Output, RunOnceResult } from "../index.js";
import { changesOf, count, refs, versions, world, type VersionRow } from "../../../__tests__/helpers/updates.js";

function must<T>(x: T | undefined | null): T {
  if (x === undefined || x === null) throw new Error("expected a value");
  return x;
}

function call(w: ReturnType<typeof world>, q: string) {
  return must(w.q.calls.find((c) => c.q === q));
}

function done(r: RunOnceResult) {
  if (r.status !== RunOnceStatus.Done) throw new Error(`expected done, got ${JSON.stringify(r)}`);
  return r.result;
}

const supported = (over: Partial<Q4Output> = {}): Q4Output => ({
  supported: true,
  wrongRelated: [],
  reason: "Q4 REASON",
  ...over,
});

describe("a new fact", () => {
  it("writes one version with the submitter's justification, the pre-assigned id and the code summary", async () => {
    const w = world({
      q5: {
        drafts: [{ header: "Creeper damage", content: "Creepers do 10 damage.", references: [] }],
      },
      q4: supported(),
    });
    const { id, r } = await w.submit("Creepers do 10 damage.", "I took 10 damage from a creeper.");
    const res = done(r);
    expect(res.outcome).toBe(ProcessOutcome.Accepted);
    expect(must(getRequest(w.store, id)).status).toBe(RequestStatus.Done);

    const ch = changesOf(w.store, id);
    expect(ch).toHaveLength(1);
    expect(ch[0].outcome).toBe(ChangeOutcome.Accepted);
    expect(ch[0].summary).toBe('created "Creeper damage".');

    const row = w.store.db.prepare("SELECT fact_id FROM fact_versions").get() as { fact_id: string };
    const v = versions(w.store, row.fact_id);
    expect(v).toHaveLength(1);
    expect(v[0].justification).toBe("I took 10 damage from a creeper.");
    expect(v[0].change_reasoning).toBe("Q4 REASON");
    expect(w.q.count("q8")).toBe(0);
    // Q7 ran once, on the submission.
    expect(w.q.count("q7")).toBe(1);
  });

  it("logs one JSON line per change with seq, request_id, outcome, tokens and duration", async () => {
    const w = world();
    const { id, r } = await w.submit("Creepers do 10 damage.", "I saw it.");
    done(r);
    const line = must(w.logs.find((l) => l.event === LogEvent.Change));
    expect(line.request_id).toBe(id);
    expect(line.outcome).toBe(ChangeOutcome.Accepted);
    expect(typeof line.seq).toBe("number");
    expect(line.tokens).toEqual({ input: 0, output: 0 });
    expect(typeof line.duration_ms).toBe("number");
    expect(line.passes).toBe(0);
    expect(line.rejudged).toBe(0);
  });

  it("orders candidates by cosine distance, nearest first, and puts targets first in Q1", async () => {
    const w = world();
    const far = await w.seed({ header: "Villager trading", content: "Villagers trade emeralds for items." });
    const near = await w.seed({ header: "Creeper damage", content: "Creepers do 10 damage to players." });
    const mid = await w.seed({ header: "Zombie damage", content: "Zombies do 3 damage." });
    await w.submit("Creepers do 12 damage to players.", "I measured 12.", { targets: [far] });
    const q1 = call(w, "q1");
    const ids = (q1.input as { candidates: { factId: string }[] }).candidates.map((c) => c.factId);
    expect(ids[0]).toBe(far); // the target comes first
    expect(ids.indexOf(near)).toBeLessThan(ids.indexOf(mid));
    expect(ids.indexOf(mid)).toBeLessThan(ids.length);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("drops a target id that does not exist and logs it", async () => {
    const w = world();
    const { r } = await w.submit("Creepers do 10 damage.", "I saw it.", { targets: ["01NOSUCHFACT"] });
    done(r);
    expect(w.logs.some((l) => l.event === LogEvent.Gather && l.droppedTarget === "01NOSUCHFACT")).toBe(true);
  });
});

describe("the evidence rule", () => {
  it("removes changeReasoning and summary from the material every question gets", async () => {
    const w = world();
    const id = await w.seed({ header: "Creeper damage", content: "Creepers do 10 damage." });
    w.q.set("q1", { matches: [id] });
    await w.submit("Creepers do 12 damage.", "I measured 12.");
    const all = JSON.stringify(w.q.calls.map((c) => c.input));
    expect(all).not.toContain("SECRET REASON");
    expect(all).not.toContain("SECRET SUMMARY");
    expect(all).not.toContain("changeReasoning");
    expect(all).not.toContain("summary");
    // The justification stays.
    expect(all).toContain("I saw it.");
  });
});

describe("a duplicate", () => {
  it("writes a confirm row and no new version", async () => {
    const w = world();
    const id = await w.seed({ header: "Creeper damage", content: "Creepers do 10 damage." });
    w.q.set("q1", { matches: [id] });
    w.q.set("q4", supported({ relation: Q4Relation.Same }));
    const before = count(w.store, "fact_versions");
    const { id: reqId, r } = await w.submit("Creepers do 10 damage.", "I saw 10.");
    const res = done(r);
    expect(res.outcome).toBe(ProcessOutcome.Duplicate);
    expect(count(w.store, "fact_versions")).toBe(before);
    const ch = changesOf(w.store, reqId);
    expect(ch).toHaveLength(1);
    expect(ch[0].outcome).toBe(ChangeOutcome.Duplicate);
    const v = versions(w.store, id)[0];
    expect(count(w.store, "retrievals", `fact_version_id = ${v.id} AND kind = 'confirm'`)).toBe(1);
    expect(w.q.count("q5")).toBe(0);
  });
});

describe("an unrelated existing fact (F24)", () => {
  it("writes a new fact, leaves the sibling untouched and logs scope_overmatch", async () => {
    const w = world({
      q5: {
        drafts: [{ header: "Errors log files", content: "The errors log keeps 10 files.", references: [] }],
      },
    });
    const sibling = await w.seed({ header: "Full log files", content: "The full log keeps 5 files." });
    w.q.set("q1", { matches: [sibling] });
    w.q.set("q4", supported({ relation: Q4Relation.Unrelated, reason: "The existing fact is about the full log." }));
    const before = versions(w.store, sibling);
    const { id: reqId, r } = await w.submit("The errors log keeps 10 files.", "I counted 10 files.");
    const res = done(r);
    expect(res.outcome).toBe(ProcessOutcome.Accepted);
    expect(versions(w.store, sibling)).toEqual(before);
    const ch = changesOf(w.store, reqId);
    expect(ch).toHaveLength(1);
    expect(ch[0].outcome).toBe(ChangeOutcome.Accepted);
    expect(count(w.store, "facts")).toBe(2);
    expect((call(w, "q5").input as { existing?: unknown }).existing).toBeUndefined();
    const line = must(w.logs.find((l) => l.event === LogEvent.ScopeOvermatch));
    expect(line).toMatchObject({
      request_id: reqId,
      existingFactId: sibling,
      reason: "The existing fact is about the full log.",
    });
  });
});

describe("a rejection", () => {
  for (const reason of [RejectReason.Unsupported, RejectReason.Contradicted, RejectReason.Compound]) {
    it(`writes a changes row and no fact when the claim is ${reason}`, async () => {
      const w = world({ q4: supported({ supported: false, rejectReason: reason }) });
      const { id, r } = await w.submit("Zombies drop diamonds.", "I guess.");
      expect(done(r).outcome).toBe(ProcessOutcome.Rejected);
      const ch = changesOf(w.store, id);
      expect(ch).toHaveLength(1);
      expect(ch[0].outcome).toBe(ChangeOutcome.Rejected);
      expect(ch[0].reject_reason).toBe(reason);
      expect(count(w.store, "fact_versions")).toBe(0);
      expect(w.q.count("q5")).toBe(0);
    });
  }
});

describe("a correction", () => {
  it("writes a new version of the fact in the same scope", async () => {
    const w = world();
    const id = await w.seed({ header: "Creeper damage", content: "Creepers do 10 damage.", justification: "old" });
    w.q.set("q1", { matches: [id] });
    w.q.set("q4", supported({ relation: Q4Relation.Different }));
    const { r } = await w.submit("Creepers do 12 damage.", "I measured 12.");
    expect(done(r).outcome).toBe(ProcessOutcome.Accepted);
    const v = versions(w.store, id);
    expect(v).toHaveLength(2);
    expect(v[1].content).toBe("Creepers do 12 damage.");
    expect(v[1].justification).toBe("I measured 12.");
    expect(count(w.store, "facts")).toBe(1);
    const q5 = call(w, "q5");
    expect(must((q5.input as { existing?: { factId: string } }).existing).factId).toBe(id);
  });
});

describe("a revival", () => {
  it("writes a new live version of a deleted fact, even when the claim says the same", async () => {
    const w = world();
    const id = await w.seed({ header: "Creeper damage", content: "Creepers do 10 damage." });
    await w.seedDelete(id);
    w.q.set("q1", { matches: [id] });
    w.q.set("q4", supported({ relation: Q4Relation.Same }));
    const { r } = await w.submit("Creepers do 10 damage.", "I took 10 damage again.");
    expect(done(r).outcome).toBe(ProcessOutcome.Accepted);
    const v = versions(w.store, id);
    expect(v).toHaveLength(3);
    expect(v[2].is_deleted).toBe(0);
    expect(count(w.store, "retrievals", "kind = 'confirm'")).toBe(0);
  });

  it("picks the most recently deleted match as the existing fact when no match is live", async () => {
    const w = world();
    const a = await w.seed({ header: "Creeper damage", content: "Creepers do 10 damage." });
    const b = await w.seed({ header: "Creeper explosion", content: "Creepers do 7 damage." });
    await w.seedDelete(a);
    await w.seedDelete(b);
    w.q.set("q1", { matches: [a, b] });
    await w.submit("Creepers do 12 damage.", "I measured 12.");
    const q4 = call(w, "q4");
    expect(must((q4.input as { existing?: { factId: string } }).existing).factId).toBe(b);
  });

  it("drops deleted matches when a live match exists", async () => {
    const w = world();
    const live = await w.seed({ header: "Creeper damage", content: "Creepers do 10 damage." });
    const dead = await w.seed({ header: "Creeper explosion", content: "Creepers do 7 damage." });
    await w.seedDelete(dead);
    w.q.set("q1", { matches: [live, dead] });
    await w.submit("Creepers do 12 damage.", "I measured 12.");
    const q4 = call(w, "q4");
    const input = q4.input as { existing?: { factId: string }; related: { factId: string }[] };
    expect(must(input.existing).factId).toBe(live);
    expect(input.related.map((f) => f.factId)).not.toContain(dead);
  });
});

describe("a deletion by negation", () => {
  it("drops a narrow action of a related fact, since no claim draft exists to narrow against", async () => {
    const w = world();
    const id = await w.seed({ header: "Torch recipe", content: "A torch needs coal and a stick." });
    const pair = await w.seed({ header: "Torch and lantern recipes", content: "Torches and lanterns need coal." });
    w.q.set("q1", { matches: [id] });
    w.q.set(
      "q4",
      supported({
        relation: Q4Relation.Negates,
        wrongRelated: [{ factId: pair, action: WrongRelatedAction.Narrow }],
      }),
    );
    const { r } = await w.submit("Torches can no longer be crafted.", "I tried at the table: nothing.");
    done(r);
    expect(versions(w.store, pair)).toHaveLength(1);
    expect(w.q.count("q6")).toBe(0);
  });

  it("a negation of a fact that is already deleted writes nothing and is a duplicate of the deletion", async () => {
    const w = world();
    const id = await w.seed({ header: "Torch recipe", content: "A torch needs coal and a stick." });
    await w.seedDelete(id);
    w.q.set("q1", { matches: [id] });
    w.q.set("q4", supported({ relation: Q4Relation.Negates }));
    const { id: reqId, r } = await w.submit("Torches can no longer be crafted.", "I tried at the table: nothing.");
    expect(done(r).outcome).toBe(ProcessOutcome.Duplicate);
    expect(changesOf(w.store, reqId)[0]).toMatchObject({ outcome: "duplicate", duplicate_of: id });
    expect(versions(w.store, id)).toHaveLength(2);
    expect(count(w.store, "retrievals", "kind = 'confirm'")).toBe(0);
  });
});

describe("a deleted claim sent again", () => {
  async function deleted() {
    const w = world();
    const id = await w.seed({ header: "Healing potion effect", content: "A healing potion restores 4 health." });
    await w.seedDelete(id);
    w.q.set("q1", { matches: [id] });
    return { w, id };
  }

  it("with a weaker observation writes a live version whose content negates the claim", async () => {
    const { w, id } = await deleted();
    w.q.set("q4", supported({ relation: Q4Relation.Stale }));
    w.q.set("q5", {
      drafts: [
        {
          header: "Healing potion effect",
          content: "A healing potion no longer restores 4 health.",
          references: [],
        },
      ],
    });
    const { id: reqId, r } = await w.submit("A healing potion restores 4 health.", "A friend told me it still works.");
    expect(done(r).outcome).toBe(ProcessOutcome.Accepted);
    expect(changesOf(w.store, reqId)[0].outcome).toBe(ChangeOutcome.Accepted);
    const v = versions(w.store, id);
    expect(v).toHaveLength(3);
    expect(v[2].is_deleted).toBe(0);
    expect(v[2].content).toContain("no longer");
    expect(v[2].justification).toBe("A friend told me it still works.");
    expect((call(w, "q5").input as { negate?: boolean }).negate).toBe(true);
    expect(count(w.store, "facts")).toBe(1);
  });

  it("with an observation at least as strong restores the claim, and Q5 is not asked to negate", async () => {
    const { w, id } = await deleted();
    w.q.set("q4", supported({ relation: Q4Relation.Same }));
    const { r } = await w.submit("A healing potion restores 4 health.", "I drank one in the current version: +4.");
    expect(done(r).outcome).toBe(ProcessOutcome.Accepted);
    const v = versions(w.store, id);
    expect(v).toHaveLength(3);
    expect(v[2].is_deleted).toBe(0);
    expect((call(w, "q5").input as { negate?: boolean }).negate).toBeUndefined();
  });

  it("with no observation is rejected, and nothing is written", async () => {
    const { w, id } = await deleted();
    w.q.set("q4", supported({ supported: false, rejectReason: RejectReason.Unsupported }));
    const { r } = await w.submit("A healing potion restores 4 health.", "I think so.");
    expect(done(r).outcome).toBe(ProcessOutcome.Rejected);
    expect(versions(w.store, id)).toHaveLength(2);
    expect(w.q.count("q5")).toBe(0);
  });

  it("stale on a live fact fails the attempt", async () => {
    const w = world();
    const id = await w.seed({ header: "Healing potion effect", content: "A healing potion restores 4 health." });
    w.q.set("q1", { matches: [id] });
    w.q.set("q4", supported({ relation: Q4Relation.Stale }));
    const { r } = await w.submit("A healing potion restores 4 health.", "I saw it.");
    expect(r.status).not.toBe(RunOnceStatus.Done);
    expect(versions(w.store, id)).toHaveLength(1);
  });
});

describe("a merge of 2 live same-scope facts", () => {
  it("commits the merge as its own change, then the claim's", async () => {
    const w = world();
    const keep = await w.seed({
      header: "Creeper damage",
      content: "Creepers do 10 damage.",
      justification: "J-keep-1",
    });
    await w.seedEdit(keep, { header: "Creeper damage", content: "Creepers do 11 damage.", justification: "J-keep-2" });
    const base = await w.seed({ header: "Player health", content: "Players have 20 health." });
    const other = await w.seed({
      header: "Creeper explosion damage",
      content: "Creepers do 12 damage.",
      justification: "J-other",
      references: [base],
    });

    w.q.set("q1", { matches: [other, keep] });
    w.q.set("q2", { stands: Q2Stands.Other, reason: "newer measurement" });
    w.q.set("q4", supported({ relation: Q4Relation.Different }));
    const { id, r } = await w.submit("Creepers do 13 damage.", "I measured 13.");
    const res = done(r);
    expect(res.mergeSeqs).toHaveLength(1);

    const ch = changesOf(w.store, id);
    expect(ch).toHaveLength(2);
    expect(ch[0].outcome).toBe(ChangeOutcome.Accepted);
    expect(ch[0].summary).toContain("Merged");
    expect(ch[0].seq).toBe(res.mergeSeqs[0]);
    expect(ch[1].seq).toBe(res.seq);

    // The kept fact is the one with the most versions: seed, edit, merge, claim.
    const kv = versions(w.store, keep);
    expect(kv.map((v) => v.seq)).toEqual([kv[0].seq, kv[1].seq, ch[0].seq, ch[1].seq]);
    const merged = kv[2];
    expect(merged.content).toBe("Creepers do 12 damage."); // Q2 said the other content stands
    expect(merged.justification).toBe("J-keep-2\n\nJ-other");
    expect(refs(w.store, merged.id)).toEqual([base]); // the union of the references
    expect(kv[3].content).toBe("Creepers do 13 damage.");

    // The other fact is deleted in the merge change, with no references.
    const ov = versions(w.store, other);
    expect(ov).toHaveLength(2);
    expect(ov[1].seq).toBe(ch[0].seq);
    expect(ov[1].is_deleted).toBe(1);
    expect(ov[1].content).toBe("Creepers do 12 damage.");
    expect(ov[1].justification).toBe("J-other");
    expect(refs(w.store, ov[1].id)).toEqual([]);

    // Q4 judges against the merged fact only, and the other fact is not offered as related.
    const q4 = call(w, "q4").input as { existing: { factId: string; versions: VersionRow[] } };
    expect(q4.existing.factId).toBe(keep);
    expect(q4.existing.versions).toHaveLength(3);
    expect(w.q.count("q2")).toBe(1);
  });

  it("writes no merge when Q2 calls the only other fact unrelated, and judges the claim against the kept fact", async () => {
    const w = world();
    const keep = await w.seed({ header: "VEC_CANDIDATES recall at 100k facts", content: "Recall is 0.84 at 100." });
    const sibling = await w.seed({
      header: "VEC_CANDIDATES 200 recall at 100k facts",
      content: "Recall is 0.96 at 200.",
    });
    const beforeKeep = versions(w.store, keep);
    const beforeSibling = versions(w.store, sibling);
    w.q.set("q1", { matches: [keep, sibling] });
    w.q.set("q2", { stands: Q2Stands.Unrelated, reason: "another candidate count" });
    w.q.set("q4", supported({ relation: Q4Relation.Different }));
    const { id, r } = await w.submit("Recall is 0.85 at 100.", "I measured 0.85.");
    const res = done(r);
    expect(res.mergeSeqs).toEqual([]);
    expect(w.q.count("q3")).toBe(0);
    // Only the claim's own change exists; the sibling is live and unchanged.
    expect(changesOf(w.store, id)).toHaveLength(1);
    expect(versions(w.store, sibling)).toEqual(beforeSibling);
    expect(versions(w.store, keep)).toHaveLength(beforeKeep.length + 1);
    const q4 = call(w, "q4").input as { existing: { factId: string } };
    expect(q4.existing.factId).toBe(keep);
    expect(w.logs.find((l) => l.event === LogEvent.ScopeOvermatch)).toMatchObject({
      request_id: id,
      existingFactId: sibling,
      keptFactId: keep,
    });
  });

  it("merges the 2 related facts of 3 and leaves the unrelated one live and unchanged", async () => {
    const w = world();
    const keep = await w.seed({ header: "Creeper damage", content: "Creepers do 10 damage." });
    await w.seedEdit(keep, { header: "Creeper damage", content: "Creepers do 11 damage." });
    const related = await w.seed({ header: "Creeper explosion damage", content: "Creepers do 12 damage." });
    const sibling = await w.seed({ header: "Creeper damage on hard", content: "Creepers do 15 damage on hard." });
    const beforeSibling = versions(w.store, sibling);
    w.q.set("q1", { matches: [keep, related, sibling] });
    w.q.set("q2", (input: { other: { factId: string } }) => ({
      stands: input.other.factId === sibling ? Q2Stands.Unrelated : Q2Stands.Kept,
      reason: "r",
    }));
    w.q.set("q4", supported({ relation: Q4Relation.Different }));
    const { r } = await w.submit("Creepers do 13 damage.", "I measured 13.");
    const res = done(r);
    expect(res.mergeSeqs).toHaveLength(1);
    expect(versions(w.store, related).at(-1)?.is_deleted).toBe(1);
    expect(versions(w.store, sibling)).toEqual(beforeSibling);
    const q3 = call(w, "q3").input as { others: { factId: string }[] };
    expect(q3.others.map((o) => o.factId)).toEqual([related]);
    expect(w.logs.filter((l) => l.event === LogEvent.ScopeOvermatch)).toHaveLength(1);
    const q4 = call(w, "q4").input as { existing: { factId: string } };
    expect(q4.existing.factId).toBe(keep);
  });

  it("lints the merged draft before the merge is written", async () => {
    const w = world();
    const a = await w.seed({ header: "Creeper damage", content: "Creepers do 10 damage." });
    await w.seedEdit(a, { header: "Creeper damage", content: "Creepers do 10 damage!" });
    const b = await w.seed({ header: "Creeper explosion damage", content: "Creepers do 12 damage." });
    w.q.set("q1", { matches: [a, b] });
    const merged = (header: string) => ({
      drafts: [{ header, content: "Creepers do 12 damage.", references: [] }],
    });
    w.q.set("q3", [merged(""), merged("Creeper damage")]);
    const { r } = await w.submit("Creepers do 12 damage.", "I measured.");
    done(r);
    const q3calls = w.q.calls.filter((c) => c.q === "q3");
    expect(q3calls).toHaveLength(2);
    expect((q3calls[1].input as { lintFailure?: string }).lintFailure).toContain("missing field");
  });
});

describe("related facts that the claim shows wrong", () => {
  it("deletes one with no references, and narrows another with the claim in references", async () => {
    const w = world();
    const cap = await w.seed({
      header: "Hostile damage cap",
      content: "No hostile mob does more than 8 damage.",
      justification: "J-cap",
    });
    const pair = await w.seed({
      header: "Creeper and zombie damage",
      content: "Creepers and zombies do 10 damage.",
      justification: "J-pair",
    });
    w.q.set(
      "q4",
      supported({
        wrongRelated: [
          { factId: cap, action: WrongRelatedAction.Delete },
          { factId: pair, action: WrongRelatedAction.Narrow },
        ],
      }),
    );
    const { id, r } = await w.submit("Creepers do 12 damage.", "I measured 12 on a creeper.");
    const res = done(r);
    expect(changesOf(w.store, id)).toHaveLength(1);

    const claimRow = w.store.db
      .prepare("SELECT fact_id, id FROM fact_versions WHERE seq = ? AND justification = ?")
      .get(res.seq, "I measured 12 on a creeper.") as { fact_id: string; id: number };
    const claimId = claimRow.fact_id;

    // delete: header and content of the prior version, the submitter's justification, no references.
    const dv = versions(w.store, cap);
    expect(dv).toHaveLength(2);
    expect(dv[1].is_deleted).toBe(1);
    expect(dv[1].content).toBe("No hostile mob does more than 8 damage.");
    expect(dv[1].justification).toBe("I measured 12 on a creeper.");
    expect(refs(w.store, dv[1].id)).toEqual([]);
    expect(dv[1].seq).toBe(res.seq);

    // narrow: Q6 draft, the wrong fact's own justification, the claim added to references.
    const nv = versions(w.store, pair);
    expect(nv).toHaveLength(2);
    expect(nv[1].content).toBe("Creepers and zombies do 10 damage. (narrowed)");
    expect(nv[1].justification).toBe("J-pair");
    expect(refs(w.store, nv[1].id)).toEqual([claimId]);
    const q6 = call(w, "q6").input as { claim: { factId: string } };
    expect(q6.claim.factId).toBe(claimId); // the pre-assigned id is the id the write used
  });

  it("ignores a wrongRelated id that is not in the related list", async () => {
    const w = world({ q4: supported({ wrongRelated: [{ factId: "01NOSUCH", action: WrongRelatedAction.Delete }] }) });
    const { r } = await w.submit("Creepers do 12 damage.", "I measured.");
    done(r);
    expect(count(w.store, "fact_versions")).toBe(1);
    expect(w.logs.some((l) => l.event === LogEvent.Judge && l.droppedWrongRelated === "01NOSUCH")).toBe(true);
  });
});

describe('dependents (technical/updates.md, "Dependents loop")', () => {
  async function chain() {
    const w = world();
    const base = await w.seed({ header: "Creeper damage", content: "Creepers do 10 damage.", justification: "J-base" });
    const dep = await w.seed({
      header: "Charged creeper",
      content: "A charged creeper kills an unarmored player in one hit.",
      justification: "J-dep",
      references: [base],
    });
    w.q.set("q1", { matches: [base] });
    w.q.set("q4", supported({ relation: Q4Relation.Different }));
    return { w, base, dep };
  }

  it("leaves a dependent that holds alone", async () => {
    const { w, dep } = await chain();
    const { r } = await w.submit("Creepers do 12 damage.", "I measured 12.");
    const res = done(r);
    expect(res.passes).toBe(1);
    expect(res.rejudged).toBe(1);
    expect(versions(w.store, dep)).toHaveLength(1);
    expect(w.q.count("q8")).toBe(1);
    expect(w.q.count("q9")).toBe(0);
    const q8 = call(w, "q8").input as {
      changed: { factId: string; before: { content: string }; after: { content: string } }[];
    };
    expect(q8.changed[0].before.content).toBe("Creepers do 10 damage.");
    expect(q8.changed[0].after.content).toBe("Creepers do 12 damage.");
  });

  it("F8: drops a reference the dependent no longer rests on, with no model call", async () => {
    const { w, base, dep } = await chain();
    w.q.set("q8", { holds: true, stillDepends: [], reason: "observed alone" });
    const { r } = await w.submit("Creepers do 12 damage.", "I measured 12.");
    const res = done(r);
    expect(w.q.count("q9")).toBe(0);
    expect(w.q.count("q7")).toBe(1);
    const v = versions(w.store, dep);
    expect(v).toHaveLength(2);
    expect(v[1].content).toBe(v[0].content);
    expect(v[1].justification).toBe("J-dep");
    expect(refs(w.store, v[1].id)).toEqual([]);
    expect(v[1].seq).toBe(res.seq); // the same sequence number as the claim
    expect(refs(w.store, v[0].id)).toEqual([base]);
  });

  it("rewrites a dependent that does not hold through Q9, with an empty justification", async () => {
    const { w, base, dep } = await chain();
    w.q.set("q8", { holds: false, stillDepends: [base], reason: "the damage changed" });
    w.q.set("q9", {
      drafts: [
        {
          header: "Charged creeper",
          content: "A charged creeper kills a player in one hit.",
          references: [base],
        },
      ],
    });
    const { id, r } = await w.submit("Creepers do 12 damage.", "I measured 12.");
    const res = done(r);
    expect(changesOf(w.store, id)).toHaveLength(1);
    const v = versions(w.store, dep);
    expect(v).toHaveLength(2);
    expect(v[1].content).toBe("A charged creeper kills a player in one hit.");
    expect(v[1].justification).toBe("");
    expect(v[1].seq).toBe(res.seq);
    expect(refs(w.store, v[1].id)).toEqual([base]);
    const q9 = call(w, "q9").input as { reason: string };
    expect(q9.reason).toBe("the damage changed");
    // Q7 ran once, for the submission; the rewrite is lint by code.
    expect(w.q.count("q7")).toBe(1);
  });

  it("follows a 2-level chain, judging the second level against the first rewrite", async () => {
    const { w, base, dep } = await chain();
    const second = await w.seed({
      header: "Charged creeper trap",
      content: "A trap with a charged creeper kills a raider.",
      justification: "J-second",
      references: [dep],
    });
    w.q.set("q8", { holds: false, stillDepends: [], reason: "changed" });
    w.q.set("q9", (i) => ({
      drafts: [
        {
          header: i.dependent.versions[0].header,
          content: `${i.dependent.versions[0].content} [rewritten]`,
          references: i.dependent.versions[0].references,
        },
      ],
    }));
    const { r } = await w.submit("Creepers do 12 damage.", "I measured 12.");
    const res = done(r);
    expect(res.passes).toBe(2);
    expect(res.rejudged).toBe(2);
    expect(versions(w.store, dep)).toHaveLength(2);
    const sv = versions(w.store, second);
    expect(sv).toHaveLength(2);
    expect(sv[1].content).toContain("[rewritten]");
    expect(sv[1].seq).toBe(res.seq);
    const q8calls = w.q.calls.filter((c) => c.q === "q8");
    expect((q8calls[1].input as { changed: { factId: string }[] }).changed.map((c) => c.factId)).toEqual([dep]);
    void base;
  });

  it("stops at a cycle in the reference graph", async () => {
    const w = world();
    const a = await w.seed({ header: "Alpha", content: "Alpha is 1." });
    const b = await w.seed({ header: "Beta", content: "Beta is 2.", references: [a] });
    await w.seedEdit(a, { header: "Alpha", content: "Alpha is 1.", references: [b] });
    w.q.set("q1", { matches: [a] });
    w.q.set("q4", supported({ relation: Q4Relation.Different }));
    w.q.set("q8", { holds: false, stillDepends: [], reason: "changed" });
    const { r } = await w.submit("Alpha is 3.", "I saw 3.");
    const res = done(r);
    expect(res.passes).toBe(1);
    expect(versions(w.store, b)).toHaveLength(2);
    expect(versions(w.store, a)).toHaveLength(3);
  });

  it("a dependent that Q9 deletes becomes a deletion version", async () => {
    const { w, base, dep } = await chain();
    w.q.set("q8", { holds: false, stillDepends: [base], reason: "subject gone" });
    w.q.set("q9", {
      drafts: [{ header: "", content: "", references: [base], isDeleted: true }],
    });
    const { r } = await w.submit("Creepers do 12 damage.", "I measured 12.");
    done(r);
    const v = versions(w.store, dep);
    expect(v[1].is_deleted).toBe(1);
    expect(v[1].content).toBe("A charged creeper kills an unarmored player in one hit.");
    expect(refs(w.store, v[1].id)).toEqual([]);
  });
});

describe("lint (step 6)", () => {
  it("a second failure of the code lint fails the attempt and writes nothing", async () => {
    const bad = {
      drafts: [{ header: "Creeper damage", content: "Creepers do 10 damage.", references: ["01MISSING"] }],
    };
    const w = world({ q5: bad });
    const { id, r } = await w.submit("Creepers do 10 damage.", "I saw it.");
    expect(r.status).toBe(RunOnceStatus.Queued);
    expect(r.status === RunOnceStatus.Queued && r.error).toContain("draft failed lint twice");
    expect(w.q.count("q5")).toBe(2);
    expect(count(w.store, "fact_versions")).toBe(0);
    expect(count(w.store, "changes")).toBe(0);
    const row = must(getRequest(w.store, id));
    expect(row.status).toBe(RequestStatus.Queued);
    expect(row.attempts).toBe(1);
  });

  it("the code checks a reference to a fact that does not exist, and the retry fixes it", async () => {
    const good = { drafts: [{ header: "Creeper damage", content: "Creepers do 10 damage.", references: [] }] };
    const bad = {
      drafts: [{ header: "Creeper damage", content: "Creepers do 10 damage.", references: ["01MISSING"] }],
    };
    const w = world({ q5: [bad, good] });
    const { r } = await w.submit("Creepers do 10 damage.", "I saw it.");
    done(r);
    expect(w.q.count("q5")).toBe(2);
    expect(w.q.count("q7")).toBe(1); // the submission check at step 1; the lint calls no model
    expect((w.q.calls.filter((c) => c.q === "q5")[1].input as { lintFailure?: string }).lintFailure).toContain(
      "01MISSING",
    );
  });

  it("the code checks a reference to a fact that does not exist", async () => {
    const bad = { drafts: [{ header: "H", content: "C.", references: ["01MISSING"] }] };
    const w = world({ q5: bad });
    const { r } = await w.submit("Creepers do 10 damage.", "I saw it.");
    expect(r.status).toBe(RunOnceStatus.Queued);
    expect(r.status === RunOnceStatus.Queued && r.error).toContain("01MISSING");
  });

  it("a missing field is a lint failure", async () => {
    const bad = { drafts: [{ header: "H", content: "C." }] } as never;
    const good = { drafts: [{ header: "H", content: "C.", references: [] }] };
    const w = world({ q5: [bad, good] });
    const { r } = await w.submit("Creepers do 10 damage.", "I saw it.");
    done(r);
    expect((w.q.calls.filter((c) => c.q === "q5")[1].input as { lintFailure?: string }).lintFailure).toContain(
      "missing field",
    );
  });

  it("Q5 returning 2 drafts fails the attempt: the pipeline no longer splits", async () => {
    const two = {
      drafts: [
        { header: "A", content: "A holds.", references: [] },
        { header: "B", content: "B holds.", references: [] },
      ],
    };
    const w = world({ q5: two });
    const { r } = await w.submit("A and B hold.", "I saw it.");
    expect(r.status).toBe(RunOnceStatus.Queued);
    expect(r.status === RunOnceStatus.Queued && r.error).toContain("expected one draft");
  });

  it("F18, the guard in this layer: a Q4 rejection without a reason fails the attempt", async () => {
    const w = world({ q4: { supported: false, wrongRelated: [], reason: "x" } });
    const { r } = await w.submit("Creepers do 10 damage.", "I saw it.");
    expect(r.status).toBe(RunOnceStatus.Queued);
    expect(r.status === RunOnceStatus.Queued && r.error).toContain("rejectReason");
  });
});

describe("the submission check (step 1)", () => {
  const gatherCalls = ["q1", "q2", "q3", "q4", "q5", "q6", "q8", "q9", "q10"] as const;

  it("F22: a compound submission ends as rejected compound with Q7's reason, and nothing else runs", async () => {
    const w = world({
      q7: { oneClaim: false, claims: [], support: SupportKind.Observation, reason: "Two claims: hostile and night." },
    });
    const { id, r } = await w.submit("Skeletons are hostile and spawn at night.", "I met them after dark.");
    const res = done(r);
    expect(res.outcome).toBe(ProcessOutcome.Rejected);
    expect(w.q.count("q7")).toBe(1);
    for (const q of gatherCalls) expect(w.q.count(q), q).toBe(0);
    const ch = changesOf(w.store, id);
    expect(ch).toHaveLength(1);
    expect(ch[0].outcome).toBe(ChangeOutcome.Rejected);
    expect(ch[0].reject_reason).toBe(RejectReason.Compound);
    expect(count(w.store, "fact_versions")).toBe(0);
    const row = must(getRequest(w.store, id));
    expect(row.status).toBe(RequestStatus.Done);
    expect(row.attempts).toBe(0);
    expect(row.error).toBe("Two claims: hostile and night.");
  });

  it("a belief ends as rejected unsupported with Q7's reason, on the first attempt", async () => {
    const w = world({
      q7: { oneClaim: true, claims: [], support: SupportKind.Belief, reason: "An opinion, not an observation." },
    });
    const { id, r } = await w.submit("Spiders do 15 damage.", "I think so.");
    done(r);
    for (const q of gatherCalls) expect(w.q.count(q), q).toBe(0);
    const ch = changesOf(w.store, id);
    expect(ch).toHaveLength(1);
    expect(ch[0].outcome).toBe(ChangeOutcome.Rejected);
    expect(ch[0].reject_reason).toBe(RejectReason.Unsupported);
    const row = must(getRequest(w.store, id));
    expect(row.status).toBe(RequestStatus.Done);
    expect(row.attempts).toBe(0);
    expect(row.error).toBe("An opinion, not an observation.");
  });

  it.each([SupportKind.Observation, SupportKind.Report])("a %s lets the pipeline continue", async (support) => {
    const w = world({ q7: { oneClaim: true, claims: [], support, reason: "ok" } });
    const { id, r } = await w.submit("Creepers do 10 damage.", "I saw it.");
    const res = done(r);
    expect(res.outcome).toBe(ProcessOutcome.Accepted);
    expect(w.q.count("q7")).toBe(1);
    expect(w.q.count("q4")).toBe(1);
    expect(must(getRequest(w.store, id)).error).toBeNull();
    expect(call(w, "q7").input).toEqual({ change: "Creepers do 10 damage.", justification: "I saw it." });
  });

  it("a lookupRepair skips Q7", async () => {
    const w = world({ q7: { oneClaim: false, claims: [], support: SupportKind.Belief, reason: "never read" } });
    const id = await w.seed({ header: "Skeleton health", content: "A skeleton has 20 health." });
    enqueueRequest(w.store, { kind: RequestKind.LookupRepair, targets: [id] });
    await w.run();
    expect(w.q.count("q7")).toBe(0);
  });
});

describe("the prior query check (step 9)", () => {
  /**
   * 12 decoys share both query words, so the new fact falls below the cap of 10.
   *
   * @param w The test world to seed.
   */
  async function decoys(w: ReturnType<typeof world>) {
    for (let i = 0; i < 12; i++) {
      await w.seed({ header: `skellie health note ${i}`, content: `skellie health value ${i}` });
    }
  }

  it("enqueues a lookupRepair when the search misses the new fact", async () => {
    const w = world();
    await decoys(w);
    const { r } = await w.submit("Skeletons have 20 health.", "I counted.", { priorQuery: "skellie health" });
    const res = done(r);
    expect(res.repairRequestId).toBeDefined();
    const row = must(getRequest(w.store, must(res.repairRequestId)));
    expect(row.kind).toBe(RequestKind.LookupRepair);
    expect(row.status).toBe(RequestStatus.Queued);
    expect(row.searchId).not.toBeNull();
    expect(getSearchQuery(w.store, must(row.searchId))).toBe("skellie health");
    const newId = (
      w.store.db.prepare("SELECT fact_id FROM fact_versions WHERE seq = ?").get(res.seq) as { fact_id: string }
    ).fact_id;
    expect(row.targets).toEqual([newId]);
  });

  it("the lookupRepair carries the searchId of its submission", async () => {
    const w = world();
    await decoys(w);
    const { searchId } = await searchAndLog(w.store, "skellie health", { strict: true });
    const id = w.enqueue("Skeletons have 20 health.", "I counted.", { searchId });
    const res = done(await w.run());
    const row = must(getRequest(w.store, must(res.repairRequestId)));
    expect(row.kind).toBe(RequestKind.LookupRepair);
    expect(row.searchId).toBe(searchId);
    expect(must(getRequest(w.store, id)).searchId).toBe(searchId);
  });

  it("skips the step for a submission with no searchId", async () => {
    const w = world();
    await decoys(w);
    const { r } = await w.submit("Skeletons have 20 health.", "I counted.");
    expect(done(r).repairRequestId).toBeUndefined();
    expect(count(w.store, "change_requests", `kind = '${RequestKind.LookupRepair}'`)).toBe(0);
  });

  it("a lookupRepair whose search is gone skips", async () => {
    const w = world();
    const id = await w.seed({ header: "Skeleton health", content: "Skeletons have 20 health." });
    // The tool never stores an unknown searchId; the row is made with the foreign keys off to reach the guard.
    w.store.db.pragma("foreign_keys = OFF");
    enqueueRequest(w.store, { kind: RequestKind.LookupRepair, targets: [id], searchId: "gone" });
    w.store.db.pragma("foreign_keys = ON");
    expect(done(await w.run()).outcome).toBe(ProcessOutcome.Skipped);
    expect(w.q.count("q10")).toBe(0);
  });

  it("a lookupRepair with no searchId skips", async () => {
    const w = world();
    const id = await w.seed({ header: "Skeleton health", content: "Skeletons have 20 health." });
    enqueueRequest(w.store, { kind: RequestKind.LookupRepair, targets: [id] });
    expect(done(await w.run()).outcome).toBe(ProcessOutcome.Skipped);
    expect(w.q.count("q10")).toBe(0);
  });

  it("enqueues nothing when the search returns the fact", async () => {
    const w = world();
    const { r } = await w.submit("Skeletons have 20 health.", "I counted.", {
      priorQuery: "Skeletons have 20 health.",
    });
    expect(done(r).repairRequestId).toBeUndefined();
    expect(count(w.store, "change_requests", `kind = '${RequestKind.LookupRepair}'`)).toBe(0);
  });

  it("checks a duplicate against duplicateOf", async () => {
    const w = world();
    await decoys(w);
    const id = await w.seed({ header: "Skeleton health", content: "Skeletons have 20 health." });
    w.q.set("q1", { matches: [id] });
    w.q.set("q4", supported({ relation: Q4Relation.Same }));
    const { r } = await w.submit("Skeletons have 20 health.", "I counted.", { priorQuery: "skellie health" });
    const res = done(r);
    expect(res.outcome).toBe(ProcessOutcome.Duplicate);
    const row = must(getRequest(w.store, must(res.repairRequestId)));
    expect(row.targets).toEqual([id]);
  });

  it("does not run for a rejection", async () => {
    const w = world({ q4: supported({ supported: false, rejectReason: RejectReason.Unsupported }) });
    await decoys(w);
    const { r } = await w.submit("Skeletons have 20 health.", "I guess.", { priorQuery: "skellie health" });
    expect(done(r).repairRequestId).toBeUndefined();
  });

  it("runs the lookupRepair: Q10 writes the equivalence fact with an empty justification and the target in references", async () => {
    const w = world();
    await decoys(w);
    const first = await w.submit("Skeletons have 20 health.", "I counted.", { priorQuery: "skellie health" });
    const repairId = must(done(first.r).repairRequestId);
    const targetId = must(getRequest(w.store, repairId)).targets[0];

    const second = await w.run();
    const res = done(second);
    expect(res.outcome).toBe(ProcessOutcome.Accepted);
    expect(w.q.count("q10")).toBe(1);
    expect(w.q.count("q1")).toBe(1); // only the submission ran Q1
    expect(w.q.count("q4")).toBe(1);
    const eq = w.store.db.prepare("SELECT * FROM fact_versions WHERE seq = ?").get(res.seq) as VersionRow;
    expect(eq.justification).toBe("");
    expect(eq.header).toBe("skellie health");
    expect(refs(w.store, eq.id)).toEqual([targetId]);
    expect(changesOf(w.store, repairId)).toHaveLength(1);
    expect(must(getRequest(w.store, repairId)).status).toBe(RequestStatus.Done);
    const q10 = call(w, "q10").input as { priorQuery: string; results: unknown[] };
    expect(q10.priorQuery).toBe("skellie health");
    expect(q10.results.length).toBeGreaterThan(0);
    // The repair found its way: no third request.
    expect(count(w.store, "change_requests", `kind = '${RequestKind.LookupRepair}'`)).toBe(1);
  });

  it("a lookupRepair that still misses logs it and stops", async () => {
    const w = world();
    await decoys(w);
    const first = await w.submit("Skeletons have 20 health.", "I counted.", { priorQuery: "skellie health" });
    done(first.r);
    w.q.set("q10", {
      drafts: [{ header: "Unrelated note", content: "Nothing to see here.", references: [] }],
    });
    const second = await w.run();
    done(second);
    expect(w.logs.some((l) => l.event === LogEvent.PriorQuery && String(l.result).startsWith("still misses"))).toBe(
      true,
    );
    expect(count(w.store, "change_requests", `kind = '${RequestKind.LookupRepair}'`)).toBe(1);
    expect(count(w.store, "change_requests", "status = 'queued'")).toBe(0);
  });

  it("a lookupRepair skips when the target is deleted, or the search already returns the fact", async () => {
    const w = world();
    const id = await w.seed({ header: "Skeleton health", content: "Skeletons have 20 health." });
    const { searchId: same } = await searchAndLog(w.store, "Skeleton health", { strict: true });
    enqueueRequest(w.store, { kind: RequestKind.LookupRepair, targets: [id], searchId: same });
    const a = done(await w.run());
    expect(a.outcome).toBe(ProcessOutcome.Skipped);
    expect(w.q.count("q10")).toBe(0);

    await w.seedDelete(id);
    const { searchId: other } = await searchAndLog(w.store, "zzz", { strict: true });
    enqueueRequest(w.store, { kind: RequestKind.LookupRepair, targets: [id], searchId: other });
    const b = done(await w.run());
    expect(b.outcome).toBe(ProcessOutcome.Skipped);
  });
});

describe("orchestrator changes", () => {
  it("merge: a dependent of a merged-away fact references the kept fact, with no model call", async () => {
    const w = world();
    const keep = await w.seed({ header: "Creeper damage", content: "Creepers do 10 damage." });
    await w.seedEdit(keep, { header: "Creeper damage", content: "Creepers do 10 damage!" });
    const other = await w.seed({ header: "Creeper explosion damage", content: "Creepers do 12 damage." });
    const dep = await w.seed({
      header: "Charged creeper",
      content: "A charged creeper one-shots a player.",
      justification: "J-dep",
      references: [other],
    });
    w.q.set("q1", { matches: [keep, other] });
    w.q.set("q4", supported({ relation: Q4Relation.Different }));
    const { id, r } = await w.submit("Creepers do 13 damage.", "I measured 13.");
    done(r);
    const mergeSeq = changesOf(w.store, id)[0].seq;
    const v = versions(w.store, dep);
    expect(v).toHaveLength(2);
    expect(v[1].seq).toBe(mergeSeq);
    expect(v[1].content).toBe(v[0].content);
    expect(v[1].justification).toBe("J-dep");
    expect(refs(w.store, v[1].id)).toEqual([keep]);
    expect(w.q.count("q7")).toBe(1);
  });

  it("F8 draft: its own dependents are not collected in the next pass", async () => {
    const w = world();
    const base = await w.seed({ header: "Creeper damage", content: "Creepers do 10 damage." });
    const dep = await w.seed({
      header: "Charged creeper",
      content: "A charged creeper one-shots.",
      references: [base],
    });
    await w.seed({ header: "Charged trap", content: "A trap with a charged creeper works.", references: [dep] });
    w.q.set("q1", { matches: [base] });
    w.q.set("q4", supported({ relation: Q4Relation.Different }));
    w.q.set("q8", { holds: true, stillDepends: [], reason: "observed alone" });
    const { r } = await w.submit("Creepers do 12 damage.", "I measured 12.");
    const res = done(r);
    expect(versions(w.store, dep)).toHaveLength(2);
    expect(w.q.count("q8")).toBe(1);
    expect(res.passes).toBe(1);
  });
});

describe("split of a compound submission", () => {
  const claims = ["Skeletons are hostile.", "Skeletons spawn at night."];

  it("a crash between the split commit and the done write does not split again", async () => {
    const w = world({
      q7: { oneClaim: false, claims, support: SupportKind.Observation, reason: "Two claims." },
    });
    const { id, r } = await w.submit("Skeletons are hostile and spawn at night.", "I saw them at night.");
    const first = done(r);
    expect(first.outcome).toBe(ProcessOutcome.Split);
    expect(first.childIds).toHaveLength(2);

    // The crash: the split is committed, the row is back to queued.
    w.store.db
      .prepare("UPDATE change_requests SET status = ?, finished_at = NULL WHERE id = ?")
      .run(RequestStatus.Queued, id);
    const second = done(await w.run());
    expect(second.outcome).toBe(ProcessOutcome.Split);
    expect(second.childIds).toEqual(first.childIds);
    expect(second.seq).toBe(first.seq);
    expect(must(getRequest(w.store, id)).status).toBe(RequestStatus.Done);
    expect(count(w.store, "change_requests", "parent_id IS NOT NULL")).toBe(2);
    expect(changesOf(w.store, id)).toHaveLength(1);
    expect(w.q.count("q7")).toBe(1);
  });

  it("a belief is unsupported, whatever the claims", async () => {
    const w = world({ q7: { oneClaim: false, claims, support: SupportKind.Belief, reason: "An opinion." } });
    const { id, r } = await w.submit("Skeletons are hostile and spawn at night.", "I think so.");
    done(r);
    expect(changesOf(w.store, id)[0].reject_reason).toBe(RejectReason.Unsupported);
  });
});
