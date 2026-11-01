// technical/deployment.md, "Service mode": the `.archive/` folder of a wikis root. A wiki that `archiveWiki` keeps sits at
// `<wikis>/.archive/<name>-<stamp>/`.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import pRetry from "p-retry";
import { errnoCode } from "../must.js";
import { stamp, unstamp } from "../time.js";
import { FolderLockedError } from "./errors.js";

/** The folder of a wikis root that holds the archived wikis. Discovery never mounts it. */
export const ARCHIVE_DIR = ".archive";

/** How often a move or a removal is tried while the database file is still held. */
const MOVE_ATTEMPTS = 6;

/** The pause between 2 tries, in milliseconds. */
const MOVE_RETRY_DELAY_MS = 250;

/** The error codes of a file that another handle still holds (Windows keeps a closed SQLite file for a moment). */
const LOCK_CODES = new Set(["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"]);

/** The length of a stamp such as `2026-10-10T04-07-29.171Z`. */
const STAMP_LENGTH = 24;

/** One archived wiki. */
export interface ArchiveInfo {
  /** The wiki name. */
  name: string;
  /** The folder name under `.archive/`: `<name>-<stamp>`. */
  folder: string;
  /** When it was archived, as an ISO time. */
  archivedAt: string;
}

/**
 * Names the archive folder of a wiki.
 *
 * @param name - the wiki name
 * @param date - the archive time; defaults to now
 * @returns `<name>-<stamp>`
 * @sideEffects reads the clock when `date` is omitted
 */
export function archiveFolderName(name: string, date?: Date): string {
  return `${name}-${stamp(date)}`;
}

/**
 * Splits an archive folder name into the wiki name and the archive time.
 *
 * @param folder - a folder name under `.archive/`
 * @returns the parts, or `undefined` when the name does not end in a stamp
 * @sideEffects none
 */
function parseArchiveFolder(folder: string): ArchiveInfo | undefined {
  const cut = folder.length - STAMP_LENGTH - 1;
  if (cut < 1 || folder[cut] !== "-") return undefined;
  const archivedAt = unstamp(folder.slice(cut + 1));
  return archivedAt === undefined ? undefined : { name: folder.slice(0, cut), folder, archivedAt };
}

/**
 * Lists the archived wikis of a wikis root.
 *
 * @param wikisDir - the wikis root
 * @returns one row per archive folder, sorted by name and then newest first; an empty list when there is no `.archive/`
 * @sideEffects reads the `.archive/` folder
 */
export function listArchives(wikisDir: string): ArchiveInfo[] {
  const root = join(wikisDir, ARCHIVE_DIR);
  if (!existsSync(root)) return [];
  const found: ArchiveInfo[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const info = entry.isDirectory() ? parseArchiveFolder(entry.name) : undefined;
    if (info) found.push(info);
  }
  return found.sort((a, b) =>
    a.name !== b.name
      ? a.name < b.name
        ? -1
        : 1
      : a.archivedAt < b.archivedAt
        ? 1
        : a.archivedAt > b.archivedAt
          ? -1
          : 0,
  );
}

/**
 * Finds the archive to restore.
 *
 * @param wikisDir - the wikis root
 * @param name - a wiki name (the newest archive of it wins) or a full folder name `<name>-<stamp>`
 * @returns the archive and how many archives share its wiki name; `undefined` when none matches
 * @sideEffects reads the `.archive/` folder
 */
export function findArchive(wikisDir: string, name: string): { archive: ArchiveInfo; sameName: number } | undefined {
  const all = listArchives(wikisDir);
  const exact = all.find((a) => a.folder === name);
  const archive = exact ?? all.find((a) => a.name === name);
  return archive ? { archive, sameName: all.filter((a) => a.name === archive.name).length } : undefined;
}

/**
 * Runs a file operation again while the file is held by another handle.
 *
 * @param op - the move or the removal
 * @param what - what the operation does, for the error message
 * @returns when the operation succeeded
 * @throws {FolderLockedError} when the file stays locked after every try
 * @throws {Error} the first error that is not a lock
 * @sideEffects whatever `op` does; waits between tries
 */
export async function retryWhileLocked(op: () => void, what: string): Promise<void> {
  const isLock = (e: unknown): boolean => LOCK_CODES.has(errnoCode(e) ?? "");
  try {
    await pRetry(op, {
      retries: MOVE_ATTEMPTS - 1,
      minTimeout: MOVE_RETRY_DELAY_MS,
      factor: 1, // a fixed pause
      shouldRetry: ({ error }) => isLock(error),
    });
  } catch (e) {
    if (!isLock(e)) throw e;
    throw new FolderLockedError(
      `could not ${what}: the folder is still locked by another process (${errnoCode(e)}). Try again in a moment.`,
    );
  }
}
