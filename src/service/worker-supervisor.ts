// technical/deployment.md, "Worker restart": starts a new worker child when one exits without a request to stop.
import { LogEvent, LogLevel, WorkerChildState } from "../domain/enums.js";
import type { Logger } from "../log/index.js";
import type { WorkerChild } from "../mcp/worker-child.js";
import { BACKOFF_FACTOR } from "../constants.js";

/** The delay before the first restart, in ms: 5 seconds. */
export const RESTART_DELAY_MS = 5_000;

/** The longest delay before a restart, in ms: 5 minutes. The delay doubles with each exit in a row up to this. */
export const RESTART_DELAY_MAX_MS = 300_000;

/** A child that ran this long, in ms (10 minutes), resets the delay to `RESTART_DELAY_MS` for its next exit. */
export const RESTART_RESET_MS = 600_000;

/** The options of `superviseWorker`. */
export interface SupervisorOptions {
  /** The wiki name, for the log line. */
  wiki: string;
  /** Starts one worker child. */
  start: () => WorkerChild;
  /** Adds 1 to the count of restarts of the wiki and returns the count after the addition. */
  countRestart: () => number;
  log: Logger;
}

/**
 * Runs a worker child and starts a new one after each exit that nobody asked for.
 *
 * @param opts - the wiki name, the function that starts a child, the restart counter and the logger
 * @returns a `WorkerChild` that stands for the current child: `child` and `exited` follow the newest child, `started`
 *   is that of the first child, and `stop` ends the child and every later restart. A first child that exits inside its
 *   start window (another process holds the lock) is not restarted
 * @sideEffects starts the first child at once; after an unrequested exit logs one `LogEvent.WorkerRestart` line at
 *   level error, counts the restart, and starts a timer for the delay; the timer starts the next child; `stop` kills
 *   the child and clears the timer
 */
export function superviseWorker(opts: SupervisorOptions): WorkerChild {
  let current = opts.start();
  const first = current;
  // The flag of a stop that the registry asked for: the `exit` handler reads it and starts no child.
  let stopped = false;
  let delayMs = RESTART_DELAY_MS;
  let timer: NodeJS.Timeout | undefined;

  const watch = (child: WorkerChild, startedAt: number): void => {
    void child.exited.then(async () => {
      const state = await child.started;
      if (stopped) return;
      // The first child that ends inside its start window found the lock held: the worker runs elsewhere.
      if (child === first && state === WorkerChildState.Exited) return;
      if (Date.now() - startedAt >= RESTART_RESET_MS) delayMs = RESTART_DELAY_MS;
      const wait = delayMs;
      delayMs = Math.min(delayMs * BACKOFF_FACTOR, RESTART_DELAY_MAX_MS);
      opts.log({
        event: LogEvent.WorkerRestart,
        level: LogLevel.Error,
        wiki: opts.wiki,
        code: child.child.exitCode,
        signal: child.child.signalCode,
        delayMs: wait,
        restarts: opts.countRestart(),
      });
      timer = setTimeout(() => {
        timer = undefined;
        if (stopped) return;
        current = opts.start();
        watch(current, Date.now());
      }, wait);
    });
  };
  watch(current, Date.now());

  return {
    get child() {
      return current.child;
    },
    started: first.started,
    get exited() {
      return current.exited;
    },
    stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      current.stop();
    },
  };
}
