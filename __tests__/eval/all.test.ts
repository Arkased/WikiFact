import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { newestResult, npmArgs, parseEvalArgs, resultFileFromOutput, splitArgs } from "../../eval/all.js";
import { EvalTestName, TestStatus } from "../../eval/lib/enums.js";
import { useEvalFixture } from "../helpers/eval-fixture.js";
import { PROCESS_START_TIMEOUT_MS } from "../helpers/timeouts.js";

const { Questions, Relevance, Replay, Corrections, Speed, Benefit } = EvalTestName;

// The order of the tests and the stop at the first failure are the requirement test `Eval order`.
const fx = useEvalFixture();
const { run, started, sorted, calls, readIndex, testOf } = fx;

// Each test starts up to 5 real node processes: the timeout covers a loaded machine, it is not a bound under test.
describe("eval/all.ts", { timeout: PROCESS_START_TIMEOUT_MS }, () => {
  it("--only runs one test", async () => {
    const { idx } = await run(["--only", "replay"]);
    expect(started()).toEqual([Replay]);
    expect(Object.fromEntries(idx.tests.map((t) => [t.name, t.status]))).toEqual({
      [Questions]: TestStatus.Skipped,
      [Relevance]: TestStatus.Skipped,
      [Replay]: TestStatus.Ran,
      [Corrections]: TestStatus.Skipped,
      [Speed]: TestStatus.Skipped,
      [Benefit]: TestStatus.Skipped,
    });
  });

  it("runs the benefit test last when its flags name a wiki, and skips it without --db or --wiki", async () => {
    await run([]);
    expect(started()).not.toContain(Benefit);
    fx.reset();
    const { idx } = await run(["--benefit", "--db wiki.sqlite --repo . --commit abc"]);
    expect(started()).toContain(Benefit);
    expect(calls().find((c) => c.name === Benefit)?.args).toEqual([
      "--db",
      "wiki.sqlite",
      "--repo",
      ".",
      "--commit",
      "abc",
    ]);
    expect(fx.position(Benefit, false)).toBeGreaterThan(fx.position(Speed, true));
    expect(fx.position(Benefit, false)).toBeGreaterThan(fx.position(Corrections, true));
    expect(testOf(idx, Benefit).status).toBe(TestStatus.Ran);
  });

  it("runs the benefit test when its flags name a wiki of an environment with --wiki", async () => {
    await run(["--benefit", "--wiki demo --repo . --commit abc"]);
    expect(started()).toContain(Benefit);
  });

  it("does not run the benefit test after a failed test", async () => {
    await run(["--benefit", "--db wiki.sqlite"], { [Questions]: { exit: 1 } });
    expect(started()).not.toContain(Benefit);
  });

  it("does not run the benefit test after a failed speed test, which ran beside the others", async () => {
    await run(["--benefit", "--db wiki.sqlite"], { [Speed]: { exit: 1 } });
    expect(started()).not.toContain(Benefit);
    fx.reset();
    await run(["--continue", "--benefit", "--db wiki.sqlite"], { [Speed]: { exit: 1 } });
    expect(started()).toContain(Benefit);
  });

  it("--skip may repeat", async () => {
    await run(["--skip", Questions, "--skip", Speed]);
    expect(started()).toEqual(sorted(Relevance, Replay, Corrections));
  });

  it("passes the flags of each test through, quotes included", async () => {
    await run([
      "--questions",
      "Q1 Q7 --runs 3",
      "--relevance",
      "--fake",
      "--replay",
      "--stub",
      "--corrections",
      '--cap 10 --out "my file.json"',
      "--speed",
      "--sizes 1000",
    ]);
    const by = Object.fromEntries(calls().map((c) => [c.name, c.args]));
    expect(by[Questions]).toEqual(["Q1", "Q7", "--runs", "3"]);
    expect(by[Relevance]).toEqual(["--fake"]);
    expect(by[Replay]).toEqual(["--stub"]);
    expect(by[Corrections]).toEqual(["--cap", "10", "--out", "my file.json"]);
    expect(by[Speed]).toEqual(["--sizes", "1000"]);
  });

  it("--continue runs the rest after a failure", async () => {
    const { idx } = await run(["--continue"], { [Questions]: { exit: 1 } });
    expect(started()).toEqual(sorted(Questions, Relevance, Replay, Corrections, Speed));
    expect(testOf(idx, Questions).exitCode).toBe(1);
    expect(idx.ok).toBe(false);
  });

  it("the index file holds the tests, exit codes, times and the result file of each", async () => {
    const { idx, out } = await run(["--skip", Speed]);
    const disk = readIndex(out);
    expect(disk).toEqual(JSON.parse(JSON.stringify(idx)));
    expect(disk).toMatchObject({ complete: true, ok: true, args: { skip: [Speed], continueOnFailure: false } });
    expect(Date.parse(disk.startedAt)).toBeLessThanOrEqual(Date.parse(disk.finishedAt ?? ""));
    const q = testOf(disk, Questions);
    const qFile = q.resultFile ?? "";
    expect(q).toMatchObject({ name: Questions, status: TestStatus.Ran, exitCode: 0 });
    expect(q.command).toContain("fake-eval.mjs questions");
    expect(Date.parse(q.startedAt ?? "")).toBeLessThanOrEqual(Date.parse(q.finishedAt ?? ""));
    expect(qFile).toBe("eval/questions/results/questions-result.json");
    expect(existsSync(join(fx.root(), qFile))).toBe(true);
    expect(testOf(disk, Speed)).toEqual({ name: Speed, status: TestStatus.Skipped });
  });

  it("finds the result file as the newest file of the folder when the output does not name it", async () => {
    const { idx } = await run(["--only", Speed], { [Speed]: { file: "folder" } });
    expect(testOf(idx, Speed).resultFile).toBe("eval/speed-results/speed-result.json");
  });

  it("flushes the index after each test, so a stopped run leaves data", async () => {
    const { out } = await run([], { [Questions]: { exit: 1 } });
    expect(testOf(readIndex(out), Questions).exitCode).toBe(1);
  });

  it("parses the arguments and rejects a bad name", () => {
    expect(() => parseEvalArgs(["--only", "nope"])).toThrow();
    expect(() => parseEvalArgs(["--wat"])).toThrow();
    expect(parseEvalArgs(["--only", Speed, "--continue"])).toMatchObject({ only: Speed, continueOnFailure: true });
  });

  it("helpers: split, result line, newest file", () => {
    expect(splitArgs(`a "b c" 'd e' f`)).toEqual(["a", "b c", "d e", "f"]);
    expect(resultFileFromOutput("x\nresults written to /a/b.json\n")).toBe("/a/b.json");
    expect(resultFileFromOutput("\nresults: eval\\c\\d.json")).toBe("eval\\c\\d.json");
    expect(resultFileFromOutput("nothing")).toBeNull();
    expect(newestResult(join(fx.root(), "none"), 0)).toBeNull();
  });
});

describe("npm scripts of the evals", () => {
  const scripts = (JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> }).scripts;

  it("runs the script eval:<name> with the flags after --", () => {
    expect(npmArgs(Speed, ["--x", "a b"])).toEqual(["run", `eval:${Speed}`, "--", "--x", '"a b"']);
  });

  it("has an eval:<name> script in package.json for every test", () => {
    for (const name of Object.values(EvalTestName)) expect(scripts, name).toHaveProperty(npmArgs(name, [])[1]);
  });
});
