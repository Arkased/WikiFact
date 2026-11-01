// technical/deployment.md, "Local mode": `serve --with-worker` runs the worker as a child process of the server.
// The child takes the lock file like any worker. If it exits at once, another process holds the lock.
import { spawn, type ChildProcess } from "node:child_process";
import { basename, dirname, resolve } from "node:path";
import { LogEvent, LogLevel, WorkerChildState } from "../domain/enums.js";
import type { Logger } from "../log/index.js";

/** An exit inside this window after the spawn counts as "at once". Milliseconds. */
const START_WINDOW_MS = 3000;

/** A program to spawn and its arguments. */
export interface WorkerCommand {
  file: string;
  args: string[];
}

/** The worker child process and the means to wait for its start and to stop it. */
export interface WorkerChild {
  child: ChildProcess;
  /** Resolves "running" when the child lives past the window, "exited" when it ended inside it. */
  started: Promise<WorkerChildState.Running | WorkerChildState.Exited>;
  /** Resolves when the child has exited or failed to spawn; never rejects. */
  exited: Promise<void>;
  /** Ends the child if it still runs. */
  stop(): void;
}

/** The options of `startWorkerChild`. */
export interface WorkerChildOptions {
  /** The database path that the worker opens. */
  db: string;
  /** Receives the typed log lines about the child. */
  log: Logger;
  /** The `--log-dir` to pass to the child, so that it writes `worker-<wiki>` files there. Absent: the child logs to stderr. */
  logDir?: string;
  /** The program to spawn. Default: this binary's `worker` command for `db`. */
  command?: WorkerCommand;
  /** An exit inside this window counts as "at once". */
  windowMs?: number;
}

/**
 * Builds the command that runs this binary's `worker` command.
 *
 * @param db - the database path to pass to the worker
 * @param logDir - the log directory to pass as `--log-dir`; absent means none
 * @returns the current Node binary with the entry script and `worker --db <db>` (and `--log-dir`); the script is
 *   `""` when `argv[1]` is absent
 * @sideEffects reads `process.execPath` and `process.argv`
 */
export function workerCommand(db: string, logDir?: string): WorkerCommand {
  const logArgs = logDir === undefined ? [] : ["--log-dir", logDir];
  return { file: process.execPath, args: [process.argv[1] ?? "", "worker", "--db", db, ...logArgs] };
}

/**
 * Names the wiki of a database: the name of its folder. The log files of its worker are `worker-<wiki>`.
 *
 * @param db - the database path
 * @returns the folder name
 * @sideEffects reads the working directory to resolve a relative path
 */
export function wikiNameOf(db: string): string {
  return basename(dirname(resolve(db)));
}

/**
 * Starts the worker as a child process of the server and reports whether it stays up.
 *
 * @param opts - the database, the logger, an optional command and the start window in ms (default 3000)
 * @returns the child, a promise that resolves `Running` when it lives past the window and `Exited` when it ends or
 *   fails to spawn inside it (never rejects), and a `stop` that is safe to call twice
 * @sideEffects spawns a child process (stdout ignored, stderr inherited); starts a timer for the window; logs
 *   `LogEvent.WorkerChild` lines through `opts.log` on start, spawn failure and exit; `stop` kills the child
 */
export function startWorkerChild(opts: WorkerChildOptions): WorkerChild {
  const { file, args } = opts.command ?? workerCommand(opts.db, opts.logDir);
  const child = spawn(file, args, { stdio: ["ignore", "ignore", "inherit"], windowsHide: true });
  let live = true;
  // A child that the server stops itself exits on purpose; that is not an error line.
  let stopping = false;
  let settled = false;
  let resolveStarted: (v: WorkerChildState.Running | WorkerChildState.Exited) => void = () => undefined;
  const started = new Promise<WorkerChildState.Running | WorkerChildState.Exited>((resolve) => {
    resolveStarted = resolve;
  });
  let resolveExited: () => void = () => undefined;
  const exited = new Promise<void>((resolve) => {
    resolveExited = resolve;
  });

  const timer = setTimeout(() => {
    if (!settled) {
      settled = true;
      opts.log({ event: LogEvent.WorkerChild, level: LogLevel.Info, state: WorkerChildState.Running, pid: child.pid });
      resolveStarted(WorkerChildState.Running);
    }
  }, opts.windowMs ?? START_WINDOW_MS);

  child.on("error", (e) => {
    live = false;
    resolveExited();
    clearTimeout(timer);
    opts.log({
      event: LogEvent.WorkerChild,
      level: LogLevel.Error,
      state: WorkerChildState.NotRunning,
      reason: `spawn failed: ${e.message}`,
    });
    if (!settled) {
      settled = true;
      resolveStarted(WorkerChildState.Exited);
    }
  });
  child.on("exit", (code, signal) => {
    live = false;
    resolveExited();
    clearTimeout(timer);
    if (!settled) {
      settled = true;
      opts.log({
        event: LogEvent.WorkerChild,
        level: LogLevel.Error,
        state: WorkerChildState.NotRunning,
        reason:
          "exited at once: another process holds the lock, or the worker could not start (see its message above). Serving without a child.",
        code,
        signal,
      });
      resolveStarted(WorkerChildState.Exited);
    } else {
      opts.log({
        event: LogEvent.WorkerChild,
        level: stopping ? LogLevel.Info : LogLevel.Error,
        state: WorkerChildState.Exited,
        code,
        signal,
      });
    }
  });

  return {
    child,
    started,
    exited,
    stop() {
      if (live) {
        live = false;
        stopping = true;
        // SIGTERM on POSIX. On Windows Node ends the process.
        child.kill();
      }
    },
  };
}
