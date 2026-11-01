// The child of the benefit agent gets a temp folder of its own, so that Claude Code makes no folder in the Temp folder
// of the user (#75). The `claude` process is the contract here: the test reads the options of the spawn.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { describe, expect, it, vi } from "vitest";
import { readEnv } from "../../../src/env.js";
import { Arm } from "../../lib/enums.js";
import { claudeAgent, type AgentJob } from "../agent.js";

vi.mock("execa", () => ({ execa: vi.fn() }));

describe("claudeAgent", () => {
  it("runs the child with TEMP, TMP and TMPDIR set to the temp folder of the job", async () => {
    // A timed-out result ends the run at once; the test needs only the spawn options.
    vi.mocked(execa).mockResolvedValue({ timedOut: true, stdout: "" } as never);
    const tempDir = join(mkdtempSync(join(tmpdir(), "benefit-run-")), "tmp");
    const job: AgentJob = {
      arm: Arm.With,
      prompt: "p",
      cwd: process.cwd(),
      mcpConfigPath: "mcp.json",
      allowedTools: [],
      builtinTools: [],
      model: "m",
      maxTurns: 1,
      timeoutMs: 1,
      tempDir,
    };
    await claudeAgent("claude", readEnv({ PATH: "/bin", TEMP: "/real" }))(job);
    const options = (vi.mocked(execa).mock.calls[0] as unknown[])[2] as {
      env: Record<string, string>;
      extendEnv: boolean;
    };
    expect(options.env).toMatchObject({ PATH: "/bin", TEMP: tempDir, TMP: tempDir, TMPDIR: tempDir });
    expect(options.extendEnv).toBe(false);
  });
});
