import { beforeAll, describe, expect, it } from "vitest";
import { ChangeOutcome, SearchHitKind } from "../../domain/enums.js";
import { setEmbedder, EMBEDDING_DIM } from "../../embed/index.js";
import { fakeEmbed } from "../../../fakes/fake-embedder.js";
import {
  applyChange,
  checkIndex,
  enqueueRequest,
  getFact,
  openStore,
  ftsQuery,
  recordRetrieval,
  reindex,
  search,
  type ChangeSet,
  type FactDraft,
  type Store,
} from "../index.js";

const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_700_000_000_000;

beforeAll(() => setEmbedder(fakeEmbed));

function makeStore(): Store {
  return openStore(":memory:", { embeddingModel: "test-model" });
}

function draft(over: Partial<FactDraft> = {}): FactDraft {
  return {
    header: "Creeper damage",
    content: "Creepers do 10 damage.",
    justification: "I measured 10 damage.",
    references: [],
    ...over,
  };
}

function must<T>(x: T | null | undefined): T {
  if (x === null || x === undefined) throw new Error("expected a value");
  return x;
}

function cs(facts: FactDraft[]): ChangeSet {
  return { outcome: ChangeOutcome.Accepted, summary: "s", changeReasoning: "r", facts };
}

async function write(store: Store, change: ChangeSet, now: number) {
  const req = enqueueRequest(store, { change: "c", justification: "j" }, now);
  return applyChange(store, req, change, { now });
}

