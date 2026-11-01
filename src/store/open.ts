import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { MetaKey } from "../domain/enums.js";
import { EMBEDDING_DIM } from "../embed/index.js";
import { createIndexWriter } from "./indexer.js";
import { migrate } from "./migrations.js";
import {
  MINTED_REF_INDEX_SQL,
  REQUEST_PARENT_INDEX_SQL,
  OLDEST_SCHEMA_VERSION,
  SCHEMA_VERSION,
  TABLES_SQL,
  indexTablesSql,
} from "./schema.js";
import { createStagingTables } from "./stagingTables.js";
import {
  DEFAULT_AGENT_SEARCH_CAP,
  DEFAULT_NEIGHBOR_DISTANCE,
  DEFAULT_RELEVANCE_FLOOR,
  DEFAULT_SEARCH_CAP,
  DEFAULT_WEIGHTS,
  type Store,
  type StoreConfig,
  type Weights,
} from "./types/index.js";

/** How long a connection waits for a lock held by another connection, in ms (technical/updates.md, "Agent write failures"). */
const BUSY_TIMEOUT_MS = 5000;

/** Thrown when the database `meta` differs from the config (embedding model, dimension or schema version). */
export class StoreMismatchError extends Error {}

/** The options of `openStore`. */
export interface OpenOptions {
  /** A read connection. It does not create tables and does not write meta. */
  readonly?: boolean;
}

/**
 * Opens the wiki database. Creates the tables when absent. Sets WAL and the busy timeout.
 * Refuses to open when the config embedding model differs from `meta` (technical/updates.md, "System failures", F15).
 *
 * @param path - the path of the SQLite file
 * @param config - the embedding model, the dimension (default 384), the weights and the result caps; an absent
 *   weight or cap takes its default
 * @param options - `readonly: true` for a read connection that creates nothing
 * @returns the open store; the caller closes it with `closeStore`
 * @throws {StoreMismatchError} when `meta` holds another schema version, embedding model or dimension
 * @throws {Error} when the file cannot be opened, or a read-only open finds no tables
 * @sideEffects opens the file; sets the busy timeout (5000 ms) and foreign keys, and WAL unless read-only; loads
 *   the sqlite-vec extension; unless read-only, one immediate transaction creates the tables and writes `meta`, then
 *   the migrations run, the staging tables are created when absent from the live tables, and the index of request children is created;
 *   closes the connection again when it throws
 */
export function openStore(path: string, config: StoreConfig, options: OpenOptions = {}): Store {
  const db = new Database(path, { readonly: options.readonly ?? false });
  try {
    db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
    if (!options.readonly) db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    sqliteVec.load(db);

    const dim = config.embeddingDim ?? EMBEDDING_DIM;
    if (!options.readonly) {
      const stored = db
        .transaction(() => {
          db.exec(TABLES_SQL);
          db.exec(indexTablesSql(dim));
          checkOrWriteMeta(db, config.embeddingModel, dim, true);
          return checkSchemaVersion(db, true);
        })
        .immediate();
      migrate(db, stored);
      // After the migration, so that a table of a database made by older code is derived from the migrated live tables.
      db.transaction(() => createStagingTables(db, false)).immediate();
      db.exec(REQUEST_PARENT_INDEX_SQL);
      db.exec(MINTED_REF_INDEX_SQL);
    } else {
      checkOrWriteMeta(db, config.embeddingModel, dim, false);
      checkSchemaVersion(db, false);
    }

    return {
      db,
      config: {
        embeddingModel: config.embeddingModel,
        embeddingDim: dim,
        searchCap: config.searchCap ?? DEFAULT_SEARCH_CAP,
        agentSearchCap: config.agentSearchCap ?? DEFAULT_AGENT_SEARCH_CAP,
        relevanceFloor: config.relevanceFloor ?? DEFAULT_RELEVANCE_FLOOR,
        neighborDistance: config.neighborDistance ?? DEFAULT_NEIGHBOR_DISTANCE,
      },
      weights: { ...DEFAULT_WEIGHTS, ...config.weights },
      indexWriter: createIndexWriter(),
    };
  } catch (e) {
    db.close();
    throw e;
  }
}

