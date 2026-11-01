// technical/deployment.md, "Logging": the file logger. `pino` writes the JSON lines; `pino-roll` rolls the files. `<name>.<n>.log` holds
// every line but the call lines; `<name>-errors.<n>.log` holds the `warn` and `error` lines; a worker's
// `<name>-calls.<n>.log` holds the `question_call` lines and no other line.
import { join, resolve } from "node:path";
import pino from "pino";
import pinoRoll, { type RollOptions, type RollStream } from "pino-roll";
import { LogEvent, LogLevel, LogProcess, assertNever } from "../domain/enums.js";
import { formatLine, type LogLine, type Logger } from "./line.js";
import { stderrLogger } from "./stderr.js";

/**
 * Names the log files of a process, before the file number and the extension: the one naming function that the CLI
 * writes with and the console reads with (technical/console.md, "Architecture").
 *
 * @param process - the process kind
 * @param wiki - the wiki name; required for a worker, ignored otherwise
 * @param calls - true for the call log of a worker (`worker-<wiki>-calls`)
 * @returns `serve`, `service`, `worker-<wiki>` or `worker-<wiki>-calls`
 * @throws {Error} for a worker without a wiki name, or for the call log of another process
 * @sideEffects none
 */
export function logBaseName(process: LogProcess, wiki?: string, calls = false): string {
  if (calls && process !== LogProcess.Worker) throw new Error("only a worker writes a call log");
  switch (process) {
    case LogProcess.Serve:
    case LogProcess.Service:
      return process;
    case LogProcess.Worker:
      if (wiki === undefined) throw new Error("a worker log is named after its wiki");
      return `${LogProcess.Worker}-${wiki}${calls ? "-calls" : ""}`;
  }
  return assertNever(process);
}

/** The size at which a file of the full log rolls, in megabytes. */
const LOG_MAX_MB = 10;
/** The `limit.count` of the full log: files kept in all, the active one included, so 5 files (50 MB). */
const LOG_FILES = 5;
/** The size at which a file of the errors log rolls, in megabytes. */
const ERRORS_MAX_MB = 10;
/** The `limit.count` of the errors log: files kept in all, the active one included, so 10 files (100 MB). */
const ERRORS_FILES = 10;

/** The size at which a file of the call log rolls, in megabytes. */
const CALLS_MAX_MB = 10;
/** The `limit.count` of the call log: files kept in all, the active one included, so 50 files (500 MB). */
const CALLS_FILES = 50;

// The loggers that write the call log: the question factory logs every call to such a logger, with no flag.
const callLoggers = new WeakSet<Logger>();

/**
 * Tells whether a logger writes the call log file.
 *
 * @param log - any logger
 * @returns true for a `fileLogger` made with a `callsName`
 * @sideEffects none
 */
export function writesCallLog(log: Logger): boolean {
  return callLoggers.has(log);
}

/** A logger that writes to files, and the means to stop it. */
export type FileLogger = Logger & {
  /** Flushes and closes the files: a line logged after `close` is dropped. */
  close(): void;
};

/**
 * Builds the pino-roll options of one log file.
 *
 * @param base - the path without the file number and the extension, e.g. `<dir>/service` or `<dir>/service-errors`
 * @param maxMb - megabytes per file before it rolls
 * @param files - files to keep in all, the active one included (pino-roll `limit.count`)
 * @returns the options: roll at `maxMb` (no time rule), keep `files` files (also those of earlier runs), create
 *   the folder, write synchronously so that the last line survives an exit
 * @sideEffects none
 */
export function rollOptions(base: string, maxMb: number, files: number): RollOptions {
  return {
    file: `${base}.log`,
    size: `${maxMb}m`,
    limit: { count: files, removeOtherLogFiles: true },
    mkdir: true,
    sync: true,
  };
}

/** The roll options of the full log and the errors log of a process. */
export interface FileLoggerRolls {
  full: RollOptions;
  errors: RollOptions;
}

/**
 * Builds the roll options of the two files of a process.
 *
 * @param dir - the log directory
 * @param name - the process name
 * @returns the options of `<name>` (10 MB per file, 5 files in all) and `<name>-errors` (10 MB per file, 10 files
 *   in all)
 * @sideEffects none
 */
export function fileLoggerRolls(dir: string, name: string): FileLoggerRolls {
  return {
    full: rollOptions(join(dir, name), LOG_MAX_MB, LOG_FILES),
    errors: rollOptions(join(dir, `${name}-errors`), ERRORS_MAX_MB, ERRORS_FILES),
  };
}

