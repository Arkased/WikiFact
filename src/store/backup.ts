import Database from "better-sqlite3";
import { MetaKey, RequestKind, RequestStatus } from "../domain/enums.js";

/**
 * Copies a database file with the SQLite online backup. It never calls `openStore`: `openStore` migrates the file it
 * opens, which would raise the schema of a wiki that a deployed service still serves on an older schema and make that
 * service refuse it. The source is opened read-only and the backup is safe on a live WAL database.
 *
 * @param from - the source database; never written
 * @param to - the copy; created or overwritten
 * @returns once the copy is complete
 * @throws {Error} when `from` does not exist or is not a database
 * @sideEffects reads `from` (a read-only connection; SQLite may create `-wal` and `-shm` files next to a WAL
 *   database); writes `to`
 */
export async function backupDatabase(from: string, to: string): Promise<void> {
  const src = new Database(from, { readonly: true, fileMustExist: true });
  try {
    await src.backup(to);
  } finally {
    src.close();
  }
}

/**
 * Reads the schema version of a database file without opening it as a store (no migration, no write).
 *
 * @param path - the database file
 * @returns the number in `meta.schema_version`, or null when the file has no such row, no `meta` table, is not a
 *   database, or the value is not a number
 * @throws {Error} when the file does not exist
 * @sideEffects reads the file through a read-only connection (see `backupDatabase` for the side files)
 */
export function readSchemaVersion(path: string): number | null {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(MetaKey.SchemaVersion) as
      { value: string } | undefined;
    const n = Number(row?.value);
    return row !== undefined && Number.isInteger(n) ? n : null;
  } catch {
    return null; // no `meta` table: not a wiki database
  } finally {
    db.close();
  }
}

/** What `readSourceContent` reads of a wiki file. */
export interface SourceContent {
  /** True when `meta` holds the marker of a wiki that `npm run eval:bulk-wiki` built. */
  bulkTestWiki: boolean;
  /** The change text of each queued submission, in queue order. */
  queuedSubmissions: string[];
}

/**
 * Reads the bulk-test marker and the queued submissions of a database file without opening it as a store, so a wiki
 * on an older schema than this code can be read, as `backupDatabase` copies it. Submissions share one rank in the queue, so
 * the order is by arrival (`received_at`, then `rowid`).
 *
 * @param path - the database file
 * @returns whether the file holds the bulk-test marker, and the change text of each queued submission
 * @throws {Error} when the file does not exist or holds no wiki tables
 * @sideEffects reads the file through a read-only connection (see `backupDatabase` for the side files)
 */
export function readSourceContent(path: string): SourceContent {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const marker = db.prepare("SELECT 1 FROM meta WHERE key = ?").get(MetaKey.BulkTestWiki);
    const queued = db
      .prepare("SELECT change FROM change_requests WHERE status = ? AND kind = ? ORDER BY received_at, rowid")
      .all(RequestStatus.Queued, RequestKind.Submission) as { change: string | null }[];
    return { bulkTestWiki: marker !== undefined, queuedSubmissions: queued.map((q) => q.change ?? "") };
  } finally {
    db.close();
  }
}
