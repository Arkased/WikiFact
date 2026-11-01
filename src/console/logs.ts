// technical/console.md, "Health" and "Request": the log tail reader. It reads the JSON lines of a process's log files (technical/deployment.md, "Logging") from
// the end, newest first, across the active file and the rolled ones, so that a tail or a request trace costs a few
// chunks of a 10 MB file and not a full read. The file names come from `logBaseName` of `src/log/`: `<base>.<n>.log`,
// where `<n>` grows with time, and `<base>-errors.<n>.log` for the warn and error lines.
import { closeSync, fstatSync, openSync, readSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { LogFile, LogLevel, LogProcess, ServeTarget, assertNever, isMember } from "../domain/enums.js";
import { logBaseName } from "../log/index.js";
import { errnoCode } from "../must.js";

/** Lines a tail returns when `limit` is absent. */
export const DEFAULT_TAIL_LINES = 200;
/** The most lines a tail returns (technical/console.md, "Routes"). */
export const MAX_TAIL_LINES = 2000;
/** Bytes read per step from the end of a file. */
const CHUNK_BYTES = 64 * 1024;
const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;

/** A JSON object line of a log file, before its fields are typed. */
const logObject = z.record(z.string(), z.unknown());

/** One JSON line of a log file, parsed. The typed fields are null when the line lacks them or they do not parse. */
export interface LogRecord {
  /** `ts`, in ms since the epoch. */
  ts: number | null;
  event: string | null;
  level: LogLevel | null;
  /** The `request_id` field. */
  requestId: string | null;
  /** Every other field of the line. */
  fields: Record<string, unknown>;
  /** The line as written. */
  text: string;
}

/** A line of a log file that is not a JSON object. */
export interface RawLogLine {
  raw: string;
}

/** One line of a tail. */
export type LogTailLine = LogRecord | RawLogLine;

/**
 * Tells whether a tail line is a raw (non-JSON) line.
 *
 * @param line - a line of a tail
 * @returns true for a `RawLogLine`
 * @sideEffects none
 */
export function isRawLine(line: LogTailLine): line is RawLogLine {
  return "raw" in line;
}

/** The filters of `readLogTail`. A line must match every filter given. */
export interface LogTailOptions {
  /** Lines to return, 1 to `MAX_TAIL_LINES`; default `DEFAULT_TAIL_LINES`. A larger value is capped. */
  limit?: number;
  level?: LogLevel;
  /** Keep lines with a `ts` at or after this time, in ms since the epoch. A raw line has no time and is dropped. */
  since?: number;
  /** A case-insensitive substring of the line text. */
  q?: string;
  /** Keep lines whose `request_id` is this id. A raw line is dropped. */
  request?: string;
}

/** What `readLogTail` returns. */
export interface LogTail {
  /** The matching lines, newest first. */
  items: LogTailLine[];
  /** Why the tail may be short: no log directory, or no file of this process yet. */
  note?: string;
}

/** The note of a tail without a log directory. */
export const NO_LOG_DIR_NOTE = "no log directory";

// The process behind the `service` file of the console: the service of `--wikis`, or the one-database server.
function serviceProcess(target: ServeTarget): LogProcess {
  switch (target) {
    case ServeTarget.Wikis:
      return LogProcess.Service;
    case ServeTarget.Db:
      return LogProcess.Serve;
  }
  return assertNever(target);
}

/**
 * Names the log file set a console read means (technical/console.md, "Health"), before the file number and the extension.
 *
 * @param file - the file of the query: the service's or the wiki's worker's
 * @param target - what `serve` serves; the service file of a `--db` server is `serve`, that of `--wikis` is `service`
 * @param wiki - the wiki name, for the worker's files
 * @returns the base name, as `logBaseName` of `src/log/` writes it
 * @sideEffects none
 */
export function logBaseFor(file: LogFile, target: ServeTarget, wiki: string): string {
  switch (file) {
    case LogFile.Service:
      return logBaseName(serviceProcess(target));
    case LogFile.Worker:
      return logBaseName(LogProcess.Worker, wiki);
  }
  return assertNever(file);
}

// The files `<base>.<n>.log` of a directory, newest (highest `n`) first; a file without a number counts as newest.
function logFiles(dir: string, base: string): string[] {
  const pattern = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}(?:\\.(\\d+))?\\.log$`);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (e) {
    if (errnoCode(e) === "ENOENT" || errnoCode(e) === "ENOTDIR") return [];
    throw e;
  }
  const numbered = names
    .map((name) => ({ name, match: pattern.exec(name) }))
    .filter((f) => f.match !== null)
    .map((f) => ({ name: f.name, n: f.match?.[1] === undefined ? Number.POSITIVE_INFINITY : Number(f.match[1]) }));
  return numbered.sort((a, b) => b.n - a.n).map((f) => join(dir, f.name));
}

/**
 * Reads the lines of a file from its end, in chunks.
 *
 * Hand-rolled (code-standard section 5): no maintained library reads a file backwards by lines under a byte budget
 * (the tail packages read the whole file or follow its growth), and the logic is this one loop over the chunks.
 *
 * @param path - the file
 * @param onLine - gets each non-empty line, last line first; returns true to stop
 * @returns true when `onLine` stopped the read
 * @sideEffects reads the file
 */
function readLinesFromEnd(path: string, onLine: (line: string) => boolean): boolean {
  const fd = openSync(path, "r");
  try {
    let pos = fstatSync(fd).size;
    let carry = Buffer.alloc(0);
    const emit = (bytes: Buffer): boolean => {
      const end = bytes.at(-1) === CARRIAGE_RETURN ? bytes.length - 1 : bytes.length;
      return end === 0 ? false : onLine(bytes.toString("utf8", 0, end));
    };
    while (pos > 0) {
      const len = Math.min(CHUNK_BYTES, pos);
      pos -= len;
      const chunk = Buffer.alloc(len);
      readSync(fd, chunk, 0, len, pos);
      const buf = Buffer.concat([chunk, carry]);
      let end = buf.length;
      for (let i = buf.length - 1; i >= 0; i--) {
        if (buf[i] !== NEWLINE) continue;
        if (emit(buf.subarray(i + 1, end))) return true;
        end = i;
      }
      carry = buf.subarray(0, end);
    }
    return emit(carry);
  } finally {
    closeSync(fd);
  }
}

/**
 * Parses one line of a log file.
 *
 * @param text - the line
 * @returns the record, or a raw line when the text is not a JSON object
 * @sideEffects none
 */
export function parseLogLine(text: string): LogTailLine {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { raw: text };
  }
  const object = logObject.safeParse(parsed);
  if (!object.success || Array.isArray(parsed)) return { raw: text };
  const { ts, event, level, request_id: requestId, ...fields } = object.data;
  const time = typeof ts === "string" ? Date.parse(ts) : Number.NaN;
  return {
    ts: Number.isNaN(time) ? null : time,
    event: typeof event === "string" ? event : null,
    level: isMember(LogLevel, level) ? level : null,
    requestId: typeof requestId === "string" ? requestId : null,
    fields,
    text,
  };
}

function matches(line: LogTailLine, opts: LogTailOptions, q: string | undefined): boolean {
  if (q !== undefined && !(isRawLine(line) ? line.raw : line.text).toLowerCase().includes(q)) return false;
  if (isRawLine(line)) return opts.level === undefined && opts.since === undefined && opts.request === undefined;
  if (opts.level !== undefined && line.level !== opts.level) return false;
  if (opts.since !== undefined && (line.ts === null || line.ts < opts.since)) return false;
  if (opts.request !== undefined && line.requestId !== opts.request) return false;
  return true;
}

/**
 * Walks the lines of a process's log files newest first, from the active file into the rolled ones, and stops at
 * the first line older than `since`, because a file is written in time order.
 *
 * @param dir - the log directory
 * @param base - the file name before the number
 * @param since - the oldest time wanted, in ms since the epoch; absent for no bound
 * @param onLine - gets each parsed line; returns true to stop
 * @returns the number of files found
 * @sideEffects reads the directory and the files
 */
function walkLines(
  dir: string,
  base: string,
  since: number | undefined,
  onLine: (line: LogTailLine) => boolean,
): number {
  const files = logFiles(dir, base);
  for (const path of files) {
    const stopped = readLinesFromEnd(path, (text) => {
      const line = parseLogLine(text);
      if (since !== undefined && !isRawLine(line) && line.ts !== null && line.ts < since) return true;
      return onLine(line);
    });
    if (stopped) break;
  }
  return files.length;
}

/**
 * Reads the last lines of a process's log that match the filters (technical/console.md, "Routes", the health route).
 *
 * @param dir - the log directory; absent when the process logs to stderr
 * @param base - the file name before the number, from `logBaseFor`
 * @param opts - the filters and the limit
 * @returns the matching lines newest first, at most `limit`; empty with a note when there is no log directory or
 *   no file of the process
 * @sideEffects reads the log directory and the files it needs
 */
export function readLogTail(dir: string | undefined, base: string, opts: LogTailOptions = {}): LogTail {
  if (dir === undefined) return { items: [], note: NO_LOG_DIR_NOTE };
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? DEFAULT_TAIL_LINES)), MAX_TAIL_LINES);
  const q = opts.q === undefined || opts.q === "" ? undefined : opts.q.toLowerCase();
  const items: LogTailLine[] = [];
  const files = walkLines(dir, base, opts.since, (line) => {
    if (matches(line, opts, q)) items.push(line);
    return items.length >= limit;
  });
  return files === 0 ? { items, note: `no ${base} log file` } : { items };
}
