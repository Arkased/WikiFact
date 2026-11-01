import { afterEach, describe, expect, it, vi } from "vitest";
import { LogEvent, LogLevel } from "../../domain/enums.js";
import { stderrLogger } from "../index.js";
import { projectRoot } from "../../paths.js";
import { existsSync } from "node:fs";
import { join } from "node:path";

afterEach(() => vi.restoreAllMocks());

describe("stderrLogger", () => {
  it("writes one JSON line per call with a timestamp, the event and the level", () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((s: unknown) => {
      writes.push(String(s));
      return true;
    });
    stderrLogger()({ event: LogEvent.WorkerStop, level: LogLevel.Info });
    expect(writes).toHaveLength(1);
    expect(writes[0].endsWith("\n")).toBe(true);
    const parsed = JSON.parse(writes[0]) as Record<string, unknown>;
    expect(parsed).toMatchObject({ event: "worker_stop", level: "info" });
    expect(Number.isNaN(Date.parse(String(parsed.ts)))).toBe(false);
  });
});

describe("projectRoot", () => {
  it("is the folder that holds package.json", () => {
    expect(existsSync(join(projectRoot(), "package.json"))).toBe(true);
  });
});
