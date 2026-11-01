// The requirement tests of docs/requirements/questions.md: one test per row, named as the row.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/config/index.js";
import { Effort, LogEvent, QuestionId, StopReason } from "../../src/domain/enums.js";
import { CaseGroup, HardNegativeKind } from "../../eval/lib/enums.js";
import { wilsonInterval } from "../../eval/lib/stats.js";
import { runConfig } from "../../eval/questions/engine.js";
import { harvest } from "../../eval/questions/harvest.js";
import { currentPromptHash } from "../../eval/questions/prompt-hash.js";
import { DEFAULT_PRESETS_FILE, toPresetsFile } from "../../eval/questions/presets.js";
import { RESULTS_DIR, readResultFile } from "../../eval/questions/results.js";
import { runSets } from "../../eval/questions/run-sets.js";
import { loadSet, groupOf } from "../../eval/questions/sets.js";
import { summarize, type Proposal } from "../../eval/questions/summarize.js";
import { createQuestions } from "../../src/updates/factory.js";
import type { CallResponse, Transport } from "../../src/updates/questions/index.js";
import type { LogLine } from "../../src/log/index.js";
import { Fake, ctx, reply } from "../../src/updates/questions/__tests__/helpers/fake-transport.js";
import { fullSet, hashedEntry, writeResultFiles } from "../../eval/questions/__tests__/helpers/entries.js";

// A new temp folder.
const tmpFolder = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix));

describe("question tuning requirements, measurements", () => {
  it("Presets from measurements", () => {
    const configs = [
      hashedEntry(QuestionId.Q8, undefined, "2026-10-09T10:00:00.000Z", {
        model: "claude-haiku-5-5",
        costEstimateUsd: 1,
      }),
      hashedEntry(QuestionId.Q8, undefined, "2026-10-09T10:01:00.000Z", {
        model: "claude-sonnet-5-5",
        costEstimateUsd: 5,
      }),
    ].map(fullSet);
    const { dir, paths } = writeResultFiles({ "a.json": configs });
    const out = join(dir, "s.json");
    const presetsPath = join(dir, "presets.json");
    const summary = summarize(paths, out, () => undefined, presetsPath);
    // The presets file holds the picks of the summary: the model and the effort of each question in each table.
    interface Picks {
      presets: Record<string, Record<string, { model: string; effort: string }>>;
    }
    const shipped = JSON.parse(readFileSync(presetsPath, "utf8")) as Picks;
    const disk = JSON.parse(readFileSync(out, "utf8")) as { presets: { presets: Picks["presets"] } };
    const tables = Object.keys(shipped.presets);
    expect(tables.length).toBeGreaterThan(0);
    for (const table of tables) {
      const picks = shipped.presets[table] ?? {};
      expect(Object.keys(picks).length).toBeGreaterThan(0);
      for (const [q, pick] of Object.entries(picks)) {
        const measured = disk.presets.presets[table]?.[q];
        expect(pick, `${table} ${q}`).toEqual({ model: measured?.model, effort: measured?.effort });
      }
    }
    expect(summary.presets).toEqual(disk.presets);

    // The committed presets file equals the picks of the summary file that its `source` line names: a hand edit fails.
    const committed = JSON.parse(readFileSync(DEFAULT_PRESETS_FILE, "utf8")) as { source: string };
    const named = JSON.parse(readFileSync(join(RESULTS_DIR, committed.source), "utf8")) as Proposal;
    expect(committed).toEqual(toPresetsFile(named.presets, committed.source));
  });

  it("Current prompt only", () => {
    const current = currentPromptHash(QuestionId.Q8);
    const { dir, paths } = writeResultFiles({
      "a.json": [fullSet(hashedEntry(QuestionId.Q8, current, "2026-10-09T10:00:00.000Z"))],
      "b.json": [
        fullSet(hashedEntry(QuestionId.Q8, "other", "2026-10-09T11:00:00.000Z")),
        fullSet(hashedEntry(QuestionId.Q8, undefined, "2026-10-09T12:00:00.000Z")),
      ],
    });
    const out = join(dir, "s.json");
    const p = summarize(paths, out, () => undefined, join(dir, "presets.json"));
    expect(p.configurations).toHaveLength(1);
    expect(p.configurations[0]?.runs).toBe(1);
    expect(p.pooling.Q8).toEqual({ pooled: 1, leftOut: 2 });
    const disk = JSON.parse(readFileSync(out, "utf8")) as Proposal;
    expect(disk.pooling.Q8).toEqual({ pooled: 1, leftOut: 2 });
  });
});