const n = (store: Store, table: string) =>
  (store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

describe("the embedder", () => {
  it("fake vectors have 384 dimensions, are normalized and are deterministic", async () => {
    const [a, b] = await fakeEmbed(["Creeper damage", "Creeper damage"]);
    expect(a.length).toBe(EMBEDDING_DIM);
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(Math.hypot(...a)).toBeCloseTo(1, 5);
  });
});

describe("index stays in step with fact_versions", () => {
  it("counts match after applyChange, including edits and deletions", async () => {
    const store = makeStore();
    const r1 = await write(
      store,
      cs([draft(), draft({ header: "Zombie health", content: "Zombies have 20 health." })]),
      T0,
    );
    expect(checkIndex(store)).toEqual([]);
    expect(n(store, "fact_versions_vec")).toBe(2);
    expect(n(store, "current_vec")).toBe(2);

    const id = r1.factIds[0];
    await write(store, cs([draft({ factId: id, content: "Creepers do 12 damage." })]), T0 + DAY);
    expect(checkIndex(store)).toEqual([]);
    expect(n(store, "fact_versions_vec")).toBe(3);
    expect(n(store, "current_vec")).toBe(2);

    await write(
      store,
      cs([draft({ factId: id, header: "", content: "", isDeleted: true, justification: "gone" })]),
      T0 + 2 * DAY,
    );
    expect(checkIndex(store)).toEqual([]);
    expect(n(store, "current_vec")).toBe(1);
    expect(n(store, "fact_versions_vec")).toBe(4);
  });

  it("leaves no index row after a failed write", async () => {
    const store = makeStore();
    await write(store, cs([draft()]), T0);
    const before = {
      fts: n(store, "fact_versions_fts_docsize"),
      vec: n(store, "fact_versions_vec"),
      cur: n(store, "current_vec"),
    };
    const req = enqueueRequest(store, { change: "c", justification: "j" }, T0);
    await expect(
      applyChange(
        store,
        req,
        cs([
          draft({ header: "Good fact", content: "A fine claim." }),
          draft({ header: "Bad", content: "Bad ref.", references: ["nope"] }),
        ]),
        { now: T0 + 1 },
      ),
    ).rejects.toThrow(/reference/);
    expect({
      fts: n(store, "fact_versions_fts_docsize"),
      vec: n(store, "fact_versions_vec"),
      cur: n(store, "current_vec"),
    }).toEqual(before);
    expect(checkIndex(store)).toEqual([]);
  });

  it("checkIndex finds a drift after a hand edit and reindex repairs it", async () => {
    const store = makeStore();
    await write(store, cs([draft(), draft({ header: "Zombie health", content: "Zombies have 20 health." })]), T0);
    expect(checkIndex(store)).toEqual([]);

    store.db.exec("DELETE FROM fact_versions_vec WHERE fact_version_id = 1");
    store.db.exec("INSERT INTO facts(id, created_at) VALUES ('X', 1)");
    store.db
      .prepare(
        "INSERT INTO fact_versions(fact_id, seq, header, content, justification, change_reasoning, is_deleted, created_at) VALUES ('X', 1, 'h', 'c', 'j', 'r', 0, 1)",
      )
      .run();
    const diffs = checkIndex(store);
    expect(diffs.map((d) => d.table).sort()).toEqual(["current_vec", "fact_versions_fts", "fact_versions_vec"].sort());
    expect(diffs.find((d) => d.table === "fact_versions_vec")).toEqual({
      table: "fact_versions_vec",
      expected: 3,
      actual: 1,
    });

    const res = await reindex(store, fakeEmbed);
    expect(res).toEqual({ versions: 3 });
    expect(checkIndex(store)).toEqual([]);
    expect(
      store.db.prepare("SELECT rowid FROM fact_versions_fts WHERE fact_versions_fts MATCH ?").all('"zombies"').length,
    ).toBe(1);
  });
});

describe("search", () => {
  async function seeded() {
    const store = makeStore();
    const r1 = await write(
      store,
      cs([
        draft(),
        draft({ header: "Zombie health", content: "Zombies have 20 health." }),
        draft({ header: "Skeleton range", content: "Skeletons shoot arrows from 15 blocks." }),
      ]),
      T0,
    );
    const [creeper, zombie, skeleton] = r1.factIds as [string, string, string];
    // Creeper gets a second version, zombie is deleted.
    await write(store, cs([draft({ factId: creeper, content: "Creepers do 12 damage." })]), T0 + DAY);
    await write(
      store,
      cs([draft({ factId: zombie, header: "", content: "", isDeleted: true, justification: "removed" })]),
      T0 + 2 * DAY,
    );
    return { store, creeper, zombie, skeleton, now: T0 + 3 * DAY };
  }

  it("the consumer form returns live current facts only", async () => {
    const { store, creeper, zombie, skeleton, now } = await seeded();
    const hits = await search(store, "creeper damage", { now });
    const facts = hits.filter((h) => h.kind === SearchHitKind.Fact);
    expect(facts.map((f) => f.id)).toContain(creeper);
    expect(facts.map((f) => f.id)).not.toContain(zombie);
    expect(facts.filter((f) => f.id === creeper).length).toBe(1);
    expect(hits.every((h) => h.kind === SearchHitKind.Fact)).toBe(true);
    expect(hits.every((h) => !("factVersionId" in h))).toBe(true);

    const z = await search(store, "zombie health", { now });
    expect(z.some((h) => h.kind === SearchHitKind.Fact && h.id === zombie)).toBe(false);
    const sk = await search(store, "skeleton arrows", { now });
    expect(sk[0]).toMatchObject({ kind: "fact", id: skeleton, header: "Skeleton range" });
    expect((sk[0] as { confidence: number }).confidence).toBeGreaterThan(0);
  });

  it("the history form returns old and deleted versions, each with its ids", async () => {
    const { store, creeper, zombie, now } = await seeded();
    const hits = await search(store, "zombie health", { now, includeHistory: true });
    const z = hits.find((h) => h.kind === SearchHitKind.Fact && h.factId === zombie);
    expect(z).toBeDefined();
    if (z?.kind !== SearchHitKind.Fact) throw new Error("not a fact");
    expect(z.factId).toBe(zombie);
    expect(typeof z.isDeleted).toBe("boolean");
    expect(typeof z.seq).toBe("number");
    expect(typeof z.factVersionId).toBe("number");

    // The old creeper version ("10 damage") matches a query on its old content.
    const old = await search(store, "Creepers do 10 damage", { now, includeHistory: true });
    const c = old.filter((h) => h.kind === SearchHitKind.Fact && h.factId === creeper);
    expect(c.length).toBe(1);
    // The deleted fact is returned, and each hit names a real version with its seq and isDeleted.
    const del = await search(store, "zombies 20 health", { now, includeHistory: true });
    const zz = must(del.find((h) => h.kind === SearchHitKind.Fact && h.factId === zombie));
    for (const h of del) {
      if (h.kind !== SearchHitKind.Fact) continue;
      const row = store.db
        .prepare("SELECT fact_id, seq, is_deleted FROM fact_versions WHERE id = ?")
        .get(h.factVersionId) as {
        fact_id: string;
        seq: number;
        is_deleted: number;
      };
      expect(row).toEqual({ fact_id: h.factId, seq: h.seq, is_deleted: h.isDeleted ? 1 : 0 });
    }
    expect(zz.kind).toBe("fact");
    // The consumer form drops the same fact.
    expect(
      (await search(store, "zombies 20 health", { now })).some((h) => h.kind === SearchHitKind.Fact && h.id === zombie),
    ).toBe(false);
  });

  it("does not throw on -, quote, * and AND", async () => {
    const { store, now } = await seeded();
    for (const q of [
      "creeper -damage",
      'say "hello',
      "*",
      "creeper AND zombie",
      "NOT OR NEAR(",
      "-",
      '"',
      "",
      "   ",
      'a" b* -c AND',
    ]) {
      await expect(search(store, q, { now })).resolves.toBeDefined();
      await expect(search(store, q, { now, includeHistory: true })).resolves.toBeDefined();
    }
    expect(ftsQuery('a "b" -c AND')).toBe('"""b""" OR "-c"');
  });

  it("usefulness lifts a fact over an equal one", async () => {
    const store = makeStore();
    const r = await write(
      store,
      cs([
        draft({ header: "Alpha scope", content: "Alpha thing happens." }),
        draft({ header: "Alpha scope", content: "Alpha thing happens." }),
      ]),
      T0,
    );
    const now = T0 + 1000;
    const before = await search(store, "alpha thing", { now });
    const loser = before[1].kind === SearchHitKind.Fact ? before[1].id : "";
    for (let i = 0; i < 50; i++) recordRetrieval(store, loser, { now: now - 10 });
    const after = await search(store, "alpha thing", { now });
    expect(after[0]).toMatchObject({ id: loser });
    expect(getFact(store, loser, { now })).not.toBeNull();
    expect(r.factIds).toContain(loser);
  });
});

describe("current_vec: 1-bit KNN with an exact rescore (step 7)", () => {
  const blobToVec = (b: Buffer) => new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  const mob = (i: number) => draft({ header: `Mob${i} trait${i}`, content: `Mob number ${i} has trait number ${i}.` });

  it("stores the float vector in the auxiliary column and finds a fact among the nearest bit vectors", async () => {
    const store = makeStore();
    await write(store, cs(Array.from({ length: 40 }, (_, i) => mob(i))), T0);
    expect(n(store, "current_vec")).toBe(40);
    const row = store.db.prepare("SELECT fact_id, full FROM current_vec LIMIT 1").get() as {
      fact_id: string;
      full: Buffer;
    };
    const text = (
      store.db
        .prepare("SELECT header || '. ' || content AS t FROM current_fact_versions WHERE fact_id = ?")
        .get(row.fact_id) as { t: string }
    ).t;
    const [expected] = await fakeEmbed([text]);
    expect(Array.from(blobToVec(row.full))).toEqual(Array.from(expected));
    const hit = store.db
      .prepare("SELECT fact_id FROM current_vec WHERE embedding MATCH vec_quantize_binary(?) AND k = 10")
      .all(Buffer.from(expected.buffer, expected.byteOffset, expected.byteLength)) as { fact_id: string }[];
    expect(hit.map((h) => h.fact_id)).toContain(row.fact_id);
  });

  it("search ranks the fact it is asked for first when the table holds more rows than the candidate cut", async () => {
    const store = makeStore();
    await write(store, cs(Array.from({ length: 300 }, (_, i) => mob(i))), T0);
    const res = await search(store, "Mob217 trait217", { now: T0 });
    expect((res[0] as { header: string }).header).toBe("Mob217 trait217");
  });

  it("reindex moves a database with the float layout to the new one", async () => {
    const store = makeStore();
    await write(store, cs([draft(), draft({ header: "Zombie health", content: "Zombies have 20 health." })]), T0);
    store.db.exec("DROP TABLE current_vec");
    store.db.exec("CREATE VIRTUAL TABLE current_vec USING vec0(fact_id TEXT PRIMARY KEY, embedding FLOAT[384])");
    expect(checkIndex(store).map((d) => d.table)).toContain("current_vec");
    await reindex(store, fakeEmbed);
    expect(checkIndex(store)).toEqual([]);
    const ddl = (store.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'current_vec'").get() as { sql: string })
      .sql;
    expect(ddl).toContain("BIT[384]");
    const res = await search(store, "Zombie health", { now: T0 });
    expect((res[0] as { header: string }).header).toBe("Zombie health");
  });
});
