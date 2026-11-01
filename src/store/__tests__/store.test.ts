import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChangeOutcome, RejectReason } from "../../domain/enums.js";
import {
  applyChange,
  closeStore,
  enqueueRequest,
  getDependents,
  getFact,
  getFactMaterial,
  openStore,
  OLDEST_SCHEMA_VERSION,
  SCHEMA_VERSION,
  recordRetrieval,
  StoreMismatchError,
  search,
  type IndexChange,
  type Store,
} from "../index.js";
import { DAY, T0, accepted, draft, makeStore, write } from "../../../__tests__/helpers/store.js";

function must<T>(x: T | null | undefined): T {
  if (x === null || x === undefined) throw new Error("expected a value");
  return x;
}

let store: Store;
beforeEach(() => {
  store = makeStore();
});
afterEach(() => closeStore(store));

const count = (table: string) => (store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe("openStore", () => {
  it("creates the tables, the view, the index tables and meta", () => {
    const names = (store.db.prepare("SELECT name FROM sqlite_master").all() as { name: string }[]).map((r) => r.name);
    for (const n of [
      "facts",
      "changes",
      "fact_versions",
      "fact_version_refs",
      "retrievals",
      "change_requests",
      "meta",
      "current_fact_versions",
      "fact_versions_fts",
      "fact_versions_vec",
      "current_vec",
    ]) {
      expect(names).toContain(n);
    }
    const meta = Object.fromEntries(
      (store.db.prepare("SELECT key, value FROM meta").all() as { key: string; value: string }[]).map((r) => [
        r.key,
        r.value,
      ]),
    );
    expect(meta.embedding_model).toBe("test-model");
    expect(meta.schema_version).toBe(String(SCHEMA_VERSION));
  });

  it("sets busy_timeout 5000", () => {
    expect(store.db.pragma("busy_timeout", { simple: true })).toBe(5000);
  });

  it("refuses to open on another embedding model (F15)", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "wikifact-"));
    const path = join(dir, "w.sqlite");
    const a = openStore(path, { embeddingModel: "m1" });
    expect(a.db.pragma("journal_mode", { simple: true })).toBe("wal");
    closeStore(a);
    expect(() => openStore(path, { embeddingModel: "m2" })).toThrow(StoreMismatchError);
    const again = openStore(path, { embeddingModel: "m1" });
    closeStore(again);
  });
});

describe("schema migrations", () => {
  const setVersion = (s: Store, v: number): void => {
    s.db.exec(`UPDATE meta SET value = '${v}' WHERE key = 'schema_version'`);
  };

  async function withDir(fn: (path: string) => void): Promise<void> {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "wikifact-"));
    fn(join(dir, "w.sqlite"));
  }

  it("refuses a store older than the oldest schema that the code migrates", async () => {
    await withDir((path) => {
      const old = openStore(path, { embeddingModel: "m" });
      setVersion(old, OLDEST_SCHEMA_VERSION - 1);
      closeStore(old);
      expect(() => openStore(path, { embeddingModel: "m" })).toThrow(/migrates from schema/);
    });
  });

  it("refuses a read connection to a store that is not migrated yet", async () => {
    await withDir((path) => {
      const old = openStore(path, { embeddingModel: "m" });
      setVersion(old, OLDEST_SCHEMA_VERSION);
      closeStore(old);
      expect(() => openStore(path, { embeddingModel: "m" }, { readonly: true })).toThrow(StoreMismatchError);
    });
  });

  it("refuses a store whose version is above the code's", async () => {
    await withDir((path) => {
      const s = openStore(path, { embeddingModel: "m" });
      setVersion(s, SCHEMA_VERSION + 1);
      closeStore(s);
      expect(() => openStore(path, { embeddingModel: "m" })).toThrow(/newer version/);
      expect(() => openStore(path, { embeddingModel: "m" }, { readonly: true })).toThrow(StoreMismatchError);
    });
  });
});

