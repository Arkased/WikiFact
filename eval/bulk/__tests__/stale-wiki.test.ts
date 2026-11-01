import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, loadPrices } from "../../../src/config/index.js";
import { setEmbedder } from "../../../src/embed/index.js";
import { closeStore, openStoreFor, peekQueue } from "../../../src/store/index.js";
import { fakeEmbed } from "../../../fakes/fake-embedder.js";
import { StubQuestions } from "../../../fakes/stub-questions.js";
import { runBulkTest } from "../run.js";
import { assertWikiCurrent, buildBulkWiki } from "../wiki.js";
import { MetaKey } from "../../../src/domain/index.js";

const STALE_POSITION = 3;
const SAMPLE = 5;

/**
 * Builds the stub bulk wiki, then changes the text of 1 queued submission, as a change of the fakes after the build would.
 *
 * @returns the folder and the wiki file
 * @sideEffects writes a temp folder
 */
async function staleWiki(): Promise<{ dir: string; db: string }> {
  const dir = mkdtempSync(join(tmpdir(), "wikifact-stale-wiki-"));
  const db = join(dir, "bulk-stub.sqlite");
  await buildBulkWiki({ dbPath: db, stub: true });
  const store = openStoreFor(loadConfig(db), db);
  try {
    const rows = peekQueue(store, SAMPLE * 2);
    store.db
      .prepare("UPDATE change_requests SET change = ? WHERE id = ?")
      .run("A text that fakes/bulk-submissions.ts no longer holds.", rows[STALE_POSITION]?.id);
  } finally {
    closeStore(store);
  }
  return { dir, db };
}

describe("a bulk wiki that is stale against the fakes", () => {
  beforeEach(() => setEmbedder(fakeEmbed));
  afterEach(() => setEmbedder(null));

  it("checks the source that holds the marker", async () => {
    const { db } = await staleWiki();
    expect(() => assertWikiCurrent(db)).toThrow(/1 queued submissions differ/);
  });

  it("does not check a source with the seed facts and no marker", async () => {
    const { db } = await staleWiki();
    const store = openStoreFor(loadConfig(db), db);
    try {
      store.db.prepare("DELETE FROM meta WHERE key = ?").run(MetaKey.BulkTestWiki);
    } finally {
      closeStore(store);
    }
    expect(() => assertWikiCurrent(db)).not.toThrow();
  });

  it("stops a normal run before a copy is made, and names the position", async () => {
    const { dir, db } = await staleWiki();
    const workDir = join(dir, "work");
    await expect(
      runBulkTest({
        db,
        requests: SAMPLE,
        workDir,
        outPath: join(dir, "out", "result.json"),
        config: loadConfig(db),
        makeQuestions: () => new StubQuestions(),
        judge: new StubQuestions(),
        prices: loadPrices(),
        log: () => undefined,
        stub: true,
      }),
    ).rejects.toThrow(new RegExp(`1 queued submissions differ.*${STALE_POSITION}.*npm run eval:bulk-wiki`));
    expect(existsSync(join(workDir, "bulk-sequential.sqlite"))).toBe(false);
  });
});
