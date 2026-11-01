// The builder of the wiki of the bulk test (technical/updates.md, "The wiki of the bulk test"): the schema of the current
// code, the seed facts written straight with their embeddings, and the submissions queued.
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { renameSync, rmSync } from "node:fs";
import { ChangeOutcome, MetaKey } from "../../src/domain/index.js";
import { setEmbedder } from "../../src/embed/index.js";
import { errnoCode } from "../../src/must.js";
import { projectRoot } from "../../src/paths.js";
import {
  closeStore,
  countFacts,
  countQueuedSubmissions,
  enqueueRequest,
  readSourceContent,
  type FactDraft,
} from "../../src/store/index.js";
import { BULK_SUBMISSIONS } from "../../fakes/bulk-submissions.js";
import { SEED_FACTS } from "../../fakes/bulk-seed-facts.js";
import { FAKE_EMBEDDING_MODEL, fakeEmbed } from "../../fakes/fake-embedder.js";
import { seedWiki } from "../lib/seed-wiki.js";

/** The subject of the bulk test wiki: the sentence that every question gets. */
const SUBJECT = "The WikiFact code base: a wiki that AI agents read and maintain over MCP";

/** How many differing positions the stale-wiki error names. */
const STALE_POSITIONS_SHOWN = 5;

/** The folder of the built wikis under the project root; git ignores `.cache`. */
const BULK_WIKI_FOLDER = join(".cache", "bulk-wiki");

/** The suffixes of the files that SQLite keeps beside a database in WAL mode. */
const SIDE_FILES = ["-wal", "-shm"];

/** The error codes of a file that another process holds open (Windows refuses the delete and the rename). */
const HELD_FILE_CODES = new Set(["EBUSY", "EPERM"]);

/** What `buildBulkWiki` takes. */
export interface BulkWikiOptions {
  /** The database file to create; its folder always gets a `wikifact.json` (the builder owns the folder and replaces any config). */
  dbPath: string;
  /** True to embed with the fake embedder and record it in the config. */
  stub: boolean;
}

/** What `buildBulkWiki` made. */
export interface BulkWikiCounts {
  /** The live facts of the seed. */
  facts: number;
  /** The queued submissions. */
  queued: number;
}

/**
 * Gives the fixed path of the built wiki. The 2 kinds have 2 folders and 2 file names, and each folder has its own
 * `wikifact.json`, so that a wiki of fake vectors is never taken for a real one.
 *
 * @param stub - true for the wiki of the fake embedder
 * @returns `<project root>/.cache/bulk-wiki/stub/bulk-stub.sqlite`, or `.../real/bulk.sqlite`
 * @sideEffects none
 */
export function bulkWikiPath(stub: boolean): string {
  return join(projectRoot(), BULK_WIKI_FOLDER, stub ? "stub" : "real", stub ? "bulk-stub.sqlite" : "bulk.sqlite");
}

/**
 * Stops a run whose mode and wiki disagree on the embedder: a wiki of fake vectors under the real model, or the reverse.
 *
 * @param embeddingModel - the embedding model of the wiki config, which the store keeps in `meta` and checks at each open
 * @param stub - true when the run is `--stub`
 * @throws {Error} when the wiki was built with the fake embedder and the run is not `--stub`, or the reverse
 * @sideEffects none
 */
export function assertEmbedderMatches(embeddingModel: string, stub: boolean): void {
  const stubWiki = embeddingModel === FAKE_EMBEDDING_MODEL;
  if (stubWiki && !stub) {
    throw new Error(
      "this wiki was built with the fake embedder (`npm run eval:bulk-wiki -- --stub`): run with --stub, or build a real wiki with `npm run eval:bulk-wiki`",
    );
  }
  if (!stubWiki && stub) {
    throw new Error(
      "--stub needs a wiki built with the fake embedder: build one with `npm run eval:bulk-wiki -- --stub`, or run without --stub",
    );
  }
}

/**
 * Stops a run on a wiki that `npm run eval:bulk-wiki` built before a change of `fakes/bulk-submissions.ts`: the queued
 * submissions are compared, in queue order, with the submission at the same position of the file, because the labels and
 * the label pairs map a request to its label by position only. Another source (a copy of a live wiki, or a wiki built
 * before the marker) is not checked: a wiki is a bulk-test wiki when its `meta` holds the marker that `buildBulkWiki`
 * writes (a copy carries no config file, but it keeps `meta`). The file is read without a store, so a wiki on an older schema than this code is still checked.
 *
 * @param source - the source database; opened read only
 * @throws {Error} when 1 or more queued submissions differ from the submission at their position; the message names the count and the first positions
 * @sideEffects reads the source through a read-only connection
 */
