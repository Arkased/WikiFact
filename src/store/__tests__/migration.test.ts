import { describe, expect, it } from "vitest";
import { makeSchema15Db } from "../../../__tests__/helpers/schema15.js";
import { RequestKind } from "../../domain/enums.js";
import { SCHEMA_VERSION, closeStore, getRequest, openStore } from "../index.js";

describe("the migration to schema 16", () => {
  it("drops the tables of the removed feature, keeps the other rows and renames the repair kind", () => {
    const { path, oldRequestId } = makeSchema15Db();
    const store = openStore(path, { embeddingModel: "test-model" });
    try {
      const names = (store.db.prepare("SELECT name FROM sqlite_master").all() as { name: string }[]).map((r) => r.name);
      expect(names.filter((n) => n.startsWith("tag") || n.includes("_tag"))).toEqual([]);
      expect(store.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({
        value: String(SCHEMA_VERSION),
      });
      expect(store.db.prepare("SELECT kind, target_id FROM search_results").all()).toEqual([
        { kind: "fact", target_id: "f1" },
      ]);
      expect(store.db.prepare("SELECT finder FROM cleanup_verdicts").all()).toEqual([{ finder: "duplicateFact" }]);
      expect(getRequest(store, oldRequestId)?.kind).toBe(RequestKind.CleanupRepair);
    } finally {
      closeStore(store);
    }
  });
});

describe("the migration to schema 17", () => {
  it("deletes the meta key of the removed threshold mode", () => {
    const { path } = makeSchema15Db();
    closeStore(openStore(path, { embeddingModel: "test-model" }));
    const held = openStore(path, { embeddingModel: "test-model" });
    try {
      held.db.prepare("INSERT INTO meta(key, value) VALUES ('high_volume', '{}')").run();
      held.db.prepare("UPDATE meta SET value = '16' WHERE key = 'schema_version'").run();
    } finally {
      closeStore(held);
    }
    const store = openStore(path, { embeddingModel: "test-model" });
    try {
      expect(store.db.prepare("SELECT value FROM meta WHERE key = 'high_volume'").get()).toBeUndefined();
      expect(store.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({
        value: String(SCHEMA_VERSION),
      });
    } finally {
      closeStore(store);
    }
  });
});
