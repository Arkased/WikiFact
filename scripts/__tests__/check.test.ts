import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fkill from "fkill";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChangeKind } from "../../eval/lib/enums.js";
import {
  assertWindows,
  exitCodeOf,
  killOrphan,
  killTree,
  lockName,
  prepareResults,
  resultsPath,
  stepsArgs,
  takeLock,
  type TakeLockOptions,
} from "../check.js";
import { scopeOf } from "../lib/check-scope.js";
import { countResults, runQuietStep, summaryLine } from "../lib/quiet-step.js";

vi.mock("fkill", () => ({ default: vi.fn() }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(fkill).mockReset();
});

// A lock name of its own for one test, so that tests and a running `npm run check` never meet.
function freshName(): string {
  return lockName(mkdtempSync(join(tmpdir(), "check-lock-test-")), "fixture");
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function options(name: string, over: Partial<TakeLockOptions> = {}): TakeLockOptions {
  return { name, sleep: tick, log: () => undefined, ...over };
}

describe("check lock", () => {
  it("makes a second holder wait while the first holds the lock, and take it after the first closes", async () => {
    const name = freshName();
    const first = await takeLock(options(name));
    const lines: string[] = [];
    let sleeps = 0;
    const second = await takeLock(
      options(name, {
        log: (line) => lines.push(line),
        sleep: async () => {
          sleeps += 1;
          if (sleeps === 3) first.close();
          await tick();
        },
      }),
    );
    expect(sleeps).toBe(3);
    expect(lines).toHaveLength(1);
    second.close();
  });

  it("gives the lock to each of 2 waiters in turn, never to 2 at once", async () => {
    const name = freshName();
    const holder = await takeLock(options(name));
    let sleeps = 0;
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];
    const waiter = async (label: string): Promise<void> => {
      const server = await takeLock(
        options(name, {
          sleep: async () => {
            sleeps += 1;
            if (sleeps === 5) holder.close();
            await tick();
          },
        }),
      );
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push(label);
      for (let i = 0; i < 20; i += 1) await tick();
      active -= 1;
      server.close();
    };
    await Promise.all([waiter("a"), waiter("b")]);
    expect(maxActive).toBe(1);
    expect(order).toHaveLength(2);
    expect(new Set(order)).toEqual(new Set(["a", "b"]));
  });
});

describe("check kill", () => {
  const PID = 4242;

  it("reports a failed kill on stderr when the root is still alive", async () => {
    vi.mocked(fkill).mockRejectedValue(new Error("access denied"));
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: string) => void lines.push(line));
    await killTree(PID, () => true);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("access denied");
  });

  it("reports nothing when the root is gone after the failed kill", async () => {
    vi.mocked(fkill).mockRejectedValue(new Error("access denied"));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await killTree(PID, () => false);
    expect(error).not.toHaveBeenCalled();
  });
});

describe("check orphan record", () => {
  it.each([
    ["text that is not JSON", "{oops"],
    ["a pid that is text", JSON.stringify({ pid: "1; calc", start: "123" })],
    ["a start that is not digits", JSON.stringify({ pid: 5, start: "1; calc" })],
    ["a pid that is not positive", JSON.stringify({ pid: -4, start: "123" })],
  ])("logs, deletes and kills nothing for %s", async (_name, content) => {
    const file = join(mkdtempSync(join(tmpdir(), "check-record-test-")), "record.json");
    writeFileSync(file, content);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await killOrphan(file, () => undefined);
    expect(error).toHaveBeenCalledTimes(1);
    expect(() => readFileSync(file)).toThrow();
    expect(fkill).not.toHaveBeenCalled();
  });
});

describe("the scoped command line", () => {
  // A small file with a few related tests, and not one of the tests of this file (the run would call itself).
  const FILE = "scripts/lib/requirements.ts";
  const scope = scopeOf([{ path: FILE, kind: ChangeKind.Present }], false);

  const STEPS = [
    ...["typecheck", "lint", "check:format", "check:requirements", "check:standard", "check:dead", "check:plugin"],
    `test:related -- ${FILE}`,
  ];

  it("builds one run-p command that runs each step through the quiet wrapper, with aggregated output", () => {
    expect(stepsArgs(scope)).toEqual([
      ...["exec", "--", "run-p", "--silent", "--aggregate-output"],
      ...STEPS.map((step) => `check:step -- ${step}`),
    ]);
  });

  it("with --verbose builds a run-p command where each step inherits stdio", () => {
    expect(stepsArgs(scope, true)).toEqual([...["exec", "--", "run-p", "--print-label"], ...STEPS]);
  });
});

