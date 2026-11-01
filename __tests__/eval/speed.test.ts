import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Profile } from "../../eval/speed/profile.js";
import type { SpeedResultFile } from "../../eval/speed/report.js";
import { PROCESS_START_TIMEOUT_MS } from "../helpers/timeouts.js";

describe("eval/speed.ts results file", () => {
  it(
    "writes a JSON file with the shape the eval promises (fake embedder, small N, --out)",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "wikifact-speedtest-"));
      const out = join(dir, "r.json");
      // The exit code is the verdict on the speed bar (p95 under SPEED_BAR_MS), which the load of the machine decides.
      // This test reads the file that the run wrote; a run that crashed writes none.
      const run = spawnSync(
        process.execPath,
        ["--import", "tsx", "eval/speed.ts", "200", "--fake", "--queries", "10", "--profile", "--out", out],
        {
          cwd: process.cwd(),
          encoding: "utf8",
        },
      );
      // The message carries what the run said when it wrote no file.
      expect(existsSync(out), `no results file: ${run.error?.message ?? ""} ${run.stderr}`).toBe(true);
      const r = JSON.parse(readFileSync(out, "utf8")) as SpeedResultFile;
      const profile: Partial<Profile> = r.profile ?? {};
      expect(r.n).toBe(200);
      expect(r.queryCount).toBe(10);
      expect(r.embedder).toBe("fake");
      expect(r.seedFake).toBe(true);
      for (const v of [r.p50_ms, r.p95_ms, r.max_ms]) expect(typeof v).toBe("number");
      expect(r.p50_ms).toBeLessThanOrEqual(r.p95_ms);
      expect(r.p95_ms).toBeLessThanOrEqual(r.max_ms);
      expect(typeof profile.total?.mean_ms).toBe("number");
      expect(typeof profile.total?.p95_ms).toBe("number");
      expect(typeof r.machine.os).toBe("string");
      expect(typeof r.machine.cpu).toBe("string");
      expect(typeof r.machine.logicalCores).toBe("number");
      expect(r.machine.node).toBe(process.version);
      expect(Date.parse(r.startedAt)).toBeLessThanOrEqual(Date.parse(r.finishedAt));
    },
    PROCESS_START_TIMEOUT_MS,
  );
});
