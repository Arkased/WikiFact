import { LogEvent, LogLevel } from "../domain/enums.js";
import type { Logger } from "../log/index.js";

/** The exit code of a usage error. */
export const EXIT_USAGE = 2;

/** The exit code of a command that refuses to run, for example a local-mode wiki on a non-loopback host. */
export const EXIT_REFUSED = 1;

/** The arguments that the command line passes to every command. */
export interface CommandArgs {
  /** The database path (`--db`, else the default). */
  db: string;
  /** The positional arguments after the command name. */
  rest: string[];
  /** The port of `--http`. */
  http?: number;
  /** `--with-worker` was given. */
  withWorker?: boolean;
  /** The address of `--host`; `serve` defaults to the loopback. */
  host?: string;
  /** The wikis folder of `--wikis` (service mode); excludes `--db`. */
  wikis?: string;
  /** The `--max-wikis` cap of service mode. */
  maxWikis?: number;
  /** The log directory of the process: `--log-dir`, or `<wikis>/.logs` in service mode. Absent means stderr. */
  logDir?: string;
  /** The logger of the process, made by the command line from `logDir`. Absent means a stderr logger. */
  log?: Logger;
}

/** One command of the command line: its name, its help text and the function that runs it. */
export interface Command {
  name: string;
  description: string;
  run(args: CommandArgs): Promise<void>;
}

/**
 * Reports a refused start and sets the exit code. A process that logs to files logs a `LogEvent.Refused` line and
 * writes nothing to stderr; any other process writes the message to stderr.
 *
 * @param args - the command arguments: `logDir` and `log` decide where the message goes
 * @param message - why the command does not start
 * @param log - the logger to use when the process logs to files
 * @sideEffects writes to stderr or logs one line; sets `process.exitCode` to `EXIT_REFUSED`
 */
export function refuse(args: Pick<CommandArgs, "logDir">, message: string, log: Logger): void {
  if (args.logDir === undefined) process.stderr.write(`${message}\n`);
  else log({ event: LogEvent.Refused, level: LogLevel.Error, reason: message });
  process.exitCode = EXIT_REFUSED;
}
