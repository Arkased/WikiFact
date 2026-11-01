import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setEmbedder } from "../../../src/embed/index.js";
import { fakeEmbed } from "../../../fakes/fake-embedder.js";
import { buildBulkWiki } from "../wiki.js";

const rename = vi.hoisted(() => ({ code: "EBUSY" }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      if (!from.includes(".sqlite.")) return actual.renameSync(from, to);
      throw Object.assign(new Error(`${rename.code}: resource busy or locked`), { code: rename.code });
    },
  };
});

describe("buildBulkWiki when another process holds the wiki file", () => {
  beforeEach(() => setEmbedder(fakeEmbed));
  afterEach(() => setEmbedder(null));

  it.each(["EBUSY", "EPERM"])("says so on %s and leaves no temp file", async (code) => {
    rename.code = code;
    const db = join(mkdtempSync(join(tmpdir(), "wikifact-bulk-wiki-")), "bulk.sqlite");
    await expect(buildBulkWiki({ dbPath: db, stub: true })).rejects.toThrow(/another process holds the wiki file/);
    expect(readdirSync(dirname(db)).filter((f) => f.includes(".tmp"))).toEqual([]);
  });

  it("rethrows another fault as it is", async () => {
    rename.code = "ENOENT";
    const db = join(mkdtempSync(join(tmpdir(), "wikifact-bulk-wiki-")), "bulk.sqlite");
    await expect(buildBulkWiki({ dbPath: db, stub: true })).rejects.toThrow(/ENOENT/);
  });
});
