import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setEmbedder } from "../../../src/embed/index.js";
import { EMBEDDING_MODEL } from "../../../src/embed/index.js";
import { closeStore, countFacts, openStore } from "../../../src/store/index.js";
import { fakeEmbed } from "../../../fakes/fake-embedder.js";
import { runSpeed, type SpeedOptions } from "../run.js";
import { seedFacts } from "../seed.js";

afterEach(() => setEmbedder(null));

const SEEDED_FACTS = 7;

// Makes a wiki file that holds `SEEDED_FACTS` facts.
async function makeWiki(): Promise<{ dir: string; wiki: string }> {
  const dir = mkdtempSync(join(tmpdir(), "wikifact-speedtest-"));
  const wiki = join(dir, "game.sqlite");
  setEmbedder(fakeEmbed);
  const store = openStore(wiki, { embeddingModel: EMBEDDING_MODEL });
  await seedFacts(store, { from: 0, n: SEEDED_FACTS }, () => undefined);
  closeStore(store);
  return { dir, wiki };
}

const base = (out: string): SpeedOptions => ({
  queries: 3,
  fake: true,
  seedFake: false,
  profile: false,
  out,
  log: () => undefined,
});

describe("runSpeed on a wiki", () => {
  it("measures a copy, records the environment, the wiki and the real fact count, and leaves the wiki as it was", async () => {
    const { dir, wiki } = await makeWiki();
    const out = join(dir, "r.json");
    const result = await runSpeed({ ...base(out), wiki: { env: "local", name: "game", db: wiki } });
    expect(result).toMatchObject({ n: SEEDED_FACTS, env: "local", wiki: "game", reusedDatabase: false });
    expect(JSON.parse(readFileSync(out, "utf8"))).toMatchObject({ n: SEEDED_FACTS, env: "local", wiki: "game" });
    const store = openStore(wiki, { embeddingModel: EMBEDDING_MODEL });
    try {
      expect(countFacts(store)).toBe(SEEDED_FACTS);
    } finally {
      closeStore(store);
    }
  });

  it("refuses a fact count together with a wiki, and a missing count without one", async () => {
    const { dir, wiki } = await makeWiki();
    const out = join(dir, "r.json");
    await expect(
      runSpeed({ ...base(out), facts: SEEDED_FACTS + 1, wiki: { env: "local", name: "game", db: wiki } }),
    ).rejects.toThrow(/no fact count/);
    await expect(runSpeed(base(out))).rejects.toThrow(/fact count is required/);
  });
});