describe("version chain, sequence numbers, view", () => {
  it("numbers changes globally and keeps every version", () => {
    const a = write(store, accepted([draft()]), T0);
    const fid = a.factIds[0];
    const b = write(
      store,
      accepted([draft({ factId: fid, content: "Creepers do 12 damage.", justification: "saw 12" })]),
      T0 + 1,
    );
    const c = write(store, accepted([draft({ header: "Zombie health", content: "Zombies have 20 health." })]), T0 + 2);
    expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 3]);

    const agent = must(getFact(store, fid, { agent: true, now: T0 + 3 }));
    expect(agent.factVersions.map((v) => v.seq)).toEqual([2, 1]);
    expect(agent.factVersions[0].content).toBe("Creepers do 12 damage.");
    expect(agent.factVersions[0].changeReasoning).toBe("test reasoning");

    const consumer = must(getFact(store, fid, { now: T0 + 3 }));
    expect(consumer.current.seq).toBe(2);
    expect("factVersions" in consumer).toBe(false);
  });

  it("current_fact_versions holds the largest seq of each fact", () => {
    const a = write(store, accepted([draft()]), T0);
    write(store, accepted([draft({ factId: a.factIds[0], content: "v2" })]), T0 + 1);
    write(store, accepted([draft({ header: "Other", content: "o" })]), T0 + 2);
    const rows = store.db.prepare("SELECT fact_id, seq FROM current_fact_versions ORDER BY seq").all() as {
      fact_id: string;
      seq: number;
    }[];
    expect(rows).toEqual([
      { fact_id: a.factIds[0], seq: 2 },
      { fact_id: expect.any(String) as string, seq: 3 },
    ]);
  });

  it("two facts in one change share one seq", () => {
    const r = write(store, accepted([draft(), draft({ header: "B", content: "b" })]), T0);
    const seqs = store.db.prepare("SELECT DISTINCT seq FROM fact_versions").all();
    expect(seqs).toHaveLength(1);
    expect(r.factIds).toHaveLength(2);
    expect(count("changes")).toBe(1);
  });

  it("returns null for an unknown fact", () => {
    expect(getFact(store, "nope")).toBeNull();
  });

  it("allows a draft to pre-assign the id of a new fact, so that a reference can name it", () => {
    const r = write(
      store,
      accepted([draft({ factId: "01NEWFACT", header: "New", content: "n" }), draft({ header: "Old", content: "o" })]),
      T0,
    );
    expect(r.factIds[0]).toBe("01NEWFACT");
    const r2 = write(
      store,
      accepted([draft({ factId: r.factIds[1], header: "Old", content: "o2", references: ["01NEWFACT"] })]),
      T0 + 1,
    );
    expect(r2.seq).toBe(2);
    expect(must(getFact(store, r.factIds[1])).current.references).toEqual(["01NEWFACT"]);
  });
});

describe("deletion and revival", () => {
  it("a deletion copies header and content, and hides the fact", () => {
    const a = write(store, accepted([draft()]), T0);
    const fid = a.factIds[0];
    write(
      store,
      accepted([draft({ factId: fid, header: "", content: "", isDeleted: true, justification: "removed in 1.2" })]),
      T0 + 1,
    );
    const f = must(getFact(store, fid, { now: T0 + 2 }));
    expect(f.isDeleted).toBe(true);
    expect(f.confidence).toBe(0);
    expect(f.current.isDeleted).toBe(true);
    expect(f.current.header).toBe("Creeper damage");
    expect(f.current.content).toBe("Creepers do 10 damage.");
    expect(f.current.justification).toBe("removed in 1.2");
  });

  it("a deletion records no retrieval", () => {
    const a = write(store, accepted([draft()]), T0);
    const fid = a.factIds[0];
    expect(recordRetrieval(store, fid, { now: T0 + 1 })).toBe(true);
    write(store, accepted([draft({ factId: fid, header: "", content: "", isDeleted: true })]), T0 + 2);
    expect(recordRetrieval(store, fid, { now: T0 + 3 })).toBe(false);
    expect(count("retrievals")).toBe(1);
  });

  it("revival makes a new live version with old content and counts as an update", () => {
    const a = write(store, accepted([draft()]), T0);
    const fid = a.factIds[0];
    write(
      store,
      accepted([draft({ factId: fid, isDeleted: true, header: "", content: "", justification: "gone" })]),
      T0 + DAY,
    );
    write(store, accepted([draft({ factId: fid, justification: "back again" })]), T0 + 2 * DAY);
    const f = must(getFact(store, fid, { now: T0 + 2 * DAY }));
    expect(f.isDeleted).toBe(false);
    expect(f.current.seq).toBe(3);
    expect(f.confidence).toBeCloseTo(0.5, 10); // S = 1 at the moment of the update
  });
});

describe("dependents", () => {
  it("lists live facts whose current version references the fact", () => {
    const base = write(store, accepted([draft()]), T0).factIds[0];
    const dep = write(store, accepted([draft({ header: "Charged", content: "c", references: [base] })]), T0 + 1)
      .factIds[0];
    const dep2 = write(store, accepted([draft({ header: "Other", content: "o", references: [base] })]), T0 + 2)
      .factIds[0];
    expect(getDependents(store, base).sort()).toEqual([dep, dep2].sort());

    // a new version that drops the reference
    write(store, accepted([draft({ factId: dep2, header: "Other", content: "o", references: [] })]), T0 + 3);
    expect(getDependents(store, base)).toEqual([dep]);

    // a deleted dependent is not live
    write(store, accepted([draft({ factId: dep, isDeleted: true, header: "", content: "" })]), T0 + 4);
    expect(getDependents(store, base)).toEqual([]);
  });

  it("refuses a deletion draft that holds references, and writes nothing", async () => {
    const base = write(store, accepted([draft({ header: "Base", content: "b" })]), T0).factIds[0];
    const dep = write(store, accepted([draft({ header: "Dep", content: "d", references: [base] })]), T0 + 1).factIds[0];
    const reqId = enqueueRequest(store, { change: "c", justification: "j" }, T0 + 2);
    await expect(
      applyChange(
        store,
        reqId,
        accepted([draft({ factId: dep, isDeleted: true, header: "", content: "", references: [base] })]),
        { now: T0 + 3 },
      ),
    ).rejects.toThrow(/deletion holds no references/);
    expect(getFact(store, dep)?.isDeleted).toBe(false);
    expect(getDependents(store, base)).toEqual([dep]);
  });
});