describe("a quiet step", () => {
  const clock = (): (() => number) => {
    let t = 0;
    return () => (t += 1500);
  };

  it("prints 1 line for a passing step and nothing of its output", async () => {
    const out: string[] = [];
    const code = await runQuietStep("lint", {
      launch: () => Promise.resolve({ output: "lots\nof\ntext\n", exitCode: 0 }),
      write: (text) => out.push(text),
      now: clock(),
    });
    expect(code).toBe(0);
    expect(out.join("")).toBe("pass lint (1.5 s)\n");
  });

  it("prints the whole output and then the FAIL line for a failing step", async () => {
    const out: string[] = [];
    const code = await runQuietStep("test:related -- a.ts b.ts", {
      launch: () => Promise.resolve({ output: "error one\nerror two", exitCode: 2 }),
      write: (text) => out.push(text),
      now: clock(),
    });
    expect(code).toBe(2);
    expect(out.join("")).toBe("error one\nerror two\nFAIL test:related (1.5 s, exit 2)\n");
  });

  it("writes the block of each of 2 parallel steps in 1 piece, so they do not interleave", async () => {
    const writes: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const launch = async (step: string): Promise<{ output: string; exitCode: number }> => {
      if (step === "slow") await gate;
      else release();
      return { output: `${step} line 1\n${step} line 2\n`, exitCode: 1 };
    };
    const write = (text: string): void => void writes.push(text);
    await Promise.all([
      runQuietStep("slow", { launch, write, now: clock() }),
      runQuietStep("fast", { launch, write, now: clock() }),
    ]);
    expect(writes).toEqual([
      "fast line 1\nfast line 2\nFAIL fast (1.5 s, exit 1)\n",
      "slow line 1\nslow line 2\nFAIL slow (1.5 s, exit 1)\n",
    ]);
  });

  it("builds the summary line from the results, with no not-finished part when all results are present", () => {
    const line = summaryLine(countResults("pass\npass\nFAIL\n", 3), 12345);
    expect(line).toBe("check: 2 passed, 1 failed (12.3 s)");
    expect(line).not.toContain("not finished");
  });

  it("counts the steps with no result as not finished: 1 failing step of 4 with 2 results missing", () => {
    const counts = countResults("pass\nFAIL\n", 4);
    expect(counts.notFinished).toBe(2);
    expect(summaryLine(counts, 12345)).toBe("check: 1 passed, 1 failed, 2 not finished (12.3 s)");
  });
});

describe("the results folder of the quiet check", () => {
  const commonDir = (): string => mkdtempSync(join(tmpdir(), "check-results-test-"));

  it("is wikifact-check-results in the common git folder", () => {
    expect(resultsPath(join("C:", "repo", ".git"))).toBe(join("C:", "repo", ".git", "wikifact-check-results"));
  });

  it("is made when missing and holds no result of an earlier check before the steps start", async () => {
    const common = commonDir();
    const dir = await prepareResults(common, false);
    expect(dir).toBe(resultsPath(common));
    writeFileSync(join(dir ?? "", "old.txt"), "FAIL\n");
    await prepareResults(common, false);
    expect(existsSync(join(dir ?? "", "old.txt"))).toBe(false);
    expect(existsSync(dir ?? "")).toBe(true);
  });

  it("is not made and not passed in verbose mode", async () => {
    const common = commonDir();
    expect(await prepareResults(common, true)).toBeUndefined();
    expect(existsSync(resultsPath(common))).toBe(false);
  });
});

describe("the exit code of a quiet check", () => {
  it("is not 0 when run-p exited 0 and a step did not finish", () => {
    expect(exitCodeOf(0, { passed: 2, failed: 0, notFinished: 2 })).not.toBe(0);
  });

  it("is 0 when run-p exited 0 and every step passed", () => {
    expect(exitCodeOf(0, { passed: 4, failed: 0, notFinished: 0 })).toBe(0);
  });

  it("is the exit code of run-p when it is not 0", () => {
    expect(exitCodeOf(3, { passed: 4, failed: 0, notFinished: 0 })).toBe(3);
  });
});

describe("check platform", () => {
  it("fails at once off Windows with a clear message", () => {
    expect(() => assertWindows("linux")).toThrow(/Windows only/);
    expect(() => assertWindows("win32")).not.toThrow();
  });
});
