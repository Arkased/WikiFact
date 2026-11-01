// A lock that is a server listening on a named pipe. The OS frees the name when the process ends, however it ends, so
// the lock has no file, no pid, no stale state and no take-over. The check lock (`scripts/check.ts`) uses it.
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:net";
import { errnoCode } from "../../src/must.js";

/** The number of hex digits of the hash in a pipe name. */
const HASH_LENGTH = 16;

/** The inputs of `takePipeLock`; the wait is injected so that a test needs no real wait. */
export interface PipeLockOptions {
  /** The name to listen on, from `pipeName`. */
  name: string;
  /** Waits the given milliseconds. */
  sleep: (ms: number) => Promise<void>;
  /** The wait between two looks at a held name, in milliseconds. */
  retryMs: number;
  /** Called once, the first time the name is found held. */
  onWait?: () => void;
}

/**
 * Derives a pipe name from the common git folder, so that all worktrees of a repo share one name.
 *
 * @param purpose - the lock, for example `check`
 * @param commonDir - the absolute path of the common git folder
 * @param projectName - the name of the project from the config; it goes into the name in lower case
 * @returns the named pipe `\\.\pipe\<project name>-<purpose>-<16 hex of the sha256 of the folder>`
 * @sideEffects none
 */
export function pipeName(purpose: string, commonDir: string, projectName: string): string {
  const hash = createHash("sha256").update(commonDir).digest("hex").slice(0, HASH_LENGTH);
  return `\\\\.\\pipe\\${projectName.toLowerCase()}-${purpose}-${hash}`;
}

function listenOn(name: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => socket.destroy());
    server.once("error", reject);
    server.listen(name, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

/**
 * Takes a lock by listening on a pipe name, waiting while a live process holds it.
 *
 * @param options - the name, the wait, the retry interval and the callback on the first wait
 * @returns the listening server; closing it, or the end of the process, frees the lock
 * @throws {Error} when the server cannot listen for a reason other than that the name is in use
 * @sideEffects listens on a named pipe; sleeps with `sleep` while the name is held, without a limit; calls `onWait`
 *   once when it waits
 */
export async function takePipeLock(options: PipeLockOptions): Promise<Server> {
  const { name, sleep, retryMs, onWait } = options;
  let notified = false;
  for (;;) {
    try {
      return await listenOn(name);
    } catch (error) {
      if (errnoCode(error) !== "EADDRINUSE") throw error;
    }
    if (!notified) {
      onWait?.();
      notified = true;
    }
    await sleep(retryMs);
  }
}