/** The part of the wiki config that decides how a store opens. `Config` satisfies it. */
export interface StoreSettings {
  embeddingModel: string;
  weights: Partial<Weights>;
  searchCap: number;
  agentSearchCap: number;
  /** Cosine distance; default `DEFAULT_RELEVANCE_FLOOR`. */
  relevanceFloor?: number;
}

/**
 * Opens the store of a wiki with the embedding model, weights and result caps of its config.
 *
 * @param config - the wiki config (`Config` from `src/config/index.ts` fits)
 * @param dbPath - the path of the SQLite file
 * @param opts - `readonly: true` for a read connection that creates nothing
 * @returns the open store; the caller closes it
 * @throws {StoreMismatchError} when `meta` holds another schema version, embedding model or dimension
 * @sideEffects as `openStore`: opens the file, loads sqlite-vec and, unless read-only, creates the tables and
 *   writes `meta`
 */
export function openStoreFor(config: StoreSettings, dbPath: string, opts: OpenOptions = {}): Store {
  return openStore(
    dbPath,
    {
      embeddingModel: config.embeddingModel,
      weights: config.weights,
      searchCap: config.searchCap,
      agentSearchCap: config.agentSearchCap,
      relevanceFloor: config.relevanceFloor,
    },
    opts,
  );
}

/**
 * Closes the database connection of a store.
 *
 * @param store - the open store; it is unusable afterwards
 * @sideEffects closes the database connection
 */
export function closeStore(store: Store): void {
  store.db.close();
}

function checkOrWriteMeta(db: Database.Database, model: string, dim: number, write: boolean): void {
  const get = db.prepare("SELECT value FROM meta WHERE key = ?");
  const set = db.prepare("INSERT INTO meta(key, value) VALUES (?, ?)");
  const expected: [MetaKey, string][] = [
    [MetaKey.EmbeddingModel, model],
    [MetaKey.EmbeddingDim, String(dim)],
  ];
  for (const [key, want] of expected) {
    const row = get.get(key) as { value: string } | undefined;
    if (!row) {
      if (write) set.run(key, want);
      continue;
    }
    if (row.value !== want) {
      throw new StoreMismatchError(
        `meta.${key} is "${row.value}" but the config says "${want}". ` +
          "Run `wikifact reindex` after you change the embedding model.",
      );
    }
  }
}

// Reads the schema version. A new database gets the latest version; a newer one than the code is refused; an older one
// is returned for `migrate` (writable) or refused (read-only, which cannot migrate).
function checkSchemaVersion(db: Database.Database, write: boolean): number {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(MetaKey.SchemaVersion) as
    { value: string } | undefined;
  if (!row) {
    if (write) {
      db.prepare("INSERT INTO meta(key, value) VALUES (?, ?)").run(MetaKey.SchemaVersion, String(SCHEMA_VERSION));
    }
    return SCHEMA_VERSION;
  }
  const stored = Number(row.value);
  if (!Number.isInteger(stored)) {
    throw new StoreMismatchError(`meta.schema_version is "${row.value}", which is not a schema version.`);
  }
  if (stored < OLDEST_SCHEMA_VERSION) {
    throw new StoreMismatchError(
      `meta.schema_version is ${stored} but this code migrates from schema ${OLDEST_SCHEMA_VERSION}. Migrate the database with an earlier release first.`,
    );
  }
  if (stored > SCHEMA_VERSION) {
    throw new StoreMismatchError(
      `meta.schema_version is ${stored} but this code knows schema ${SCHEMA_VERSION}. Update WikiFact; the database was written by a newer version.`,
    );
  }
  if (stored < SCHEMA_VERSION && !write) {
    throw new StoreMismatchError(
      `meta.schema_version is ${stored} but this code needs schema ${SCHEMA_VERSION}. Open the database with a writable connection (the worker or the server) to migrate it.`,
    );
  }
  return stored;
}
