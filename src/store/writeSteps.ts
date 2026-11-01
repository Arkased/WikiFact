import type Database from "better-sqlite3";
import { ChangeOutcome, RetrievalKind } from "../domain/enums.js";
import { enqueueRequest, newId } from "./queue.js";
import { parseTargets } from "./targets.js";
import type { ChangeSet, FactDraft, IndexedVersion, Store } from "./types/index.js";
import { writeNames } from "./writeNames.js";

// The writers of the steps of the write transaction (technical/updates.md, "Write transaction"). `write.ts` runs them in order.

/** A change splits when Q7 lists at least this many claims (technical/submit.md, "Split of a compound submission"). */
export const MIN_CLAIMS_TO_SPLIT = 2;

/**
 * technical/submit.md, "Split of a compound submission". Queues one child submission per claim of a split change, with the
 * justification, the targets, the search id and the session of the parent, so that a crash cannot leave a split parent without its
 * children. Runs inside the caller's transaction.
 *
 * @param store - the open store
 * @param requestId - the split request
 * @param cs - the change set
 * @param now - the clock, in ms since the epoch
 * @returns the ids of the child requests, in claim order; empty unless the change is a split
 * @throws {Error} when the write is invalid; the caller rolls back
 * @sideEffects writes rows inside the open transaction
 */
export function writeChildren(store: Store, requestId: string, cs: ChangeSet, now: number): string[] {
  if (cs.outcome !== ChangeOutcome.Split) return [];
  const parent = store.db
    .prepare("SELECT targets, justification, search_id, parent_id, session_id FROM change_requests WHERE id = ?")
    .get(requestId) as
    | {
        targets: string;
        justification: string | null;
        search_id: string | null;
        parent_id: string | null;
        session_id: string | null;
      }
    | undefined;
  if (!parent) throw new Error(`unknown request ${requestId}`);
  if (parent.parent_id !== null) throw new Error(`request ${requestId} is a child and is never split again`);
  return (cs.claims ?? []).map((claim) =>
    enqueueRequest(
      store,
      {
        change: claim,
        justification: parent.justification ?? "",
        targets: parseTargets(parent.targets),
        ...(parent.search_id === null ? {} : { searchId: parent.search_id }),
        parentId: requestId,
        ...(parent.session_id === null ? {} : { sessionId: parent.session_id }),
      },
      now,
    ),
  );
}

/**
 * Step 3. Inserts the `changes` row and, for a duplicate of a live fact, the confirm retrieval on the duplicated fact.
 * Runs inside the caller's transaction.
 *
 * @param store - the store the change goes to (the overlay store of a batch writes the staging tables), in a transaction
 * @param requestId - the request this change answers
 * @param cs - the change set
 * @param now - the clock, in ms since the epoch
 * @returns the seq of the new `changes` row
 * @throws {Error} when the write is invalid; the caller rolls back
 * @sideEffects writes rows inside the open transaction
 */
