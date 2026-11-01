import { describe, expect, it } from "vitest";
import { MetaKey } from "../../domain/index.js";
import { accepted, draft, makeStore, write } from "../../../__tests__/helpers/store.js";
import { anonymizeStore, listTextCells, rebuildFullText, setQueuePause, readQueuePause } from "../index.js";

const ftsHits = (store: ReturnType<typeof makeStore>, word: string): number =>
  (
    store.db.prepare("SELECT count(*) AS n FROM fact_versions_fts WHERE fact_versions_fts MATCH ?").get(word) as {
      n: number;
    }
  ).n;

describe("anonymizeStore", () => {
  it("rewrites the free text, deletes the pause note, and leaves the full-text index stale until it is rebuilt", () => {
    const store = makeStore();
    write(store, accepted([draft({ content: "Alpha secret text." })]), 1);
    setQueuePause(store, "note", 2);

    const changed = anonymizeStore(store, (t) => t.replaceAll("secret", "plain"));

    expect(changed).toBeGreaterThan(0);
    expect(readQueuePause(store)).toBeUndefined();
    expect((store.db.prepare("SELECT content FROM fact_versions").get() as { content: string }).content).toBe(
      "Alpha plain text.",
    );
    expect(ftsHits(store, "secret")).toBe(1);
    rebuildFullText(store);
    expect(ftsHits(store, "secret")).toBe(0);
    expect(ftsHits(store, "plain")).toBe(1);
  });

  it("deletes the use rows and clears the link of a change request to its session and search", () => {
    const store = makeStore();
    store.db.exec(`
      INSERT INTO sessions(id, started_at, last_call_at) VALUES ('s', 1, 1);
      INSERT INTO searches(id, session_id, query, at, duration_ms, result_count) VALUES ('q', 's', 'text', 1, 1, 0);
      INSERT INTO tool_calls(at, tool, ok, duration_ms) VALUES (1, 'search', 1, 1);
    `);
    write(store, accepted([draft()]), 1);
    store.db.exec("UPDATE change_requests SET session_id = 's', search_id = 'q'");

    anonymizeStore(store, (t) => t);

    for (const table of ["sessions", "searches", "tool_calls"]) {
      expect(store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    }
    expect(store.db.prepare("SELECT session_id, search_id FROM change_requests").get()).toEqual({
      session_id: null,
      search_id: null,
    });
  });
});

describe("anonymizeStore, state of the service", () => {
  it("keeps in meta only the keys that openStore checks, and empties the staging tables", () => {
    const store = makeStore();
    write(store, accepted([draft()]), 1);
    store.db.exec(`
      INSERT INTO meta(key, value) VALUES ('worker_status', '{"note":"secret"}');
      INSERT INTO meta(key, value) VALUES ('batch_progress', '{}');
      INSERT INTO stg_fact_versions(id, fact_id, seq, header, content, justification, change_reasoning, created_at)
        VALUES (1, 'f', 1, 'secret', 'secret', 'secret', 'secret', 1);
    `);

    anonymizeStore(store, (t) => t);

    const keys = (store.db.prepare("SELECT key FROM meta ORDER BY key").all() as { key: string }[]).map((r) => r.key);
    expect(keys).toEqual([MetaKey.EmbeddingDim, MetaKey.EmbeddingModel, MetaKey.SchemaVersion].sort());
    expect(store.db.prepare("SELECT count(*) AS n FROM stg_fact_versions").get()).toEqual({ n: 0 });
  });

  it("rewrites a TEXT column that is not free text, as the scan reads every TEXT column", () => {
    const store = makeStore();
    write(store, accepted([draft()]), 1);
    store.db.exec("UPDATE changes SET duplicate_of = 'secret-id'");

    anonymizeStore(store, (t) => t.replaceAll("secret", "plain"));

    expect(store.db.prepare("SELECT duplicate_of FROM changes").get()).toEqual({ duplicate_of: "plain-id" });
  });
});

describe("listTextCells", () => {
  it("lists the text of the base tables and not the index tables", () => {
    const store = makeStore();
    write(store, accepted([draft({ content: "Findable words." })]), 1);

    const cells = listTextCells(store);

    expect(cells).toContainEqual(
      expect.objectContaining({ table: "fact_versions", column: "content", value: "Findable words." }),
    );
    expect(cells.filter((c) => c.table.startsWith("fact_versions_fts") || c.table.endsWith("_vec"))).toEqual([]);
  });
});
