// The child of the Claude Code consumer gets a temp folder of its own in the run folder, so that Claude Code makes no
// folder in the Temp folder of the user (#75). The `claude` process is the contract here: the test reads the spawn options.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { describe, expect, it, vi } from "vitest";
import type { Seeded } from "../../seed.js";
import type { Task } from "../../data.js";
import { claudeConsumer } from "../claude.js";

vi.mock("execa", () => ({ execa: vi.fn() }));

describe("claudeConsumer", () => {
  it("runs the child with TEMP, TMP and TMPDIR inside the run folder", async () => {
    // A result with no exit code and no timeout ends the task at once; the test needs only the spawn options.
    vi.mocked(execa).mockResolvedValue({ stdout: "", stderr: "", timedOut: false } as never);
    const runDir = mkdtempSync(join(tmpdir(), "wf-corr-test-"));
    const task: Task = { id: "t1", wrong: "w", question: "q", observation: "o", answerContains: "a" };
    const seeded = { dbPath: join(runDir, "game.sqlite") } as Seeded;
    await claudeConsumer("claude")(task, { seeded, data: {} as never, hook: false, runDir, log: () => undefined });
    const options = (vi.mocked(execa).mock.calls[0] as unknown[])[2] as { env: Record<string, string> };
    const { TEMP, TMP, TMPDIR } = options.env;
    expect(TEMP).toBeTruthy();
    expect(TMP).toBe(TEMP);
    expect(TMPDIR).toBe(TEMP);
    expect(TEMP.startsWith(runDir)).toBe(true);
  });
});
