import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { backupDatabase, closeStore, countFacts, openStore, readSchemaVersion, SCHEMA_VERSION } from "../index.js";
import { accepted, draft, write } from "../../../__tests__/helpers/store.js";

const tmp = (): string => mkdtempSync(join(tmpdir(), "backup-"));

describe("backupDatabase", () => {
  it("copies a database that a store can open, and leaves the source bytes as they were", async () => {
    const dir = tmp();
    const from = join(dir, "from.sqlite");
    const s = openStore(from, { embeddingModel: "test-model" });
    write(s, accepted([draft()]), 1);
    closeStore(s);
    const bytes = readFileSync(from);

    const to = join(dir, "to.sqlite");
    await backupDatabase(from, to);

    expect(readFileSync(from).equals(bytes)).toBe(true);
    const copy = openStore(to, { embeddingModel: "test-model" });
    expect(countFacts(copy)).toBe(1);
    closeStore(copy);
  });

  it("throws for a missing source and creates neither file", async () => {
    const dir = tmp();
    await expect(backupDatabase(join(dir, "no.sqlite"), join(dir, "to.sqlite"))).rejects.toThrow();
    expect(existsSync(join(dir, "no.sqlite"))).toBe(false);
  });
});

describe("readSchemaVersion", () => {
  it("reads the version of a store, and of an older file, without migrating it", () => {
    const dir = tmp();
    const path = join(dir, "w.sqlite");
    closeStore(openStore(path, { embeddingModel: "test-model" }));
    expect(readSchemaVersion(path)).toBe(SCHEMA_VERSION);

    const db = new Database(path);
    db.prepare("UPDATE meta SET value = '3' WHERE key = 'schema_version'").run();
    db.close();
    const bytes = readFileSync(path);
    expect(readSchemaVersion(path)).toBe(3);
    expect(readFileSync(path).equals(bytes)).toBe(true);
  });

  it("gives null for a database without a wiki meta table", () => {
    const path = join(tmp(), "other.sqlite");
    const db = new Database(path);
    db.exec("CREATE TABLE t (x)");
    db.close();
    expect(readSchemaVersion(path)).toBeNull();
  });
});
