import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EMBEDDING_MODEL, embed, setEmbedder } from "../../src/embed/index.js";
import { backupDatabase, closeStore, countFacts, openStore, search } from "../../src/store/index.js";
import { fakeEmbed } from "../../fakes/fake-embedder.js";
import { runProfile } from "./profile.js";
import {
  SPEED_BAR_MS,
  defaultSpeedOut,
  describeMachine,
  speedPasses,
  summarizeTimes,
  writeSpeedResults,
  type SpeedResultFile,
} from "./report.js";
import { makeQueries, seedFacts } from "./seed.js";

/** Queries run before the timed ones, to load the model and fill the caches. */
const WARM_UP_QUERIES = 3;

/** The options of `runSpeed`. */
export interface SpeedOptions {
  /** The number of synthetic facts. Required without `wiki`; with `wiki` it must be absent (the wiki is measured as it is). */
  facts?: number;
  /** The number of timed queries. */
  queries: number;
  /** The fake embedder for seeding and queries. */
  fake: boolean;
  /** The fake embedder for seeding only; the queries use the real one. */
  seedFake: boolean;
  /** Keep the database at this path, and reuse it when it already holds `facts` facts. Default: a temporary file. */
  db?: string;
  /** A wiki of an environment to measure on a copy of it, made with the SQLite backup API; `db` is never written. */
  wiki?: { env: string; name: string; db: string };
  /** Time each statement of the consumer search over the same queries. */
  profile: boolean;
  /** The results file. Default: eval/speed-results/<ISO timestamp>.json. */
  out?: string;
  /** Receives each line of progress. Default: the console. */
  log?: (line: string) => void;
}

/**
 * Seeds synthetic facts, times the consumer search over a fixed list of queries, and writes the results file.
 *
 * @param opts - the sizes, the embedder choice, the database path, the profile switch and the output path
 * @returns the results as written to the file; with `wiki`, `n` is the fact count of the copy and `env` and `wiki` name it
 * @throws {Error} when `wiki` is given with `facts`, or `facts` is missing without `wiki`
 * @sideEffects sets the global embedder; makes and removes a temporary database unless `db` is given; writes the
 *   store (a temporary copy of the wiki with `wiki`), the results file and progress lines; runs the embedder; reads the
 *   clock; reads `wiki.db`
 */
export async function runSpeed(opts: SpeedOptions): Promise<SpeedResultFile> {
  if (opts.wiki !== undefined && opts.facts !== undefined) {
    throw new Error("--wiki measures the wiki as it is: give no fact count");
  }
  if (opts.wiki === undefined && opts.facts === undefined) throw new Error("a fact count is required without --wiki");
  const log = opts.log ?? ((line: string) => console.log(line));
  const startedAt = new Date();
  if (opts.fake || opts.seedFake) setEmbedder(fakeEmbed);
  const dir = opts.db ? undefined : mkdtempSync(join(tmpdir(), "wikifact-speed-"));
  const dbPath = opts.db ?? join(dir ?? tmpdir(), "speed.sqlite");
  if (opts.wiki !== undefined) await backupDatabase(opts.wiki.db, dbPath);
  const reuse = opts.db !== undefined && existsSync(opts.db);
  const store = openStore(dbPath, { embeddingModel: EMBEDDING_MODEL });
  try {
    const have = countFacts(store);
    const wanted = opts.facts ?? have;
    const start = reuse && have >= wanted ? wanted : have;
    log(start >= wanted ? `reusing ${have} facts` : `seeding ${wanted} facts from ${start}`);
    await seedFacts(store, { from: start, n: wanted }, log);

    if (opts.seedFake && !opts.fake) setEmbedder(null);

    const queries = makeQueries(opts.queries);
    await embed(["warm up"]);
    for (const q of queries.slice(0, WARM_UP_QUERIES)) await search(store, q);

    const times: number[] = [];
    let hits = 0;
    for (const q of queries) {
      const s = performance.now();
      const res = await search(store, q);
      times.push(performance.now() - s);
      hits += res.length;
    }
    const profile = opts.profile ? await runProfile(store, queries) : null;
    if (profile) log(JSON.stringify({ profile }));
    const summary = summarizeTimes({
      facts: wanted,
      embedder: opts.fake ? "fake" : EMBEDDING_MODEL,
      times,
      hits,
    });
    log(JSON.stringify(summary));

    const finishedAt = new Date();
    const result: SpeedResultFile = {
      n: wanted,
      ...(opts.wiki ? { env: opts.wiki.env, wiki: opts.wiki.name } : {}),
      queryCount: summary.queries,
      embedder: summary.embedder,
      seedFake: opts.fake || opts.seedFake,
      reusedDatabase: start >= wanted && reuse,
      p50_ms: summary.p50_ms,
      p95_ms: summary.p95_ms,
      max_ms: summary.max_ms,
      meanResults: summary.meanResults,
      barMs: SPEED_BAR_MS,
      pass: speedPasses(summary.p95_ms),
      profile,
      machine: describeMachine(),
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
    };
    const outPath = opts.out ?? defaultSpeedOut(finishedAt);
    writeSpeedResults(outPath, result);
    log(`results written to ${outPath}`);
    log(
      result.pass
        ? `speed: PASS (p95 ${result.p95_ms} ms under ${SPEED_BAR_MS} ms)`
        : `speed: FAIL (p95 ${result.p95_ms} ms, bar ${SPEED_BAR_MS} ms)`,
    );
    return result;
  } finally {
    closeStore(store);
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}
