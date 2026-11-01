import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { LogEvent, LogFile, LogLevel, ServeTarget } from "../../domain/enums.js";
import {
  DEFAULT_TAIL_LINES,
  MAX_TAIL_LINES,
  NO_LOG_DIR_NOTE,
  isRawLine,
  logBaseFor,
  parseLogLine,
  readLogTail,
} from "../logs.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wikifact-logs-"));
});
const T = Date.parse("2026-10-11T10:00:00.000Z");
const MINUTE = 60_000;
/** The worker log of the wiki `alpha`, as the service names it. */
const WORKER = logBaseFor(LogFile.Worker, ServeTarget.Wikis, "alpha");
/** The service log of a `--wikis` service. */
const SERVICE = logBaseFor(LogFile.Service, ServeTarget.Wikis, "alpha");

function line(minute: number, fields: Record<string, unknown>): string {
  return JSON.stringify({ ts: new Date(T + minute * MINUTE).toISOString(), ...fields });
}

function write(name: string, lines: string[]): void {
  writeFileSync(join(dir, name), `${lines.join("\n")}\n`);
}

// The rolled file holds minutes 0 to 2, the active file minutes 3 to 6 with a non-JSON line between them.
function seedWorker(): void {
  write("worker-alpha.1.log", [
    line(0, { event: LogEvent.WorkerStart, level: LogLevel.Info }),
    line(1, { event: LogEvent.Change, level: LogLevel.Info, request_id: "r1", seq: 1 }),
    line(2, { event: LogEvent.AttemptFailed, level: LogLevel.Error, request_id: "r2", error: "boom" }),
  ]);
  write("worker-alpha.2.log", [
    line(3, { event: LogEvent.PriorQuery, level: LogLevel.Warn, request_id: "r1", result: "miss" }),
    "plain text that is not json",
    line(5, { event: LogEvent.Change, level: LogLevel.Info, request_id: "r3", seq: 2 }),
    line(6, { event: LogEvent.WorkerStop, level: LogLevel.Info }),
  ]);
  write("worker-alpha-errors.1.log", [line(2, { event: LogEvent.AttemptFailed, level: LogLevel.Error })]);
  write("worker-beta.1.log", [line(0, { event: LogEvent.WorkerStart, level: LogLevel.Info, request_id: "other" })]);
}

const events = (items: ReturnType<typeof readLogTail>["items"]): (string | null)[] =>
  items.map((l) => (isRawLine(l) ? "raw" : l.event));

describe("logBaseFor", () => {
  it("names the files as the CLI writes them: service or serve by the target, the worker by its wiki", () => {
    expect(logBaseFor(LogFile.Service, ServeTarget.Wikis, "alpha")).toBe("service");
    expect(logBaseFor(LogFile.Service, ServeTarget.Db, "alpha")).toBe("serve");
    expect(logBaseFor(LogFile.Worker, ServeTarget.Wikis, "alpha")).toBe("worker-alpha");
    expect(logBaseFor(LogFile.Worker, ServeTarget.Db, "demo")).toBe("worker-demo");
  });
});

describe("parseLogLine", () => {
  it("types the known fields and keeps the rest", () => {
    const rec = parseLogLine(line(1, { event: "change", level: "info", request_id: "r1", seq: 3 }));
    expect(rec).toMatchObject({ ts: T + MINUTE, event: "change", level: LogLevel.Info, requestId: "r1" });
    expect(isRawLine(rec) ? null : rec.fields).toEqual({ seq: 3 });
  });

  it("keeps a non-JSON line, an array and a bad level as raw or null", () => {
    expect(parseLogLine("hello")).toEqual({ raw: "hello" });
    expect(parseLogLine("[1]")).toEqual({ raw: "[1]" });
    expect(parseLogLine("42")).toEqual({ raw: "42" });
    const rec = parseLogLine(JSON.stringify({ ts: "nope", level: "loud" }));
    expect(rec).toMatchObject({ ts: null, level: null, event: null, requestId: null });
  });
});