export function writeChangeRow(store: Store, requestId: string, cs: ChangeSet, now: number): number {
  const { db } = store;
  const W = writeNames(store);
  const seq = Number(
    db
      .prepare(
        `INSERT INTO ${W.changes}(request_id, outcome, reject_reason, summary, created_at, duplicate_of) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        requestId,
        cs.outcome,
        cs.rejectReason ?? null,
        cs.summary,
        now,
        cs.outcome === ChangeOutcome.Duplicate ? (cs.duplicateOf ?? null) : null,
      ).lastInsertRowid,
  );
  if (cs.outcome === ChangeOutcome.Duplicate) {
    const target = cs.duplicateOf;
    if (target === undefined) throw new Error("a duplicate change needs duplicateOf");
    const cur = db.prepare("SELECT id, is_deleted FROM current_fact_versions WHERE fact_id = ?").get(target) as
      { id: number; is_deleted: number } | undefined;
    if (!cur) throw new Error(`duplicateOf ${target} does not exist`);
    // A deleted fact never gets a confirm: its confidence is 0 whatever its events.
    if (!cur.is_deleted) {
      db.prepare(`INSERT INTO ${W.retrievals}(fact_version_id, at, kind, weight) VALUES (?, ?, ?, 1)`).run(
        cur.id,
        now,
        RetrievalKind.Confirm,
      );
    }
  }
  return seq;
}

/**
 * Step 5. Inserts every `facts` row first, so that a reference may name a fact drafted in this change set,
 * then one version per draft with its references. Runs inside the caller's transaction.
 *
 * @param store - the store the change goes to, in a transaction
 * @param cs - the change set
 * @param at - the seq of the change and the clock
 * @param at.seq - the seq of the change
 * @param at.now - the clock, in ms since the epoch
 * @returns the fact ids, the version ids and the versions as the index hook sees them, in draft order
 * @throws {Error} when the write is invalid; the caller rolls back
 * @sideEffects writes rows inside the open transaction
 */
export function writeFacts(
  store: Store,
  cs: ChangeSet,
  at: { seq: number; now: number },
): { factIds: string[]; versionIds: number[]; indexVersions: IndexedVersion[] } {
  const { seq, now } = at;
  const { db } = store;
  const W = writeNames(store);
  const seen = new Set<string>();
  const factIds = cs.facts.map((d) => {
    const id = d.factId ?? newId();
    if (seen.has(id)) throw new Error(`fact ${id} appears twice in one change set`);
    seen.add(id);
    const exists = db.prepare("SELECT 1 FROM facts WHERE id = ?").get(id);
    if (!exists) {
      if (d.isDeleted) throw new Error(`cannot delete fact ${id}: it does not exist`);
      db.prepare(`INSERT INTO ${W.facts}(id, created_at) VALUES (?, ?)`).run(id, now);
    }
    return id;
  });

  const insertVersion = db.prepare(
    `INSERT INTO ${W.fact_versions}(fact_id, seq, header, content, justification, change_reasoning, is_deleted, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const factExists = db.prepare("SELECT 1 FROM facts WHERE id = ?");
  const insertRef = db.prepare(
    `INSERT OR IGNORE INTO ${W.fact_version_refs}(fact_version_id, ref_fact_id) VALUES (?, ?)`,
  );

  const versionIds: number[] = [];
  const indexVersions: IndexedVersion[] = [];
  cs.facts.forEach((d, i) => {
    const factId = factIds[i];
    if (factId === undefined) throw new Error(`no fact id for draft ${i}`);
    const isDeleted = d.isDeleted === true;
    const info = insertVersion.run(
      factId,
      seq,
      d.header,
      d.content,
      d.justification,
      cs.changeReasoning,
      isDeleted ? 1 : 0,
      now,
    );
    const versionId = Number(info.lastInsertRowid);
    versionIds.push(versionId);
    for (const ref of d.references) {
      if (!factExists.get(ref)) throw new Error(`reference ${ref} does not exist (fact ${factId})`);
      insertRef.run(versionId, ref);
    }
    indexVersions.push({ versionId, factId, seq, header: d.header, content: d.content, isDeleted });
  });
  return { factIds, versionIds, indexVersions };
}

/**
 * technical/updates.md, "Write transaction", step 2: checks the change set before anything is written.
 *
 * @param cs - the change set
 * @throws {Error} when the write is invalid; the caller rolls back
 * @sideEffects writes rows inside the open transaction
 */
export function validateShape(cs: ChangeSet): void {
  if (cs.outcome === ChangeOutcome.Rejected) {
    if (!cs.rejectReason) throw new Error("a rejected change needs rejectReason");
  } else if (cs.rejectReason) {
    throw new Error("rejectReason is only for a rejected change");
  }
  if (cs.outcome === ChangeOutcome.Duplicate) {
    if (!cs.duplicateOf) throw new Error("a duplicate change needs duplicateOf");
  } else if (cs.duplicateOf) {
    throw new Error("duplicateOf is only for a duplicate change");
  }
  if (cs.outcome === ChangeOutcome.Split) {
    if (!cs.claims || cs.claims.length < MIN_CLAIMS_TO_SPLIT) throw new Error("a split change needs at least 2 claims");
  } else if (cs.claims) {
    throw new Error("claims are only for a split change");
  }
  if (cs.outcome !== ChangeOutcome.Accepted && cs.facts.length > 0) {
    throw new Error(`a ${cs.outcome} change has no facts`);
  }
  if (cs.summary.trim() === "") throw new Error("summary must not be empty");
  for (const d of cs.facts) {
    if (!d.isDeleted && (d.header.trim() === "" || d.content.trim() === "")) {
      throw new Error("header and content must not be empty");
    }
    // technical/updates.md, "Write transaction", step 5: a deletion version holds no references (design/data-model.md, "References").
    if (d.isDeleted && d.references.length > 0) {
      throw new Error(`a deletion holds no references (fact ${d.factId ?? "new"})`);
    }
  }
}

/**
 * technical/storage.md, "Index tables": a deletion copies `header` and `content` from the version before it. A deletion
 * draft with an empty header or content gets them from the current version.
 *
 * @param db - the open database
 * @param cs - the change set
 * @returns the same change set when no deletion draft needs filling, else a copy with the drafts filled
 * @throws {Error} when a deletion has no `factId` or names a fact that does not exist
 * @sideEffects none (reads)
 */
export function normalizeDeletions(db: Database.Database, cs: ChangeSet): ChangeSet {
  if (!cs.facts.some((d) => d.isDeleted && (d.header === "" || d.content === ""))) return cs;
  const facts: FactDraft[] = cs.facts.map((d) => {
    if (!d.isDeleted || (d.header !== "" && d.content !== "")) return d;
    if (d.factId === undefined) throw new Error("a deletion needs a factId");
    const cur = db.prepare("SELECT header, content FROM current_fact_versions WHERE fact_id = ?").get(d.factId) as
      { header: string; content: string } | undefined;
    if (!cur) throw new Error(`cannot delete fact ${d.factId}: it does not exist`);
    return { ...d, header: d.header || cur.header, content: d.content || cur.content };
  });
  return { ...cs, facts };
}
