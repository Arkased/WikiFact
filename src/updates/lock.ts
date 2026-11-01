// technical/deployment.md, "Install and run": one worker per database, held by a lock file `<db>.lock`.
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { errnoCode } from "../must.js";

/** Thrown when another live worker holds the lock of the database. */
export class LockError extends Error {}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return errnoCode(e) === "EPERM";
  }
}

/**
 * Takes `<db>.lock` with an exclusive open. A second worker gets a LockError.
 * A lock file whose process is gone (a crash) is stale: it is removed and taken again.
 *
 * @param dbPath - the database file whose lock to take
 * @param onTakeover - called with the pid of the dead owner when a stale lock is removed
 * @returns the function that removes the lock; calling it twice is safe, and it removes the file only when it still
 *   holds this process's pid
 * @throws {LockError} when a live process holds the lock, or the stale lock could not be cleared in one retry
 * @throws {Error} when the lock file cannot be created or read for a reason other than that it exists
 * @sideEffects creates the lock file `<db>.lock` with the pid in it; removes a stale lock file and calls
 *   `onTakeover`; the returned
 *   function closes and removes the file
 */
export function acquireLock(dbPath: string, onTakeover?: (stalePid: number) => void): () => void {
  const path = `${dbPath}.lock`;
  for (let tries = 0; ; tries++) {
    try {
      const fd = openSync(path, "wx");
      writeSync(fd, String(process.pid));
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          closeSync(fd);
        } catch {
          // already closed
        }
        try {
          if (existsSync(path) && readFileSync(path, "utf8").trim() === String(process.pid)) unlinkSync(path);
        } catch {
          // already removed
        }
      };
    } catch (e) {
      if (errnoCode(e) !== "EEXIST") throw e;
      const owner = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
      const stale = Number.isInteger(owner) && owner > 0 && !pidAlive(owner);
      if (!stale || tries > 0) {
        throw new LockError(
          `another worker holds ${path}${Number.isInteger(owner) ? ` (pid ${owner})` : ""}. Only one worker runs per database.`,
        );
      }
      unlinkSync(path);
      onTakeover?.(owner);
    }
  }
}