/** The options of `fileLogger`. */
export interface FileLoggerOptions {
  /** The directory of the files; created when absent. */
  dir: string;
  /** The process name: the files are `<name>.<n>.log` and `<name>-errors.<n>.log`. */
  name: string;
  /**
   * The base name of the call log (`logBaseName(..., true)`): when given, every `question_call` line goes to
   * `<callsName>.<n>.log` and to no other file. Absent means those lines go to the full log like any other.
   */
  callsName?: string;
}

/**
 * Makes a logger that writes JSON lines to the full log and, for `warn` and `error` lines, also to the errors log.
 * A line keeps the fields of `LogLine`: `ts` (ISO time), `event`, `level` (the name), then the payload. With a
 * `callsName`, the `question_call` lines go to the call log only, and not to the full log.
 *
 * @param opts - the directory, the process name and the optional call log name
 * @returns the logger, with a `close`
 * @throws {Error} when a file cannot be opened
 * @sideEffects creates the directory and the files; the logger appends to them, rolls and deletes old files, and
 *   reads the clock
 */
export async function fileLogger(opts: FileLoggerOptions): Promise<FileLogger> {
  const rolls = fileLoggerRolls(opts.dir, opts.name);
  const full: RollStream = await pinoRoll(rolls.full);
  const errors: RollStream = await pinoRoll(rolls.errors);
  const calls: RollStream | undefined =
    opts.callsName === undefined
      ? undefined
      : await pinoRoll(rollOptions(join(opts.dir, opts.callsName), CALLS_MAX_MB, CALLS_FILES));
  const logger = pino(
    {
      level: LogLevel.Info,
      base: null,
      messageKey: "message",
      // `ts` as an ISO string, in the place of pino's numeric `time`.
      timestamp: () => `,"ts":${JSON.stringify(new Date().toISOString())}`,
      formatters: { level: (label) => ({ level: label }) },
    },
    pino.multistream([
      { level: LogLevel.Info, stream: full },
      { level: LogLevel.Warn, stream: errors },
    ]),
  );
  let closed = false;
  const write = (line: LogLine): void => {
    if (closed) return;
    if (calls !== undefined && line.event === LogEvent.QuestionCall) {
      calls.write(formatLine(line, new Date()) + "\n");
      return;
    }
    const { level, ...rest } = line;
    switch (level) {
      case LogLevel.Error:
        logger.error(rest);
        return;
      case LogLevel.Warn:
        logger.warn(rest);
        return;
      case LogLevel.Info:
        logger.info(rest);
        return;
    }
  };
  const fileLog = Object.assign(write, {
    close(): void {
      if (closed) return;
      closed = true;
      full.end();
      errors.end();
      calls?.end();
    },
  });
  if (calls !== undefined) callLoggers.add(fileLog);
  return fileLog;
}

/** The options of `processLogger`. */
export interface ProcessLoggerOptions {
  /** The log directory (`--log-dir`); absent means stderr. */
  logDir?: string;
  /** The process name for the file names: `service`, `worker-<wiki>`. */
  name: string;
  /** The base name of the call log; only a worker has one. See `FileLoggerOptions.callsName`. */
  callsName?: string;
}

/** The logger of a process, and whether it writes to files. */
export interface ProcessLogger {
  log: Logger;
  /** True when `log` writes to files, so that nothing else goes to stderr. */
  toFiles: boolean;
  /** Closes the file logger; nothing for stderr. */
  close(): void;
}

/**
 * Makes the logger of a process: files in `logDir` when it is given, else stderr. A process that logs to files
 * writes one line to stderr that names the directory.
 *
 * @param opts - the log directory and the process name
 * @returns the logger, whether it writes to files, and a `close`
 * @throws {Error} when the log directory or a file cannot be created
 * @sideEffects with a `logDir`: what `fileLogger` does, and one `LogEvent.LogDir` line to stderr
 */
export async function processLogger(opts: ProcessLoggerOptions): Promise<ProcessLogger> {
  if (opts.logDir === undefined) return { log: stderrLogger(), toFiles: false, close: () => undefined };
  const dir = resolve(opts.logDir);
  const files = await fileLogger({ dir, name: opts.name, callsName: opts.callsName });
  stderrLogger()({
    event: LogEvent.LogDir,
    level: LogLevel.Info,
    dir,
    files: [
      `${opts.name}.<n>.log`,
      `${opts.name}-errors.<n>.log`,
      ...(opts.callsName === undefined ? [] : [`${opts.callsName}.<n>.log`]),
    ],
  });
  return { log: files, toFiles: true, close: () => files.close() };
}