describe("rollback", () => {
  it("a bad reference id rolls back the whole change", () => {
    const reqId = enqueueRequest(store, { change: "c", justification: "j" }, T0);
    const before = {
      changes: count("changes"),
      facts: count("facts"),
      versions: count("fact_versions"),
    };
    return expect(
      applyChange(
        store,
        reqId,
        accepted([draft(), draft({ header: "B", content: "b", references: ["01DOESNOTEXIST"] })]),
        { now: T0 },
      ),
    )
      .rejects.toThrow(/does not exist/)
      .then(() => {
        expect({
          changes: count("changes"),
          facts: count("facts"),
          versions: count("fact_versions"),
        }).toEqual(before);
        // the sequence is not consumed either: the next change is seq 1
        expect(write(store, accepted([draft()]), T0 + 1).seq).toBe(1);
      });
  });

  it("a throw in the index hook rolls back", () => {
    store.indexWriter = {
      write() {
        throw new Error("index failure");
      },
    };
    expect(() => write(store, accepted([draft()]), T0)).toThrow(/index failure/);
    expect(count("fact_versions")).toBe(0);
    expect(count("facts")).toBe(0);
  });

  it("rejects malformed outcomes", () => {
    expect(() =>
      write(store, { outcome: ChangeOutcome.Rejected, summary: "s", changeReasoning: "r", facts: [] }, T0),
    ).toThrow(/rejectReason/);
    expect(() =>
      write(store, { outcome: ChangeOutcome.Duplicate, summary: "s", changeReasoning: "r", facts: [] }, T0),
    ).toThrow(/duplicateOf/);
  });
});

describe("outcomes without facts", () => {
  it("a rejected change leaves a changes row and nothing else", () => {
    write(
      store,
      {
        outcome: ChangeOutcome.Rejected,
        rejectReason: RejectReason.Unsupported,
        summary: "no evidence",
        changeReasoning: "r",
        facts: [],
      },
      T0,
    );
    expect(count("changes")).toBe(1);
    expect(count("fact_versions")).toBe(0);
  });

  it("a duplicate of a deleted fact writes the change row and no confirm", () => {
    const fid = write(store, accepted([draft()]), T0).factIds[0];
    write(store, accepted([draft({ factId: fid, isDeleted: true, header: "", content: "" })]), T0 + 1);
    write(
      store,
      { outcome: ChangeOutcome.Duplicate, duplicateOf: fid, summary: "s", changeReasoning: "r", facts: [] },
      T0 + 2,
    );
    expect(count("changes")).toBe(3);
    expect(count("retrievals")).toBe(0);
  });
});

describe("index hook", () => {
  it("calls prepare before the transaction and write inside it, with the new rows", async () => {
    const calls: string[] = [];
    const seen: IndexChange[] = [];
    const first = write(store, accepted([draft()]), T0);
    expect(first.seq).toBe(1);
    // the async path fills in the deletion text before prepare
    const fid = first.factIds[0];
    store.indexWriter = {
      prepare(cs) {
        calls.push("prepare");
        return Promise.resolve(cs.facts.map((f) => f.header + ". " + f.content));
      },
      write(db, change, prepared) {
        calls.push("write");
        expect(db.inTransaction).toBe(true);
        expect(prepared).toEqual(["Creeper damage. Creepers do 10 damage."]);
        seen.push(change);
      },
    };
    const reqId = enqueueRequest(store, { change: "c", justification: "j" }, T0);
    await applyChange(store, reqId, accepted([draft({ factId: fid, isDeleted: true, header: "", content: "" })]), {
      now: T0 + 1,
    });
    expect(calls).toEqual(["prepare", "write"]);
    expect(must(seen[0]).versions).toEqual([
      {
        versionId: expect.any(Number) as number,
        factId: fid,
        seq: 2,
        header: "Creeper damage",
        content: "Creepers do 10 damage.",
        isDeleted: true,
      },
    ]);
  });

  it("the default writes nothing to the index tables", () => {
    write(store, accepted([draft()]), T0);
    expect(count("fact_versions_vec")).toBe(0);
    expect(count("current_vec")).toBe(0);
  });
});

describe("misc", () => {
  it("getFactMaterial strips the agent text", () => {
    const r = write(store, accepted([draft()]), T0);
    const m = must(getFactMaterial(store, r.factIds[0]));
    expect(m.versions[0]).toEqual({
      seq: 1,
      header: "Creeper damage",
      content: "Creepers do 10 damage.",
      justification: "I measured 10 damage.",
      references: [],
      isDeleted: false,
      created: T0,
    });
    expect(JSON.stringify(m)).not.toContain("changeReasoning");
  });

  it("search runs on an empty store (step 2 replaced the stub)", async () => {
    await expect(search(store, "x")).resolves.toEqual([]);
  });
});
