// Seeds the wiki of the correction test: 50 facts (10 wrong), a read history, then 5 new facts.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ChangeOutcome } from "../../src/domain/index.js";
import { loadConfig, type Config } from "../../src/config/index.js";
import {
  closeStore,
  openStoreFor,
  recordRetrieval,
  seedChange,
  type FactDraft,
  type Store,
} from "../../src/store/index.js";
import { isWrong, loadData, type Data, type SeedFact } from "./data.js";
import { must } from "./must.js";
import { JSON_INDENT } from "../../src/constants.js";

/** One day, in ms. */
const DAY_MS = 24 * 60 * 60 * 1000;
/** The age of the base facts and the start of their read history, in days before the seed time. */
const BASE_AGE_DAYS = 60;
/** The age of the new facts (F17), in days before the seed time. */
const NEW_FACT_AGE_DAYS = 1;
/** The reads of base fact `i` are `(i * READ_STRIDE) % READ_MODULUS`: 0 to 3 reads, deterministic. */
const READ_STRIDE = 7;
/** The modulus of the read count: a fact gets at most `READ_MODULUS - 1` reads. */
const READ_MODULUS = 4;
/** Read `r` of fact `i` is `(i + r * READ_SPREAD) % BASE_AGE_DAYS` days old, which spreads the reads over the history. */
const READ_SPREAD = 9;
/** A read is placed this much before its day boundary, in ms, so that it falls after the seed change. */
const READ_OFFSET_MS = 1000;
/** The justification of a wrong fact; a right fact is justified by a test in the game. */
const MISTAKEN_JUSTIFICATION = "I saw this once in my world.";

/** A seeded wiki: the open store and the maps between seed keys and fact ids. */
export interface Seeded {
  store: Store;
  config: Config;
  dbPath: string;
  /** Seed key to fact id. */
  ids: Map<string, string>;
  /** Fact id to seed key. */
  keyOf: Map<string, string>;
}

/**
 * Writes `wikifact.json` next to the database and removes an old database.
 *
 * @param dbPath - the path of the SQLite file
 * @param cap - the search cap of the wiki
 * @param subject - the subject of the wiki
 * @param relevanceFloor - the cosine-distance floor of the wiki; absent leaves the default
 * @returns the config loaded for that database
 * @sideEffects creates the folder, deletes the old database files and writes `wikifact.json`
 */
function prepareDb(dbPath: string, cap: number, subject: string, relevanceFloor?: number): Config {
  mkdirSync(dirname(dbPath), { recursive: true });
  for (const s of ["", "-wal", "-shm"]) if (existsSync(dbPath + s)) rmSync(dbPath + s);
  writeFileSync(
    join(dirname(dbPath), "wikifact.json"),
    JSON.stringify(
      { subject, searchCap: cap, ...(relevanceFloor === undefined ? {} : { relevanceFloor }) },
      null,
      JSON_INDENT,
    ),
  );
  return loadConfig(dbPath);
}

/** The options of `seedWiki`. */
export interface SeedWikiOptions {
  /** The search cap of the wiki. */
  cap: number;
  /** The seed data. Default: read from the JSON files. */
  data?: Data;
  /** The seed time, in ms since the epoch. Default: now. */
  now?: number;
  /** The relevance floor of the wiki, as a cosine distance. Default: the store default. */
  relevanceFloor?: number;
}

function draftOf(f: SeedFact): FactDraft {
  return {
    header: f.header,
    content: f.content,
    justification: isWrong(f) ? MISTAKEN_JUSTIFICATION : `I tested this in the game and saw it: ${f.content}`,
    references: [],
  };
}

/**
 * Seeds 50 facts (10 wrong), gives the 50 a read history so that they carry usefulness,
 * then seeds the 5 new facts with no history (F17). The wrong facts carry a mistaken justification.
 * With W_USE = 0.01 and a 30 day half-life, the history gives the base facts a usefulness of about 0.6 on average.
 *
 * @param dbPath - the path of the SQLite file; an old file is removed
 * @param opts - the cap, the data and the seed time
 * @returns the open store and the key/id maps; the caller closes the store
 * @sideEffects writes `wikifact.json` and the database, runs the embedder, writes the facts and the retrievals
 */
export async function seedWiki(dbPath: string, opts: SeedWikiOptions): Promise<Seeded> {
  const data = opts.data ?? loadData();
  const now = opts.now ?? Date.now();
  const config = prepareDb(dbPath, opts.cap, data.subject, opts.relevanceFloor);
  const store = openStoreFor(config, dbPath);
  const ids = new Map<string, string>();
  const keyOf = new Map<string, string>();
  try {
    const write = async (facts: SeedFact[], at: number, label: string): Promise<void> => {
      const res = await seedChange(
        store,
        {
          outcome: ChangeOutcome.Accepted,
          summary: label,
          changeReasoning: label,
          facts: facts.map(draftOf),
        },
        { now: at, change: label, justification: label },
      );
      facts.forEach((f, i) => {
        const id = must(res.factIds[i], `seed: no fact id for ${f.key}`);
        ids.set(f.key, id);
        keyOf.set(id, f.key);
      });
    };

    await write(data.facts, now - BASE_AGE_DAYS * DAY_MS, "Seed the correction test");
    data.facts.forEach((f, i) => {
      const reads = (i * READ_STRIDE) % READ_MODULUS;
      const id = must(ids.get(f.key), `seed: unknown fact ${f.key}`);
      for (let r = 0; r < reads; r++)
        recordRetrieval(store, id, { now: now - ((i + r * READ_SPREAD) % BASE_AGE_DAYS) * DAY_MS - READ_OFFSET_MS });
    });
    await write(data.newFacts, now - NEW_FACT_AGE_DAYS * DAY_MS, "Seed the new facts");
  } catch (e) {
    closeStore(store);
    throw e;
  }
  return { store, config, dbPath, ids, keyOf };
}