describe("readLogTail", () => {
  it("says so without a log directory", () => {
    expect(readLogTail(undefined, WORKER)).toEqual({ items: [], note: NO_LOG_DIR_NOTE });
  });

  it("notes a process without a file, and a directory that does not exist", () => {
    expect(readLogTail(dir, SERVICE).note).toBe("no service log file");
    expect(readLogTail(join(dir, "missing"), WORKER).note).toBe("no worker-alpha log file");
  });

  it("reads newest first across the active and the rolled file, the raw line kept", () => {
    seedWorker();
    const tail = readLogTail(dir, WORKER);
    expect(tail.note).toBeUndefined();
    expect(events(tail.items)).toEqual([
      LogEvent.WorkerStop,
      LogEvent.Change,
      "raw",
      LogEvent.PriorQuery,
      LogEvent.AttemptFailed,
      LogEvent.Change,
      LogEvent.WorkerStart,
    ]);
    const raw = tail.items[2];
    expect(raw !== undefined && isRawLine(raw) ? raw.raw : null).toBe("plain text that is not json");
  });

  it("stops at the limit, which stays inside 1 to the max", () => {
    seedWorker();
    expect(readLogTail(dir, WORKER, { limit: 2 }).items).toHaveLength(2);
    expect(readLogTail(dir, WORKER, { limit: 0 }).items).toHaveLength(1);
    expect(readLogTail(dir, WORKER, { limit: 10_000 }).items).toHaveLength(7);
  });

  it("filters by level, request, substring and time; a raw line matches no typed filter", () => {
    seedWorker();
    expect(events(readLogTail(dir, WORKER, { level: LogLevel.Error }).items)).toEqual([LogEvent.AttemptFailed]);
    const r1 = readLogTail(dir, WORKER, { request: "r1" }).items;
    expect(events(r1)).toEqual([LogEvent.PriorQuery, LogEvent.Change]);
    expect(events(readLogTail(dir, WORKER, { q: "NOT JSON" }).items)).toEqual(["raw"]);
    expect(events(readLogTail(dir, WORKER, { q: '"seq":2' }).items)).toEqual([LogEvent.Change]);
    const since = readLogTail(dir, WORKER, { since: T + 3 * MINUTE }).items;
    expect(events(since)).toEqual([LogEvent.WorkerStop, LogEvent.Change, LogEvent.PriorQuery]);
    expect(readLogTail(dir, WORKER, { request: "other" }).items).toEqual([]);
  });

  it("reads a file larger than one chunk from the end without losing or splitting a line", () => {
    const n = MAX_TAIL_LINES + 3000;
    const lines = Array.from({ length: n }, (_, i) =>
      line(0, { event: LogEvent.Tool, level: LogLevel.Info, i, pad: "x".repeat(40) }),
    );
    write("service.1.log", lines);
    const tail = readLogTail(dir, SERVICE, { limit: MAX_TAIL_LINES });
    expect(tail.items).toHaveLength(MAX_TAIL_LINES);
    const indexes = tail.items.map((l) => (isRawLine(l) ? -1 : l.fields.i));
    expect(indexes[0]).toBe(n - 1);
    expect(indexes[MAX_TAIL_LINES - 1]).toBe(n - MAX_TAIL_LINES);
    expect(indexes.some((i) => i === -1)).toBe(false);
  });

  it("returns the default count without a limit, and the max for a limit above it", () => {
    const n = MAX_TAIL_LINES + 1;
    write(
      "service.1.log",
      Array.from({ length: n }, (_, i) => line(0, { event: LogEvent.Tool, level: LogLevel.Info, i })),
    );
    expect(readLogTail(dir, SERVICE).items).toHaveLength(DEFAULT_TAIL_LINES);
    expect(readLogTail(dir, SERVICE, { limit: MAX_TAIL_LINES + 1 }).items).toHaveLength(MAX_TAIL_LINES);
  });
});

describe("the serve log of a --db server", () => {
  it("is the file set that the service file of a --db server names", () => {
    write("serve.1.log", [line(0, { event: LogEvent.Listening, level: LogLevel.Info, port: 4242 })]);
    const tail = readLogTail(dir, logBaseFor(LogFile.Service, ServeTarget.Db, "demo"));
    expect(tail.note).toBeUndefined();
    expect(tail.items.map((l) => (isRawLine(l) ? "" : l.event))).toEqual([LogEvent.Listening]);
  });
});
