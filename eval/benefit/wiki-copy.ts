// The copies of the wiki that the benefit test reads (technical/evaluation.md, "The benefit test", Inputs): the given
// file is never written; a run reads a copy of its own.
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { ChangeOutcome } from "../../src/domain/index.js";
import { WIKI_CONFIG_FILE, WIKI_DB_FILE } from "../../src/paths.js";
import { loadConfig } from "../../src/config/index.js";
import { backupDatabase, closeStore, openStoreFor, seedChange } from "../../src/store/index.js";
import type { StaleFact } from "./cases.js";
import { RM_RETRIES, RM_RETRY_DELAY_MS } from "../../src/constants.js";

/** What `writeStaleFact` needs to know about the case. */
export interface StaleFactInput {
  /** The database the copy starts from. */
  source: string;
  /** The database to write; it is replaced. */
  target: string;
  fact: StaleFact;
  /** The file and line of the proof of the case; the justification of the wrong fact names them, so that it looks real. */
  proof: { file: string; line: number };
}

/**
 * Copies a wiki into a folder of the run with the SQLite backup, so that the given file is never opened for writing
 * and a live WAL file is read safely.
 *
 * @param dbPath - the wiki database to copy; with its `wikifact.json` next to it, when there is one
 * @param folder - the folder to copy into; created
 * @returns the path of the copy
 * @throws {Error} when the database does not exist or is not a database
 * @sideEffects reads `dbPath`; writes `<folder>/game.sqlite` and, when it exists next to `dbPath`, `<folder>/wikifact.json`
 */
export async function copyWiki(dbPath: string, folder: string): Promise<string> {
  mkdirSync(folder, { recursive: true });
  const target = join(folder, WIKI_DB_FILE);
  await backupDatabase(dbPath, target);
  copyConfig(dbPath, target);
  return target;
}

function copyConfig(fromDb: string, toDb: string): void {
  const from = join(dirname(fromDb), WIKI_CONFIG_FILE);
  if (existsSync(from)) copyFileSync(from, join(dirname(toDb), WIKI_CONFIG_FILE));
}

/**
 * Copies a database file that no process has open, with its config. A run copies the pristine copy this way, so that a
 * run never writes into a file another run reads.
 *
 * @param source - the database to copy
 * @param target - the new path; its folder is created
 * @sideEffects writes `target` and the config next to it
 */
export function copyDatabase(source: string, target: string): void {
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
  copyConfig(source, target);
}

/**
 * Removes the folder of a run copy.
 *
 * @param target - the database path of the copy
 * @sideEffects deletes the folder of `target`, which holds the database, its WAL files and its config
 */
export function removeDatabaseFolder(target: string): void {
  rmSync(dirname(target), { recursive: true, force: true, maxRetries: RM_RETRIES, retryDelay: RM_RETRY_DELAY_MS });
}

/**
 * Makes the copy of a "stale" case: the source plus one fact that is wrong on purpose, written as an accepted change
 * with a justification that cites the proof file, like the other facts of the wiki.
 *
 * @param input - the source, the target, the wrong fact and the proof of the case
 * @returns once the target holds the fact
 * @throws {Error} when the source is not a wiki database of this schema
 * @sideEffects writes `input.target` (replacing it) and the config next to it; opens it as a store and runs the embedder for the fact
 */
export async function writeStaleFact(input: StaleFactInput): Promise<void> {
  const { source, target, fact, proof } = input;
  copyDatabase(source, target);
  const config = loadConfig(target);
  const store = openStoreFor(config, target);
  try {
    const justification = fact.justification ?? `Stated in ${proof.file} at line ${proof.line}.`;
    await seedChange(
      store,
      {
        outcome: ChangeOutcome.Accepted,
        summary: fact.header,
        changeReasoning: justification,
        facts: [{ header: fact.header, content: fact.content, justification, references: [] }],
      },
      { change: fact.content, justification },
    );
  } finally {
    closeStore(store);
  }
}
