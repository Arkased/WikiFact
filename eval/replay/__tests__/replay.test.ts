import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HEAVY_TEST_TIMEOUT_MS } from "../../../__tests__/helpers/timeouts.js";
import { parseConfig } from "../../../src/config/index.js";
import { RequestStatus } from "../../../src/domain/enums.js";
import { RunMode } from "../../lib/enums.js";
import { loadReplay } from "../load.js";
import { printReport } from "../report.js";
import { defaultReplayOut, runReplayToFile } from "../result-file.js";
import { runReplay } from "../run.js";
import type { ReplayCase, ReplayResultFile } from "../types.js";
import type { Questions } from "../../../src/updates/types.js";
import { StubQuestions } from "../../../fakes/stub-questions.js";
import { naiveStub, scriptedStub } from "../../../fakes/scripted-stub.js";

const config = parseConfig({ subject: loadReplay().subject });

/** The `drafts` of the Q5 answer in a case script. */
interface Q5Script {
  drafts: { header: string; content: string; references: string[] }[];
}

const readResult = (path: string): ResultOnDisk => JSON.parse(readFileSync(path, "utf8")) as ResultOnDisk;

/** A results file as parsed from disk: the fields are optional, because a stopped run leaves a partial file. */
type ResultOnDisk = Partial<ReplayResultFile> & Pick<ReplayResultFile, "results" | "startedAt">;

// Narrows the stub that `scriptedStub` returns to the class that has `set`.
const asStub = (q: Questions): StubQuestions => {
  if (!(q instanceof StubQuestions)) throw new Error("scriptedStub did not return a StubQuestions");
  return q;
};

// A copy of a case whose Q5 script is changed by `edit`.
const withQ5 = (c: ReplayCase, edit: (q5: Q5Script) => void): ReplayCase => {
  const copy = structuredClone(c);
  const q5 = (copy.stub?.q5 ?? { drafts: [] }) as Q5Script;
  edit(q5);
  copy.stub = { ...copy.stub, q5 };
  return copy;
};

describe("replay results file and concurrency", () => {
  const tmp = (): string => join(mkdtempSync(join(tmpdir(), "rres-")), "sub", "out.json");

  it(
    "writes every case result, the pass flag, the transport, the models and timestamps",
    async () => {
      const out = tmp();
      const { report, file } = await runReplayToFile(
        { config, makeQuestions: scriptedStub, concurrency: 4 },
        { mode: RunMode.Stub, transport: RunMode.Stub, models: [] },
        out,
      );
      const disk = readResult(out);
      expect(disk).toEqual(JSON.parse(JSON.stringify(file)));
      expect(disk).toMatchObject({
        complete: true,
        pass: true,
        mode: RunMode.Stub,
        transport: RunMode.Stub,
        models: [],
        concurrency: 4,
      });
      expect(Date.parse(disk.startedAt)).toBeLessThanOrEqual(Date.parse(disk.finishedAt ?? ""));
      expect(disk.results.map((r) => r.id)).toEqual(report.results.map((r) => r.id));
      expect(disk.results).toHaveLength(loadReplay().cases.length);
      for (const r of disk.results) {
        expect(r).toHaveProperty("misses");
        expect(r).toHaveProperty("criticalMisses");
        expect(Date.parse(r.startedAt ?? "")).toBeLessThanOrEqual(Date.parse(r.finishedAt ?? ""));
      }
      expect(disk.usage).toEqual({ input: 0, output: 0 });
    },
    HEAVY_TEST_TIMEOUT_MS,
  );

  it(
    "records the pass flag false when a duplicate gets through",
    async () => {
      const out = tmp();
      await runReplayToFile(
        { config, makeQuestions: () => naiveStub() },
        { mode: RunMode.Stub, transport: RunMode.Stub, models: [] },
        out,
      );
      expect(readResult(out).pass).toBe(false);
    },
    HEAVY_TEST_TIMEOUT_MS,
  );

  it("flushes a partial file after each case, so a stopped run leaves data", async () => {
    const out = tmp();
    let n = 0;
    await expect(
      runReplayToFile(
        {
          config,
          makeQuestions: scriptedStub,
          concurrency: 2,
          onResult: () => {
            if (++n === 3) throw new Error("stopped");
          },
        },
        { mode: RunMode.Stub, transport: RunMode.Stub, models: [] },
        out,
      ),
    ).rejects.toThrow("stopped");
    const disk = readResult(out);
    expect(disk.complete).toBe(false);
    expect(disk.finishedAt).toBeUndefined();
    expect(disk.pass).toBeUndefined();
    expect(disk.results.length).toBeGreaterThanOrEqual(3);
  });

  it(
    "runs cases in parallel up to the limit",
    async () => {
      let active = 0;
      let peak = 0;
      const r = await runReplay({
        config,
        concurrency: 3,
        makeQuestions: (c, ids) => {
          const s = asStub(scriptedStub(c, ids));
          const q1 = s.q1.bind(s);
          s.q1 = async (input, ctx) => {
            active++;
            peak = Math.max(peak, active);
            await new Promise((res) => setImmediate(res)); // lets the other cases start while this one is open
            active--;
            return q1(input, ctx);
          };
          return s;
        },
      });
      expect(r.pass).toBe(true);
      expect(peak).toBeGreaterThan(1);
      expect(peak).toBeLessThanOrEqual(3);
    },
    HEAVY_TEST_TIMEOUT_MS,
  );

  it("the default path is under eval/replay-results", () => {
    expect(defaultReplayOut().replace(/\\/g, "/")).toMatch(/eval\/replay-results\/\d{4}-\d\d-\d\dT[\d-]+\.\d+Z\.json$/);
  });
});

describe('replay harness (technical/updates.md, "Tests")', () => {
  it("loads recorded cases with unique ids", () => {
    const ids = loadReplay().cases.map((c) => c.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it(
    "a stub that answers the script passes every case through runOnce",
    async () => {
      const r = await runReplay({ config, makeQuestions: scriptedStub });
      const lines: string[] = [];
      printReport(r, (s) => lines.push(s));
      expect(r.results, lines.join("\n")).toHaveLength(loadReplay().cases.length);
      for (const x of r.results) expect([...x.criticalMisses, ...x.misses, ...x.errors], x.id).toEqual([]);
      expect(r.pass).toBe(true);
      expect(lines.join("\n")).toContain("PASS");
    },
    HEAVY_TEST_TIMEOUT_MS,
  );

  it("a non-critical miss is reported and does not fail the run", async () => {
    const r = await runReplay({
      config,
      only: "r01",
      makeQuestions: (c, ids) =>
        scriptedStub(
          withQ5(c, (q5) => {
            const first = q5.drafts[0];
            if (first) first.content = "Zombies drop bones when killed.";
          }),
          ids,
        ),
    });
    expect(r.pass).toBe(true);
    expect(r.results[0]?.misses.join(" ")).toContain("rotten flesh");
  });

  it("an error in a question is counted as a failed attempt and reported", async () => {
    const r = await runReplay({
      config,
      only: "r01",
      makeQuestions: (c, ids) => {
        return asStub(scriptedStub(c, ids)).set("q4", () => {
          throw new Error("boom");
        });
      },
    });
    expect(r.results[0]?.errors.join(" ")).toContain("boom");
    expect(r.results[0]?.outcome).toBe(RequestStatus.Failed);
  });
});
