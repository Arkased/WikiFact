import { mkdirSync, mkdtempSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanStaleRuns, DEFAULT_MIN_AGE_MS, RUN_FOLDER_PREFIX } from "../clean-temp.js";

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  rmSync: () => {
    throw new Error("busy");
  },
}));

describe("cleanStaleRuns", () => {
  afterEach(() => vi.restoreAllMocks());

  it("warns once with the folder and the error, and does not throw, when a delete fails", () => {
    const now = Date.now();
    const root = mkdtempSync(join(tmpdir(), "clean-temp-test-"));
    const stale = join(root, `${RUN_FOLDER_PREFIX}zzStal`);
    mkdirSync(stale);
    const seconds = (now - DEFAULT_MIN_AGE_MS - 1) / 1000;
    utimesSync(stale, seconds, seconds);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(() => cleanStaleRuns(root, now)).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain(stale);
    expect(String(warn.mock.calls[0]?.[0])).toContain("busy");
  });
});