describe("question tuning requirements, cases", () => {
  it("Call record", async () => {
    process.env.WIKIFACT_LOG_CALLS = "1";
    const lines: LogLine[] = [];
    try {
      await createQuestions(parseConfig({}), new Fake([reply({ matches: ["F1"] })]), {
        log: (l) => lines.push(l),
      }).q1({ change: "c", candidates: [{ factId: "F1", header: "h" }] }, ctx);
    } finally {
      delete process.env.WIKIFACT_LOG_CALLS;
    }
    expect(lines).toHaveLength(1);
    const { model, effort } = parseConfig({}).questions.Q1;
    expect(lines[0]).toMatchObject({
      event: LogEvent.QuestionCall,
      question: QuestionId.Q1,
      model,
      effort,
      input: { change: "c", candidates: [{ factId: "F1", header: "h" }] },
      ctx,
      output: { matches: ["F1"] },
    });
  });

  it("Unlabeled harvest", () => {
    const logs = tmpFolder("qharv-");
    const call = JSON.stringify({
      ts: "2026-10-12T10:00:00.000Z",
      level: "info",
      event: LogEvent.QuestionCall,
      requestId: "R1",
      question: QuestionId.Q2,
      model: "claude-sonnet-5-5",
      effort: "low",
      input: { a: 1 },
      ctx: { subject: "s" },
      output: { stands: "kept" },
    });
    writeFileSync(join(logs, "worker-w-calls.log"), call + "\n");
    const { file, path } = harvest({
      question: QuestionId.Q2,
      logs,
      outDir: join(logs, "out"),
      print: () => undefined,
    });
    const disk = JSON.parse(readFileSync(path, "utf8")) as { cases: Record<string, unknown>[] };
    expect(disk).toMatchObject({
      question: QuestionId.Q2,
      cases: [
        {
          group: CaseGroup.RealUse,
          input: { a: 1 },
          ctx: { subject: "s" },
          observed: { stands: "kept" },
          from: { requestId: "R1" },
        },
      ],
    });
    expect(file.cases[0]).not.toHaveProperty("expect");
    expect(disk.cases[0]).not.toHaveProperty("expect");
  });

  it("Groups by source", async () => {
    // A transport whose every answer is wrong, so every case is missed.
    const wrong: Transport = {
      send: () =>
        Promise.resolve<CallResponse>({
          stopReason: StopReason.EndTurn,
          text: "{}",
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        }),
    };
    const settings = { model: "claude-sonnet-5-5", effort: Effort.Low };
    const set = loadSet(QuestionId.Q5);
    const normal = set.cases.filter((c) => groupOf(c) === CaseGroup.NormalUse);
    const designed = set.cases.filter((c) => groupOf(c) === CaseGroup.Designed);
    // The engine scores each group apart.
    const r = await runConfig({ q: QuestionId.Q5, settings, runs: 2, transport: wrong });
    expect(r.groups[CaseGroup.NormalUse]).toEqual({
      cases: normal.length,
      mean: 0,
      ci: wilsonInterval(0, normal.length * 2),
      missed: normal.map((c) => c.id),
    });
    expect(r.groups[CaseGroup.Designed]?.cases).toBe(designed.length);
    // The result file carries the score of each group.
    const out = join(tmpFolder("qgrp-"), "out.json");
    await runSets(
      {
        qs: [QuestionId.Q5],
        runs: 1,
        concurrency: 4,
        full: true,
        models: [settings.model],
        efforts: [settings.effort],
      },
      { transport: wrong, transportName: "fake", outPath: out, print: () => undefined },
    );
    const entry = readResultFile(out).results[0];
    expect(entry?.groups?.[CaseGroup.NormalUse]?.missed.length).toBeGreaterThan(0);
  });

  it.todo("Real-use cases");

  it("Hard negatives", async () => {
    // The sets of Q1 and Q4 hold at least 5 cases of each kind.
    const MIN_PER_KIND = 5;
    for (const q of [QuestionId.Q1, QuestionId.Q4]) {
      const cases = loadSet(q).cases;
      for (const k of Object.values(HardNegativeKind)) {
        expect(cases.filter((c) => c.kind === k).length, `${q} ${k}`).toBeGreaterThanOrEqual(MIN_PER_KIND);
      }
    }
    // The score of each kind comes with a 95% interval, in the engine and in the result file.
    const wrong: Transport = {
      send: () =>
        Promise.resolve<CallResponse>({
          stopReason: StopReason.EndTurn,
          text: "{}",
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        }),
    };
    const settings = { model: "claude-sonnet-5-5", effort: Effort.Low };
    const runs = 2;
    const r = await runConfig({ q: QuestionId.Q1, settings, runs, transport: wrong });
    for (const k of Object.values(HardNegativeKind)) {
      const n = loadSet(QuestionId.Q1).cases.filter((c) => c.kind === k).length;
      expect(r.kinds?.[k], k).toMatchObject({ cases: n, mean: 0, ci: wilsonInterval(0, n * runs) });
    }
    expect(r.ci).toEqual(wilsonInterval(0, loadSet(QuestionId.Q1).cases.length * runs));
    const out = join(tmpFolder("qkind-"), "out.json");
    await runSets(
      { qs: [QuestionId.Q1], runs, concurrency: 4, full: true, models: [settings.model], efforts: [settings.effort] },
      { transport: wrong, transportName: "fake", outPath: out, print: () => undefined },
    );
    const entry = readResultFile(out).results[0];
    expect(entry?.kinds?.[HardNegativeKind.Negation]?.ci).toEqual(r.kinds?.[HardNegativeKind.Negation]?.ci);
    expect(entry?.ci).toEqual(r.ci);
  });

  it.todo("Held-out part");
});
