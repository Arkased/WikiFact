// technical/publication.md, "The demo copy": a clean copy of the live store, as a file in a temp folder.
import { join } from "node:path";
import { loadConfig } from "../../src/config/index.js";
import {
  anonymizeStore,
  backupDatabase,
  closeStore,
  compactStore,
  listTextCells,
  openStore,
  rebuildFullText,
} from "../../src/store/index.js";
import { applyPairs, findTerms, scanTerms, type PrivateTerms, type TermHit } from "./export-terms.js";

/** Where the demo copy lies in the public tree. */
export const DEMO_DIR = "demo/wikifact";

/** The demo copy that `buildDemoCopy` made. */
export interface DemoCopy {
  /** The copy; the caller moves it. */
  dbPath: string;
  /** The `subject` of the live `wikifact.json`. */
  subject: string;
  /** The embedding model of the live wiki, which the copy was made with. */
  embeddingModel: string;
  /** The private terms in the text columns of the copy; when not empty the file is not compacted. */
  hits: TermHit[];
}

/**
 * Makes the demo copy: a backup of the live store without the use rows, with the pairs applied, the full-text index
 * rebuilt and the private terms scanned, then compacted when the scan is clean.
 *
 * @param source - the live database file; never written
 * @param workDir - an existing folder for the copy
 * @param terms - the private terms
 * @returns the copy, the live `subject` and `embeddingModel`, and the hits of the scan
 * @throws {Error} when the source is missing or is not a wiki, or its `wikifact.json` is invalid
 * @sideEffects reads the source and its `wikifact.json` and the presets file; writes `game.sqlite` in `workDir`
 */
export async function buildDemoCopy(source: string, workDir: string, terms: PrivateTerms): Promise<DemoCopy> {
  const config = loadConfig(source);
  const dbPath = join(workDir, "game.sqlite");
  await backupDatabase(source, dbPath);
  const store = openStore(dbPath, { embeddingModel: config.embeddingModel });
  try {
    anonymizeStore(store, (text) => applyPairs(text, terms.pairs));
    rebuildFullText(store);
    const needles = scanTerms(terms);
    const hits = listTextCells(store).flatMap((cell) =>
      findTerms(cell.value, needles).map((h) => ({
        where: `${cell.table}.${cell.column} rowid ${cell.rowid}`,
        term: h.term,
      })),
    );
    if (hits.length === 0) compactStore(store);
    return { dbPath, subject: config.subject, embeddingModel: config.embeddingModel, hits };
  } finally {
    closeStore(store);
  }
}
