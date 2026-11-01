import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LogEvent, LogLevel, LogProcess } from "../../domain/enums.js";
import { logBaseName, fileLogger, processLogger, type FileLogger } from "../index.js";

let dir: string;
let logger: FileLogger | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wikifact-log-"));
});
afterEach(() => {
  logger?.close();
  logger = undefined;
  vi.restoreAllMocks();
});

/**
 * Makes a log line of the given level.
 *
 * @param level - the severity
 * @param marker - goes into `request_id`, which the test reads back
 * @returns the line
 */
const line = (level: LogLevel, marker: string) =>
  ({ event: LogEvent.Gather, level, request_id: marker, droppedTarget: "x" }) as const;

/**
 * Reads the one file named `<prefix>.<n>.log`.
 *
 * @param prefix - the file name before the number
 * @returns its lines, parsed
 */
function lines(prefix: string): Record<string, unknown>[] {
  const files = readdirSync(dir).filter((f) => new RegExp(`^${prefix}\\.\\d+\\.log$`).test(f));
  expect(files).toHaveLength(1);
  return readFileSync(join(dir, files[0]), "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("fileLogger", () => {
  it("writes the full log and the errors log, with the fields of LogLine", async () => {
    logger = await fileLogger({ dir, name: "svc" });
    logger(line(LogLevel.Info, "a"));
    logger(line(LogLevel.Warn, "b"));
    logger(line(LogLevel.Error, "c"));
    const full = lines("svc");
    expect(full.map((l) => l.request_id)).toEqual(["a", "b", "c"]);
    expect(full.map((l) => l.level)).toEqual(["info", "warn", "error"]);
    expect(full[0]).toMatchObject({ event: "gather", droppedTarget: "x" });
    expect(Number.isNaN(Date.parse(String(full[0].ts)))).toBe(false);
  });

  it("sends a warn to both files and an info only to the full log", async () => {
    logger = await fileLogger({ dir, name: "svc" });
    logger(line(LogLevel.Info, "i"));
    logger(line(LogLevel.Warn, "w"));
    expect(lines("svc").map((l) => l.request_id)).toEqual(["i", "w"]);
    expect(lines("svc-errors").map((l) => l.request_id)).toEqual(["w"]);
  });

  it("drops lines after close", async () => {
    logger = await fileLogger({ dir, name: "svc" });
    logger(line(LogLevel.Info, "a"));
    logger.close();
    logger(line(LogLevel.Info, "b"));
    expect(lines("svc").map((l) => l.request_id)).toEqual(["a"]);
  });
});

const callLine = (marker: string) =>
  ({
    event: LogEvent.QuestionCall,
    level: LogLevel.Info,
    requestId: marker,
    question: "Q1",
    model: "m",
    effort: "low",
    input: {},
    ctx: {},
    output: {},
  }) as const;

describe("call log", () => {
  it("names the call log after the worker", () => {
    expect(logBaseName(LogProcess.Worker, "alpha", true)).toBe("worker-alpha-calls");
    expect(logBaseName(LogProcess.Worker, "alpha")).toBe("worker-alpha");
    expect(() => logBaseName(LogProcess.Service, undefined, true)).toThrow();
  });

  it("writes question_call lines to the calls file and to no other file", async () => {
    logger = await fileLogger({ dir, name: "worker-a", callsName: logBaseName(LogProcess.Worker, "a", true) });
    logger(line(LogLevel.Info, "i"));
    logger(callLine("R1"));
    logger(callLine("R2"));
    expect(lines("worker-a").map((l) => l.request_id)).toEqual(["i"]);
    expect(lines("worker-a-errors")).toEqual([]);
    const calls = lines("worker-a-calls");
    expect(calls.map((l) => l.requestId)).toEqual(["R1", "R2"]);
    expect(calls[0]).toMatchObject({
      event: "question_call",
      level: "info",
      question: "Q1",
      model: "m",
      effort: "low",
    });
  });

  it("keeps the call lines in the full log when there is no calls file", async () => {
    logger = await fileLogger({ dir, name: "svc" });
    logger(callLine("R1"));
    expect(lines("svc").map((l) => l.event)).toEqual(["question_call"]);
  });
});

describe("processLogger", () => {
  it("writes to stderr when there is no log directory", async () => {
    const p = await processLogger({ name: "svc" });
    expect(p.toFiles).toBe(false);
    p.close();
  });

  it("writes one stderr line that names the directory, then logs to files only", async () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((s: unknown) => {
      writes.push(String(s));
      return true;
    });
    const p = await processLogger({ logDir: join(dir, "nested"), name: "svc" });
    p.log(line(LogLevel.Info, "a"));
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0])).toMatchObject({ event: LogEvent.LogDir, dir: join(dir, "nested") });
    const files = readdirSync(join(dir, "nested"));
    expect(files.some((f) => /^svc\.\d+\.log$/.test(f))).toBe(true);
    p.close();
  });
});
