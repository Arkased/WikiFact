import { describe, expect, it } from "vitest";
import { RequestKind, RequestStatus } from "../../domain/enums.js";
import { T0, accepted, draft, makeFileStore as makeStore } from "../../../__tests__/helpers/store.js";
import {
  applyChange,
  closeStore,
  enqueueRequest,
  highestChangeSeq,
  openOverlay,
  promoteStaging,
  recordSearch,
  resetStaging,
  takeRequest,
  type Store,
} from "../index.js";

/**
 * Starts a batch on a live store: empties the staging tables and opens the overlay.
 *
 * @param live - the live store, on a database file
 * @returns the overlay store, the handle a request runs on, and the start seq of the batch
 * @sideEffects resets the staging tables; opens a connection
 */
function startBatch(live: Store): { overlay: Store; target: Store; start: number } {
  resetStaging(live);
  const overlay = openOverlay(live);
  return { overlay, target: { ...live, stageTo: overlay }, start: highestChangeSeq(live) };
}

describe("the prior query checks of a promotion", () => {
  it("queues one lookupRepair request for each check, in the promotion", async () => {
    const live = makeStore();
    const req = enqueueRequest(live, { change: "c", justification: "j" }, T0);
    takeRequest(live, req, T0 + 1);
    recordSearch(live, { id: "s1", sessionId: null, query: "q", at: T0, durationMs: 1, results: [] });
    const { overlay, target, start } = startBatch(live);
    const res = await applyChange(target, req, accepted([draft({ header: "Staged", content: "Only staged" })]), {
      now: T0 + 2,
    });
    const [fact = ""] = res.factIds;
    expect(live.db.prepare("SELECT COUNT(*) AS n FROM change_requests").pluck().get()).toBe(1);
    promoteStaging(live, {
      startSeq: start,
      done: [{ id: req }],
      priorChecks: [{ searchId: "s1", factId: fact }],
      now: T0 + 3,
    });
    const queued = live.db
      .prepare("SELECT kind, status, targets FROM change_requests WHERE kind = ?")
      .all(RequestKind.LookupRepair);
    expect(queued).toEqual([
      { kind: RequestKind.LookupRepair, status: RequestStatus.Queued, targets: JSON.stringify([fact]) },
    ]);
    closeStore(overlay);
    closeStore(live);
  });
});

describe("the staging tables", () => {
  it("are derived from the live tables: resetStaging recreates them with the live columns, without foreign keys", () => {
    const live = makeStore();
    resetStaging(live);
    const cols = (t: string): string[] =>
      (live.db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    for (const t of ["facts", "changes", "fact_versions", "change_requests"]) {
      expect(cols(`stg_${t}`)).toEqual(cols(t));
    }
    const sql = (t: string): string =>
      (live.db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(t) as { sql: string }).sql;
    expect(sql("stg_change_requests")).not.toMatch(/REFERENCES/i);
    expect(sql("stg_changes")).toMatch(/AUTOINCREMENT/i);
    closeStore(live);
  });

  it("follow a migration of a live table: a new column reaches the staging table, the overlay and the promoted row", async () => {
    const live = makeStore();
    live.db.exec("ALTER TABLE facts ADD COLUMN note TEXT NOT NULL DEFAULT 'migrated'");
    const { overlay, target, start } = startBatch(live);
    const req = enqueueRequest(live, { change: "c", justification: "j" }, T0);
    takeRequest(live, req, T0 + 1);
    const res = await applyChange(target, req, accepted([draft({ header: "Staged", content: "Only staged" })]), {
      now: T0 + 2,
    });
    const [fact = ""] = res.factIds;
    const noteOf = (store: Store, table: string): unknown =>
      store.db.prepare(`SELECT note FROM ${table} WHERE id = ?`).pluck().get(fact);
    expect(noteOf(live, "stg_facts")).toBe("migrated");
    expect(noteOf(overlay, "facts")).toBe("migrated");
    expect(noteOf(live, "facts")).toBeUndefined();
    promoteStaging(live, { startSeq: start, done: [{ id: req }], priorChecks: [], now: T0 + 3 });
    expect(noteOf(live, "facts")).toBe("migrated");
    closeStore(overlay);
    closeStore(live);
  });

  it("have no foreign key when the live table declares one at table level, with no column list, or deferrable", () => {
    const live = makeStore();
    live.db.exec(`
      DROP TABLE retrievals;
      CREATE TABLE retrievals (
        fact_version_id  INTEGER NOT NULL,
        at               INTEGER NOT NULL,
        ref              TEXT,
        FOREIGN KEY (fact_version_id) REFERENCES fact_versions DEFERRABLE INITIALLY DEFERRED,
        FOREIGN KEY (ref) REFERENCES search_results MATCH SIMPLE
      );
    `);
    resetStaging(live);
    expect(live.db.pragma("foreign_key_list(retrievals)")).toHaveLength(2);
    expect(live.db.pragma("foreign_key_list(stg_retrievals)")).toEqual([]);
    expect(() =>
      live.db.prepare("INSERT INTO stg_retrievals (fact_version_id, at, ref) VALUES (999, 1, 'none')").run(),
    ).not.toThrow();
    closeStore(live);
  });
});
