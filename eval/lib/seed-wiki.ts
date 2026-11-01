// The steps that `npm run demo:seed` and `npm run eval:bulk-wiki` share: a local-mode config, an open store, one seed change.
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { configPath, loadConfig } from "../../src/config/index.js";
import { JSON_INDENT } from "../../src/constants.js";
import { Mode } from "../../src/domain/index.js";
import { closeStore, openStoreFor, seedChange, type ChangeSet, type Store } from "../../src/store/index.js";

/** What `seedWiki` takes. */
export interface SeedWikiOptions {
  /** The database file to create; its folder gets a `wikifact.json` when it has none, or always with `replaceConfig`. */
  dbPath: string;
  /** True when the caller owns the folder: the config is written even when the folder has one. Absent: an existing config stays. */
  replaceConfig?: boolean;
  /** The subject line of a new `wikifact.json`. */
  subject: string;
  /** The embedding model name that a new `wikifact.json` records; absent: the default of the config. */
  embeddingModel?: string;
  /** The change that holds the seed facts. */
  change: ChangeSet;
  /** The justification of the seed request. */
  justification: string;
}

/** What `seedWiki` made. */
export interface SeededWiki {
  /** The open store, with the seed written; the caller closes it. */
  store: Store;
  /** The config file that was written, or `undefined` when the folder already had one. */
  wroteConfig?: string;
}

/**
 * Seeds a wiki: writes a `wikifact.json` in local mode when the folder has none (or always, with `replaceConfig`), opens the store with the config, and
 * writes the seed change.
 *
 * @param opts - the database path, the config subject and model, the change and its justification
 * @returns the open store and the path of the config file when this call wrote it
 * @throws {Error} when the store cannot be opened or the change cannot be written; the store is closed first
 * @sideEffects creates the folder of the database; writes `wikifact.json` through a temp file and a rename, so that a
 *   second seed in the same folder reads a whole file; creates the database; the embedder runs for the change
 */
export async function seedWiki(opts: SeedWikiOptions): Promise<SeededWiki> {
  const cfgPath = configPath(opts.dbPath);
  mkdirSync(dirname(opts.dbPath), { recursive: true });
  let wroteConfig: string | undefined;
  if (opts.replaceConfig === true || !existsSync(cfgPath)) {
    const config = {
      mode: Mode.Local,
      subject: opts.subject,
      ...(opts.embeddingModel === undefined ? {} : { embeddingModel: opts.embeddingModel }),
    };
    const temp = `${cfgPath}.${process.pid}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify(config, null, JSON_INDENT) + "\n");
      renameSync(temp, cfgPath);
    } finally {
      rmSync(temp, { force: true });
    }
    wroteConfig = cfgPath;
  }
  const store = openStoreFor(loadConfig(opts.dbPath), opts.dbPath);
  try {
    await seedChange(store, opts.change, { justification: opts.justification });
  } catch (e) {
    closeStore(store);
    throw e;
  }
  return { store, ...(wroteConfig === undefined ? {} : { wroteConfig }) };
}