export function assertWikiCurrent(source: string): void {
  const { bulkTestWiki, queuedSubmissions } = readSourceContent(source);
  if (!bulkTestWiki) return;
  const stale = queuedSubmissions.flatMap((change, i) => (BULK_SUBMISSIONS[i]?.change === change ? [] : [i]));
  if (stale.length === 0) return;
  const more = stale.length > STALE_POSITIONS_SHOWN ? ", ..." : "";
  throw new Error(
    `this wiki is stale against fakes/bulk-submissions.ts: ${stale.length} queued submissions differ, at positions (from 0) ${stale.slice(0, STALE_POSITIONS_SHOWN).join(", ")}${more}; run \`npm run eval:bulk-wiki\` to build it again`,
  );
}

/**
 * Removes the side files of the target and renames the built file over it.
 *
 * @param temp - the built database file
 * @param dbPath - the target path
 * @throws {Error} when Windows refuses the delete or the rename (EBUSY or EPERM): another process holds the wiki file; any other fault is rethrown as it is
 * @sideEffects deletes `dbPath` side files; replaces the file at `dbPath`
 */
function replaceWikiFile(temp: string, dbPath: string): void {
  try {
    for (const suffix of SIDE_FILES) rmSync(dbPath + suffix, { force: true });
    renameSync(temp, dbPath);
  } catch (e) {
    const code = errnoCode(e);
    if (code !== undefined && HELD_FILE_CODES.has(code)) {
      throw new Error(
        `another process holds the wiki file ${dbPath}: close it (a running bulk test or the service) and build again`,
        { cause: e },
      );
    }
    throw e;
  }
}

/**
 * Builds the bulk test wiki: creates the database with the schema of this code in a temp file beside the target, writes
 * the seed facts in one change with their embeddings, queues the submissions in order, and renames the file over
 * `dbPath` at the end, so that a reader never sees a half-built file and 2 builds at once do not corrupt each other (the
 * last rename wins).
 *
 * @param opts - the file to create and the embedder
 * @returns the counts of facts and queued submissions of the built wiki
 * @throws {Error} when the built wiki does not hold the seed facts or the submissions it was given; the temp file is removed
 * @sideEffects creates the folder, the config and the temp database, then replaces the file at `dbPath` and removes its
 *   side files; for a stub build, sets the fake embedder for the rest of the process; the embedder runs for every seed
 *   fact (the real model unless the build is a stub)
 */
export async function buildBulkWiki(opts: BulkWikiOptions): Promise<BulkWikiCounts> {
  const { dbPath, stub } = opts;
  const temp = join(dirname(dbPath), `${basename(dbPath)}.${randomUUID()}.tmp`);
  if (stub) setEmbedder(fakeEmbed);
  try {
    const facts: FactDraft[] = SEED_FACTS.map((f) => ({
      header: f.header,
      content: f.content,
      justification: f.justification,
      references: [],
    }));
    const { store } = await seedWiki({
      dbPath: temp,
      // The builder owns its folders: a config left by an earlier build of the other embedder must not win.
      replaceConfig: true,
      subject: SUBJECT,
      ...(stub ? { embeddingModel: FAKE_EMBEDDING_MODEL } : {}),
      change: {
        outcome: ChangeOutcome.Accepted,
        summary: "Seed the bulk test wiki",
        changeReasoning: "Test data of fakes/bulk-seed-facts.ts.",
        facts,
      },
      justification: "bulk test seed",
    });
    let counts: BulkWikiCounts;
    try {
      // One millisecond apart, so that the queue takes the submissions in the order of the file.
      const start = Date.now();
      BULK_SUBMISSIONS.forEach((s, i) => {
        enqueueRequest(store, { change: s.change, justification: s.justification }, start + i);
      });
      store.db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)").run(MetaKey.BulkTestWiki, "1");
      counts = { facts: countFacts(store), queued: countQueuedSubmissions(store) };
    } finally {
      closeStore(store);
    }
    if (counts.facts !== SEED_FACTS.length || counts.queued !== BULK_SUBMISSIONS.length) {
      throw new Error(`the built wiki holds ${counts.facts} facts and ${counts.queued} queued submissions`);
    }
    replaceWikiFile(temp, dbPath);
    return counts;
  } finally {
    for (const suffix of ["", ...SIDE_FILES]) rmSync(temp + suffix, { force: true });
  }
}
