import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { describe, expect, it } from "vitest";
import { HEAVY_TEST_TIMEOUT_MS } from "../../../__tests__/helpers/timeouts.js";
import { QUESTION_IDS } from "../../../src/config/index.js";
import { relativeToRoot } from "../../lib/relative-path.js";
import { wilsonInterval } from "../../lib/stats.js";
import {
  Effort,
  Q4Relation,
  QuestionId,
  QuestionKind,
  RejectReason,
  SupportKind,
  WrongRelatedAction,
} from "../../../src/domain/enums.js";
import { HardNegativeKind, RunnerMode } from "../../lib/enums.js";
import { validateSets } from "../validate.js";
import {
  SPECS,
  type CallRequest,
  type CallResponse,
  type QuestionSpec,
  type Transport,
} from "../../../src/updates/questions/index.js";
import { parseArgs } from "../args.js";
import { matrix, selectedConfigs } from "../configs.js";
import { runConfig } from "../engine.js";
import { loadModels } from "../models.js";
import { buildPresets } from "../presets.js";
import { must } from "../../lib/questions-guard.js";
import { REMOVED_QUESTION_IDS } from "../../../src/constants.js";
import {
  RESULTS_DIR,
  barText,
  defaultOut,
  readResultFile,
  resultFilesIn,
  type Entry,
  type ResultFile,
} from "../results.js";
import { runSets, type ResumeFrom, type RunSetsArgs, type RunTarget } from "../run-sets.js";
import { poolEntries, summarize, type Proposal } from "../summarize.js";
import { scoreAnswer, signature } from "../score.js";
import { caseCtx, compactInput, ctxOf, expandInput, loadSet, type Case } from "../sets.js";

// Builds the answer that the label asks for, so that a correct model would score 100 percent.
function oracle(q: QuestionId, c: Case, input: Record<string, unknown>): unknown {
  const e = c.expect;
  switch (q) {
    case QuestionId.Q1:
      return { matches: e.matches };
    case QuestionId.Q2:
      return { stands: e.stands, reason: "r" };
    case QuestionId.Q7:
      return {
        oneClaim: e.oneClaim,
        claims: (e.claims ?? []).map((s) => s.split("|")[0] ?? s),
        support: e.support ?? SupportKind.Observation,
        reason: "r",
      };
    case QuestionId.Q8:
      return { holds: e.holds, stillDepends: e.stillDepends ?? [], reason: "r" };
    case QuestionId.Q4:
      return {
        supported: e.supported,
        ...(e.rejectReason
          ? { rejectReason: e.rejectReason }
          : e.supported
            ? {}
            : { rejectReason: RejectReason.Unsupported }),
        ...(input.existing ? { relation: e.relation ?? Q4Relation.Different } : {}),
        wrongRelated: e.wrongRelated ?? [],
        reason: "r",
      };
    case QuestionId.Q3:
    case QuestionId.Q5:
    case QuestionId.Q6:
    case QuestionId.Q9:
    case QuestionId.Q10: {
      const first = (s: string) => s.split("|")[0] ?? s;
      const n: number = e.drafts ?? 1;
      const base = {
        header: [...(e.headerHas ?? []).map(first), "Header"].join(" "),
        content: [...(e.contentHas ?? []).map(first), "text"].join(" "),
        references: [...(e.refsExactly ?? e.refsHas ?? [])],
        ...(e.isDeleted ? { isDeleted: true } : {}),
      };
      const drafts = Array.from({ length: n }, (_, i) =>
        i === 0 ? base : { header: "Other", content: "other text", references: [] },
      );
      return { drafts };
    }
  }
}

// A transport that answers each case from its label.
function oracleTransport(q: QuestionId): Transport {
  const set = loadSet(q);
  const ctx = ctxOf(set);
  const spec = SPECS[q] as unknown as QuestionSpec<unknown, unknown>;
  const byMessage = new Map<string, unknown>();
  for (const c of set.cases) {
    const input = expandInput(q, c.input);
    const ans = oracle(q, c, input);
    byMessage.set(spec.render(input, caseCtx(ctx, c)), ans);
  }
  return {
    send(req: CallRequest): Promise<CallResponse> {
      const ans = byMessage.get(req.messages[0]?.content ?? "");
      if (ans === undefined) return Promise.reject(new Error("no label for this message"));
      return Promise.resolve({
        stopReason: "end_turn",
        text: JSON.stringify(ans),
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
      });
    },
  };
}

describe("question sets", () => {
  for (const q of QUESTION_IDS) {
    describe(q, () => {
      const set = loadSet(q);

      it("has labeled inputs with unique ids", () => {
        expect(set.cases.length).toBeGreaterThan(0);
        expect(new Set(set.cases.map((c) => c.id)).size).toBe(set.cases.length);
      });

      it("every input matches the input schema of the question", () => {
        for (const c of set.cases) {
          const r = SPECS[q].input.safeParse(expandInput(q, c.input));
          expect(r.success, `${c.id}: ${r.success ? "" : r.error.message}`).toBe(true);
        }
      });

      it("the runner scores a correct model at 100 percent in every run, and sees no instability", async () => {
        const [settings] = matrix(q);
        if (!settings) throw new Error(`no configuration for ${q}`);
        const r = await runConfig({ q, settings, runs: 3, transport: oracleTransport(q) });
        expect(r.failing).toEqual([]);
        expect(r.runAccuracy).toEqual([1, 1, 1]);
        expect(r.unstable).toEqual([]);
        expect(r.allRunsPass).toBe(true);
        expect(r.tokens.output).toBeGreaterThan(0);
      });
    });
  }
});

const A = (qs: QuestionId[], runs: number, limit?: number, over: Partial<RunSetsArgs> = {}): RunSetsArgs => ({
  qs,
  models: [],
  efforts: [],
  runs,
  limit,
  concurrency: 6,
  ...over,
});

// Where a run sends its calls and its output; the lines go nowhere unless `print` is given.
const T = (
  transport: Transport,
  outPath: string,
  print: (s: string) => void = () => undefined,
  resume?: ResumeFrom,
): RunTarget => ({ transport, transportName: "fake", outPath, print, resume });

describe("result file", () => {
  const tmp = () => join(mkdtempSync(join(tmpdir(), "qres-")), "sub", "out.json");

  it(
    "holds every configuration with its runs, accuracy, unstable cases, usage, cost and timestamps",
    async () => {
      const out = tmp();
      // One transport per question: dispatch on the message that each set renders.
      const oracles = [QuestionId.Q1, QuestionId.Q7].map((q) => oracleTransport(q));
      const both: Transport = {
        async send(req, signal) {
          for (const o of oracles) {
            try {
              return await o.send(req, signal);
            } catch {
              // not this question
            }
          }
          throw new Error("no label");
        },
      };
      const f = await runSets(A([QuestionId.Q1, QuestionId.Q7], 2, 5), T(both, out));
      const disk = readResultFile(out);
      expect(disk).toEqual(JSON.parse(JSON.stringify(f)) as ResultFile);
      expect(disk).toMatchObject({ complete: true, transport: "fake", runs: 2, limit: 5 });
      expect(Date.parse(disk.startedAt)).toBeLessThanOrEqual(Date.parse(disk.finishedAt ?? ""));
      expect(disk.results).toHaveLength(matrix(QuestionId.Q1).length + matrix(QuestionId.Q7).length);
      const r = must(
        disk.results.find(
          (x) => x.question === QuestionId.Q1 && x.model === "claude-sonnet-5-5" && x.effort === Effort.Low,
        ),
        "no result for Q1 on Sonnet at low",
      );
      expect(r).toMatchObject({
        question: QuestionId.Q1,
        model: "claude-sonnet-5-5",
        effort: Effort.Low,
        effortSent: true,
        cases: 5,
        runs: 2,
        runAccuracy: [1, 1],
        mean: 1,
        allRunsPass: true,
        unstable: [],
        errors: 0,
      });
      expect(r.usage.output).toBeGreaterThan(0);
      expect(typeof r.costEstimateUsd).toBe("number");
      expect(Date.parse(r.startedAt)).toBeLessThanOrEqual(Date.parse(r.finishedAt));
      expect(disk.results.some((x) => x.effortSent)).toBe(true);
      expect(disk.summary.length).toBe(2);
    },
    HEAVY_TEST_TIMEOUT_MS,
  );

  it("leaves a partial file when the run stops after some configurations completed", async () => {
    const out = tmp();
    const oracle = oracleTransport(QuestionId.Q1);
    let seen = 0;
    await expect(
      runSets(
        A([QuestionId.Q1], 1, 3),
        T(oracle, out, (s) => {
          if (s.includes(", stage ") && ++seen === 2) throw new Error("stopped");
        }),
      ),
    ).rejects.toThrow("stopped");
    const disk = readResultFile(out);
    expect(disk.complete).toBe(false);
    expect(disk.finishedAt).toBeUndefined();
    expect(disk.results.length).toBeGreaterThanOrEqual(2);
    expect(disk.results.every((x) => x.question === QuestionId.Q1)).toBe(true);
    expect(disk.summary).toHaveLength(1);
  });

  it("reads every result file on disk, and skips the entries of the removed questions Q7B and Q5B, and the old group Q15", () => {
    for (const f of resultFilesIn()) {
      const { results } = readResultFile(f);
      for (const e of results) expect(REMOVED_QUESTION_IDS.has(e.question), f).toBe(false);
    }
    expect(readResultFile(join(RESULTS_DIR, "2026-10-20-g-q15-opus.json")).results).toEqual([]);
  });

  it("the default path is under eval/questions/results with an ISO timestamp", () => {
    expect(defaultOut().replace(/\\/g, "/")).toMatch(/eval\/questions\/results\/\d{4}-\d\d-\d\dT[\d-]+\.\d+Z\.json$/);
  });
});

describe("scoring", () => {
  it("Q1 compares sets", () => {
    expect(scoreAnswer(QuestionId.Q1, { matches: ["b", "a"] }, { matches: ["a", "b"] }).pass).toBe(true);
    expect(scoreAnswer(QuestionId.Q1, { matches: ["a"] }, { matches: ["a", "b"] }).pass).toBe(false);
    expect(scoreAnswer(QuestionId.Q1, { matches: ["a", "a"] }, { matches: ["a"] }).pass).toBe(false);
  });

  it("Q4 needs the empty wrongRelated when the label has none", () => {
    const out = { supported: true, wrongRelated: [{ factId: "f", action: WrongRelatedAction.Delete }], reason: "r" };
    expect(scoreAnswer(QuestionId.Q4, out, { supported: true }).pass).toBe(false);
    expect(
      scoreAnswer(QuestionId.Q4, out, {
        supported: true,
        wrongRelated: [{ factId: "f", action: WrongRelatedAction.Delete }],
      }).pass,
    ).toBe(true);
    expect(
      scoreAnswer(QuestionId.Q4, out, {
        supported: true,
        wrongRelated: [{ factId: "f", action: WrongRelatedAction.Narrow }],
      }).pass,
    ).toBe(false);
  });

  it("Q4 scores the relation unrelated, and a different relation fails", () => {
    const out = { supported: true, relation: Q4Relation.Unrelated, wrongRelated: [], reason: "r" };
    expect(scoreAnswer(QuestionId.Q4, out, { supported: true, relation: Q4Relation.Unrelated }).pass).toBe(true);
    expect(scoreAnswer(QuestionId.Q4, out, { supported: true, relation: Q4Relation.Different }).pass).toBe(false);
    expect(
      scoreAnswer(
        QuestionId.Q4,
        { ...out, relation: Q4Relation.Different },
        { supported: true, relation: Q4Relation.Unrelated },
      ).pass,
    ).toBe(false);
  });

  it("Q8 checks stillDepends only when the dependent holds", () => {
    expect(scoreAnswer(QuestionId.Q8, { holds: false, stillDepends: ["x"], reason: "" }, { holds: false }).pass).toBe(
      true,
    );
    expect(
      scoreAnswer(QuestionId.Q8, { holds: true, stillDepends: [], reason: "" }, { holds: true, stillDepends: ["x"] })
        .pass,
    ).toBe(false);
  });

  it("Q7 checks oneClaim always and the support kind only when the label names it", () => {
    const out = { oneClaim: true, claims: [], support: SupportKind.Report, reason: "" };
    expect(scoreAnswer(QuestionId.Q7, out, { oneClaim: true }).pass).toBe(true);
    expect(scoreAnswer(QuestionId.Q7, out, { oneClaim: true, support: SupportKind.Report }).pass).toBe(true);
    expect(scoreAnswer(QuestionId.Q7, out, { oneClaim: true, support: SupportKind.Observation }).pass).toBe(false);
    expect(scoreAnswer(QuestionId.Q7, out, { oneClaim: false }).pass).toBe(false);
  });

  it("Q7 claims: the count is exact, and each expected claim is in a different claim of the answer", () => {
    const label = { oneClaim: false, claims: ["4 planks|planks", "8 cobblestone"] };
    const out = (claims: string[]) => ({ oneClaim: false, claims, support: SupportKind.Observation, reason: "" });
    const good = ["A crafting table needs 4 planks.", "A furnace needs 8 cobblestone."];
    expect(scoreAnswer(QuestionId.Q7, out(good), label).pass).toBe(true);
    expect(scoreAnswer(QuestionId.Q7, out([...good].reverse()), label).pass).toBe(true);
    expect(scoreAnswer(QuestionId.Q7, out(good.slice(0, 1)), label).pass).toBe(false);
    expect(scoreAnswer(QuestionId.Q7, out([...good, "A torch needs coal."]), label).pass).toBe(false);
    expect(
      scoreAnswer(QuestionId.Q7, out(["A crafting table needs 4 planks.", "It needs 4 planks."]), label).pass,
    ).toBe(false);
    // A label without claims does not check them.
    expect(scoreAnswer(QuestionId.Q7, out([]), { oneClaim: false }).pass).toBe(true);
  });

  it("drafts: counts, alternatives, lacks, references", () => {
    const out = {
      drafts: [{ header: "H", content: "Twelve damage", references: ["a"] }],
    };
    const e = {
      drafts: 1,
      contentHas: ["12|twelve"],
      contentLacks: ["ten"],
      refsExactly: ["a"],
    };
    expect(scoreAnswer(QuestionId.Q5, out, e).pass).toBe(true);
    expect(scoreAnswer(QuestionId.Q5, out, { ...e, drafts: 2 }).pass).toBe(false);
    expect(scoreAnswer(QuestionId.Q5, out, { ...e, contentLacks: ["damage"] }).pass).toBe(false);
    expect(scoreAnswer(QuestionId.Q5, out, { ...e, refsExactly: ["a", "b"] }).pass).toBe(false);
  });

  it("the signature differs when the label differs", () => {
    const q7 = (oneClaim: boolean, support: SupportKind) =>
      signature(QuestionId.Q7, { oneClaim, claims: [], support, reason: "r" });
    expect(q7(true, SupportKind.Observation)).not.toBe(q7(false, SupportKind.Observation));
    expect(q7(true, SupportKind.Observation)).not.toBe(q7(true, SupportKind.Belief));
    expect(signature(QuestionId.Q1, { matches: ["b", "a"] })).toBe(signature(QuestionId.Q1, { matches: ["a", "b"] }));
  });

  it("the O6 matrix starts at the preset configuration and adds the candidates of models.json; Haiku 4.5 only when named", () => {
    const base = Object.fromEntries(
      QUESTION_IDS.map((q) => [q, { model: "claude-sonnet-5-5", effort: Effort.High }]),
    ) as Record<QuestionId, { model: string; effort: Effort.High }>;
    expect(matrix(QuestionId.Q1, base)[0]).toEqual(base.Q1);
    expect(matrix(QuestionId.Q4, base)[0]).toEqual(base.Q4);
    for (const q of QUESTION_IDS)
      expect(
        matrix(q).some((s) => s.model === "claude-haiku-4-5"),
        q,
      ).toBe(false);
    expect(new Set(matrix(QuestionId.Q4).map((s) => `${s.model}/${s.effort}`)).size).toBe(matrix(QuestionId.Q4).length);
  });
});

// Counts the calls per model and answers from the labels of one question.
function counting(q: QuestionId): { t: Transport; models: string[] } {
  const inner = oracleTransport(q);
  const models: string[] = [];
  const t: Transport = {
    send(req, signal) {
      models.push(req.model);
      return inner.send(req, signal);
    },
  };
  return { t, models };
}

interface EntryKey {
  q: QuestionId;
  model: string;
  effort: Effort;
}

const entry = (
  { q, model, effort }: EntryKey,
  runAccuracy: number[],
  finishedAt = "2026-10-09T10:00:00.000Z",
  over: Partial<Entry> = {},
): Entry => ({
  question: q,
  model,
  effort,
  effortSent: model !== "claude-haiku-4-5",
  cases: loadSet(q).cases.length,
  runs: runAccuracy.length,
  runAccuracy,
  mean: runAccuracy.reduce((a, b) => a + b, 0) / runAccuracy.length,
  allRunsPass: runAccuracy.every((x) => x === 1),
  unstable: [],
  failing: [],
  errors: 0,
  usage: { input: 1, output: 1 },
  costEstimateUsd: 0,
  startedAt: finishedAt,
  finishedAt,
  ...over,
});

// The kind of each question for a test of the presets: the named questions classify or judge, the others draft.
const kindsFrom =
  (classification: QuestionId[], judgment: QuestionId[]) =>
  (q: QuestionId): QuestionKind =>
    classification.includes(q)
      ? QuestionKind.Classification
      : judgment.includes(q)
        ? QuestionKind.Judgment
        : QuestionKind.Drafting;

const resultFile = (results: Entry[]) => ({
  startedAt: "x",
  complete: true,
  transport: "fake",
  runs: 3,
  bar: {},
  results,
  summary: [],
});

describe("--model and --effort may repeat (b)", () => {
  it("parses repeated flags, --concurrency, --resume and summarize", () => {
    const a = parseArgs([
      QuestionId.Q4,
      "--model",
      "m1",
      "--model",
      "m2",
      "--effort",
      Effort.Low,
      "--effort",
      Effort.High,
      "--concurrency",
      "12",
      "--resume",
      "f.json",
    ]);
    expect(a).toMatchObject({
      qs: [QuestionId.Q4],
      models: ["m1", "m2"],
      efforts: [Effort.Low, Effort.High],
      concurrency: 12,
      resume: "f.json",
      mode: RunnerMode.Run,
    });
    expect(parseArgs([]).concurrency).toBe(loadModels().concurrency?.start);
    expect(parseArgs(["--full"]).full).toBe(true);
    expect(parseArgs([]).full).toBe(false);
    expect(parseArgs(["summarize", "a.json", "b.json"])).toMatchObject({
      mode: RunnerMode.Summarize,
      files: ["a.json", "b.json"],
    });
  });

  it("the lists multiply, a missing list takes the default, a model without effort has one configuration", () => {
    const key = (cs: { model: string; effort: string }[]) => cs.map((c) => `${c.model}/${c.effort}`);
    const base = Object.fromEntries(
      QUESTION_IDS.map((q) => [q, { model: "claude-haiku-5-5", effort: Effort.Low }]),
    ) as Record<QuestionId, { model: string; effort: Effort.Low }>;
    expect(
      key(
        selectedConfigs(
          QuestionId.Q4,
          { models: ["claude-opus-5-5", "claude-sonnet-5-5"], efforts: [Effort.Medium, Effort.High] },
          base,
        ),
      ),
    ).toEqual(["claude-opus-5-5/medium", "claude-opus-5-5/high", "claude-sonnet-5-5/medium", "claude-sonnet-5-5/high"]);
    expect(key(selectedConfigs(QuestionId.Q4, { models: ["claude-opus-5-5"], efforts: [] }, base))).toEqual([
      "claude-opus-5-5/low",
    ]); // the preset effort of Q4
    expect(key(selectedConfigs(QuestionId.Q4, { models: [], efforts: [Effort.Max] }, base))).toEqual([
      "claude-haiku-5-5/max",
    ]); // the preset model of Q4
    expect(
      key(selectedConfigs(QuestionId.Q1, { models: ["claude-haiku-4-5"], efforts: [Effort.Low, Effort.High] }, base)),
    ).toEqual(["claude-haiku-4-5/low"]);
    expect(selectedConfigs(QuestionId.Q1, { models: [], efforts: [] }, base)).toEqual(matrix(QuestionId.Q1, base));
  });

  it("Claude Haiku 5.5 is a candidate for every kind of question, and its effort is sent", async () => {
    const base = Object.fromEntries(
      QUESTION_IDS.map((q) => [q, { model: "claude-opus-5-5", effort: Effort.Low }]),
    ) as Record<QuestionId, { model: string; effort: Effort.Low }>;
    const h = (q: QuestionId) =>
      matrix(q, base)
        .filter((s) => s.model === "claude-haiku-5-5")
        .map((s) => s.effort);
    for (const q of [QuestionId.Q1, QuestionId.Q4, QuestionId.Q5, QuestionId.Q8, QuestionId.Q10] as const)
      expect(h(q).length, q).toBeGreaterThan(0);
    expect(matrix(QuestionId.Q1).some((s) => s.model === "claude-haiku-4-5")).toBe(false); // only when named with --model
    const c = counting(QuestionId.Q1);
    const f = await runSets(
      A([QuestionId.Q1], 1, 3, {
        models: ["claude-haiku-5-5", "claude-haiku-4-5"],
        efforts: [Effort.Low, Effort.Medium],
      }),
      T(c.t, tmp()),
    );
    expect(f.results.map((r) => `${r.model}/${r.effort}/${r.effortSent}`).sort()).toEqual([
      "claude-haiku-4-5/low/false",
      "claude-haiku-5-5/low/true",
      "claude-haiku-5-5/medium/true",
    ]);
  });

  it("the runner runs only the selected configurations", async () => {
    const c = counting(QuestionId.Q1);
    const f = await runSets(
      A([QuestionId.Q1], 1, 4, { models: ["claude-opus-5-5"], efforts: [Effort.Low, Effort.Medium] }),
      T(c.t, tmp()),
    );
    expect(f.results.map((r) => `${r.model}/${r.effort}`)).toEqual(["claude-opus-5-5/low", "claude-opus-5-5/medium"]);
    expect(new Set(c.models)).toEqual(new Set(["claude-opus-5-5"]));
  });
});

const tmp = () => join(mkdtempSync(join(tmpdir(), "qrun-")), "out.json");

describe("--resume (c)", () => {
  it("skips what the file holds, runs the new model, and writes a new file with both", async () => {
    const first = tmp();
    const c1 = counting(QuestionId.Q1);
    await runSets(A([QuestionId.Q1], 1, undefined, { models: ["claude-haiku-4-5"] }), T(c1.t, first));
    expect(readResultFile(first).results).toHaveLength(1);

    const second = tmp();
    const c2 = counting(QuestionId.Q1);
    const f = await runSets(
      A([QuestionId.Q1], 1, undefined, { models: ["claude-haiku-4-5", "claude-sonnet-5-5"], efforts: [Effort.Low] }),
      T(c2.t, second, undefined, { file: readResultFile(first), path: first }),
    );
    expect(new Set(c2.models)).toEqual(new Set(["claude-sonnet-5-5"])); // haiku was not called again
    const disk = readResultFile(second);
    expect(disk.results.map((r) => r.model).sort()).toEqual(["claude-haiku-4-5", "claude-sonnet-5-5"]);
    expect(disk.resumedFrom).toBe(first);
    expect(disk.complete).toBe(true);
    expect(f.results).toHaveLength(2);
    expect(readResultFile(first).results).toHaveLength(1); // the old file is not touched
  });

  it("runs again a configuration the file holds with fewer runs", async () => {
    const first = tmp();
    await runSets(
      A([QuestionId.Q7], 1, undefined, { models: ["claude-haiku-4-5"] }),
      T(counting(QuestionId.Q7).t, first),
    );
    const c = counting(QuestionId.Q7);
    await runSets(
      A([QuestionId.Q7], 2, undefined, { models: ["claude-haiku-4-5"] }),
      T(c.t, tmp(), undefined, { file: readResultFile(first), path: first }),
    );
    expect(c.models.length).toBeGreaterThan(0);
  });
});

describe("the pass bar and summarize (d)", () => {
  it("the bar text names the strict questions and the figures of the bar", () => {
    // The pass logic itself is the requirement test `Question accuracy`.
    const bar = { strict: [QuestionId.Q1], strictMean: 1, strictMinRun: 1, mean: 0.9, minRun: 0.85 };
    const text = barText(bar);
    for (const s of ["Q1", "90%", "85%"]) expect(text).toContain(s);
    expect(barText({ ...bar, strict: [] })).not.toContain("Q1");
  });

  it("poolEntries pools all runs of a configuration over two result objects", () => {
    const a = entry(
      { q: QuestionId.Q4, model: "claude-sonnet-5-5", effort: Effort.Medium },
      [1, 0.9],
      "2026-10-09T10:00:00.000Z",
      {
        errors: 1,
        failing: ["c1: x"],
        costEstimateUsd: 0.5,
        usage: { input: 10, output: 2 },
      },
    );
    const b = entry(
      { q: QuestionId.Q4, model: "claude-sonnet-5-5", effort: Effort.Medium },
      [0.8],
      "2026-10-09T11:00:00.000Z",
      {
        errors: 2,
        failing: ["c1: x", "c2: y"],
        costEstimateUsd: 0.25,
        usage: { input: 5, output: 1 },
      },
    );
    const other = entry(
      { q: QuestionId.Q4, model: "claude-opus-5-5", effort: Effort.High },
      [1],
      "2026-10-09T10:30:00.000Z",
    );
    const pooled = poolEntries([a, other, b, { ...a }]); // a copy of `a` (a resumed file) counts once
    expect(pooled).toHaveLength(2);
    const p = must(
      pooled.find((e) => e.model === "claude-sonnet-5-5"),
      "no pooled entry for Sonnet",
    );
    expect(p.runAccuracy).toEqual([1, 0.9, 0.8]);
    expect(p.runs).toBe(3);
    expect(p.mean).toBeCloseTo(0.9, 10);
    expect(p.allRunsPass).toBe(false);
    expect(p.errors).toBe(3);
    expect(p.failing).toEqual(["c1: x", "c2: y"]);
    expect(p.usage).toEqual({ input: 15, output: 3 });
    expect(p.costEstimateUsd).toBeCloseTo(0.75, 10);
    expect(p.startedAt).toBe(a.startedAt);
    expect(p.finishedAt).toBe(b.finishedAt);
    expect(pooled.find((e) => e.model === "claude-opus-5-5")?.runs).toBe(1);
  });

  it("poolEntries gives the interval and the kinds from the counts of all pooled runs", () => {
    const key = { q: QuestionId.Q1, model: "claude-sonnet-5-5", effort: Effort.Medium };
    const kind = HardNegativeKind.Negation;
    const STALE: [number, number] = [0.01, 0.02];
    const a = entry(key, [1, 0.5], "2026-10-09T10:00:00.000Z", {
      ci: STALE,
      kinds: { [kind]: { cases: 4, mean: 0.5, ci: STALE, missed: ["x"] } },
    });
    const b = entry(key, [1], "2026-10-09T11:00:00.000Z", {
      ci: STALE,
      kinds: { [kind]: { cases: 4, mean: 1, ci: STALE, missed: [] } },
    });
    const p = must(poolEntries([a, b])[0], "no pooled entry");
    const answers = a.cases * 3;
    expect(p.ci).toEqual(wilsonInterval(Math.round(((1 + 0.5 + 1) / 3) * answers), answers));
    // 4 cases: 2 of 4 right in each of 2 runs and 4 of 4 in 1 run make 8 of 12
    const pooledKind = must(p.kinds?.[kind], "no pooled kind");
    expect(pooledKind.cases).toBe(4);
    expect(pooledKind.mean).toBeCloseTo(8 / 12, 10);
    expect(pooledKind.ci).toEqual(wilsonInterval(8, 12));
    expect(pooledKind.missed).toEqual(["x"]);
  });

  it("poolEntries pools the halves and the case pass rates over all pooled runs", () => {
    const key = { q: QuestionId.Q7, model: "claude-sonnet-5-5", effort: Effort.Medium };
    const score = (mean: number) => ({ cases: 4, mean });
    const a = entry(key, [1, 0.5], "2026-10-09T10:00:00.000Z", {
      halves: { heldOut: { ...score(0.5) }, tuning: { ...score(1) } },
      casePassRate: { c1: 0.5, c2: 1 },
      cache: { read: 10, write: 1 },
    });
    const b = entry(key, [1], "2026-10-09T11:00:00.000Z", {
      halves: { heldOut: { ...score(1) }, tuning: { ...score(0.75) } },
      casePassRate: { c1: 1, c2: 0, c3: 1 },
      cache: { read: 20, write: 2 },
    });
    const p = must(poolEntries([a, b])[0], "no pooled entry");
    expect(p.halves?.runs).toBe(3);
    expect(p.cache).toEqual({ read: 30, write: 3 });
    // held-out: 2 of 4 in each of 2 runs and 4 of 4 in 1 run make 8 of 12; tuning: 4 of 4 twice and 3 of 4 make 11 of 12
    expect(p.halves?.heldOut.cases).toBe(4);
    expect(p.halves?.heldOut.mean).toBeCloseTo(8 / 12, 10);
    expect(p.halves?.heldOut.ci).toEqual(wilsonInterval(8, 12));
    expect(p.halves?.tuning.mean).toBeCloseTo(11 / 12, 10);
    expect(p.halves?.tuning.ci).toEqual(wilsonInterval(11, 12));
    // c1: 1 pass of 2 runs and 1 of 1 make 2 of 3; c3 is in the newer entry only
    expect(p.casePassRate?.c1).toBeCloseTo(2 / 3, 10);
    expect(p.casePassRate?.c2).toBeCloseTo(2 / 3, 10);
    expect(p.casePassRate?.c3).toBe(1);
  });

  it("poolEntries counts in halves.runs only the runs of the entries that hold the split", () => {
    const key = { q: QuestionId.Q7, model: "claude-sonnet-5-5", effort: Effort.Medium };
    const a = entry(key, [1, 1], "2026-10-09T10:00:00.000Z", {
      halves: { heldOut: { cases: 4, mean: 0.5 }, tuning: { cases: 4, mean: 1 } },
    });
    const b = entry(key, [1], "2026-10-09T11:00:00.000Z");
    const p = must(poolEntries([a, b])[0], "no pooled entry");
    expect(p.runs).toBe(3);
    expect(p.halves?.runs).toBe(2);
    expect(p.halves?.heldOut.mean).toBe(0.5);
    expect(p.cache).toBeUndefined();
  });

  it("summarize pools the runs of two files and applies the pass checks to the pooled runs", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "qsum-")), "results");
    mkdirSync(dir, { recursive: true });
    const a = join(dir, "a.json");
    const b = join(dir, "b.json");
    // Alone, a has a mean of 0.95 and passes; b has runs under 0.85 and fails. Pooled: mean 0.8667, run 0.7: does not pass.
    writeFileSync(
      a,
      JSON.stringify(
        resultFile([
          entry(
            { q: QuestionId.Q8, model: "claude-haiku-5-5", effort: Effort.Low },
            [1, 0.9, 0.95],
            "2026-10-09T10:00:00.000Z",
          ),
        ]),
      ),
    );
    writeFileSync(
      b,
      JSON.stringify(
        resultFile([
          entry(
            { q: QuestionId.Q8, model: "claude-haiku-5-5", effort: Effort.Low },
            [0.7, 0.8, 0.85],
            "2026-10-09T11:00:00.000Z",
          ),
          entry(
            { q: QuestionId.Q8, model: "claude-haiku-5-5", effort: Effort.Low },
            [0.1],
            "2026-10-09T12:00:00.000Z",
            { cases: 1 },
          ), // a smoke run: not pooled
        ]),
      ),
    );
    const p = summarize([a, b], join(dir, "s.json"), () => undefined, join(dir, "presets.json"));
    expect(p.configurations).toHaveLength(1);
    expect(p.configurations[0]).toMatchObject({ runs: 6 });
    expect(p.configurations[0]?.runAccuracy).toEqual([1, 0.9, 0.95, 0.7, 0.8, 0.85]);
    expect(p.configurations[0]?.mean).toBeCloseTo(5.2 / 6, 10);
    expect(p.proposal.Q8?.passes).toBe(false);
    // The presets file holds the model and effort per question and the name of the summary file, nothing measured.
    const shipped = JSON.parse(readFileSync(join(dir, "presets.json"), "utf8")) as Record<string, unknown>;
    expect(shipped).toEqual({
      source: "s.json",
      presets: {
        budget: { Q8: { model: "claude-haiku-5-5", effort: Effort.Low } },
        standard: { Q8: { model: "claude-haiku-5-5", effort: Effort.Low } },
        premium: { Q8: { model: "claude-haiku-5-5", effort: Effort.Low } },
      },
    });
    // The summary file keeps the measurement: mean and cost per pick, the rules, the source files, the time.
    const disk = JSON.parse(readFileSync(join(dir, "s.json"), "utf8")) as Proposal;
    expect(disk.presets.presets.budget.Q8).toMatchObject({
      model: "claude-haiku-5-5",
      effort: Effort.Low,
      costUsd: p.configurations[0]?.costEstimateUsd,
      flagged: true,
    });
    expect(disk.presets.presets.budget.Q8?.mean).toBeCloseTo(5.2 / 6, 10);
    expect(disk.presets.sourceFiles).toEqual(p.sources);
    expect(Date.parse(disk.presets.generatedAt)).not.toBeNaN();
  });

  it("merges files, pools the runs per configuration, and proposes the cheapest passing one per question", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "qsum-")), "results");
    mkdirSync(dir, { recursive: true });
    const a = join(dir, "a.json");
    const b = join(dir, "b.json");
    writeFileSync(
      a,
      JSON.stringify(
        resultFile([
          entry(
            { q: QuestionId.Q4, model: "claude-sonnet-5-5", effort: Effort.Medium },
            [0.8, 0.8, 0.8],
            "2026-10-09T10:00:00.000Z",
          ), // later replaced
          entry(
            { q: QuestionId.Q4, model: "claude-opus-5-5", effort: Effort.High },
            [1, 1, 1],
            "2026-10-09T10:01:00.000Z",
          ),
          entry(
            { q: QuestionId.Q1, model: "claude-haiku-4-5", effort: Effort.Low },
            [1, 1, 0.97],
            "2026-10-09T10:02:00.000Z",
          ),
          entry(
            { q: QuestionId.Q1, model: "claude-sonnet-5-5", effort: Effort.Low },
            [1, 1, 0.99],
            "2026-10-09T10:03:00.000Z",
          ),
          entry(
            { q: QuestionId.Q7, model: "claude-haiku-4-5", effort: Effort.Low },
            [1, 1, 1],
            "2026-10-09T10:04:00.000Z",
            { cases: 5 },
          ), // a smoke run: ignored
        ]),
      ),
    );
    writeFileSync(
      b,
      JSON.stringify(
        resultFile([
          entry(
            { q: QuestionId.Q4, model: "claude-sonnet-5-5", effort: Effort.Medium },
            [0.93, 0.93, 0.9],
            "2026-10-09T11:00:00.000Z",
          ), // the later result passes
        ]),
      ),
    );
    writeFileSync(join(dir, "summary-old.json"), JSON.stringify({ lines: [] })); // not a result file

    const lines: string[] = [];
    const out = join(dir, "summary-new.json");
    const p = summarize([a, b, join(dir, "summary-old.json")], out, (s) => lines.push(s));
    // The sources are relative to the project root, with forward slashes: no local path in the file.
    expect(p.sources).toEqual([relativeToRoot(a), relativeToRoot(b)]);
    for (const s of p.sources) {
      expect(isAbsolute(s)).toBe(false);
      expect(s).not.toContain("\\");
    }
    expect(p.configurations).toHaveLength(4);
    // Sonnet medium: the later runs pass alone, but pooled with the earlier 0.8 runs it fails, so Opus is the cheapest passing.
    expect(p.proposal.Q4?.cheapestPassing).toMatchObject({ model: "claude-opus-5-5", effort: Effort.High });
    expect(p.proposal.Q4?.passes).toBe(true);
    // Q1 is on the general bar now (no strict question): the cheaper Haiku 4.5 at a mean of 99 percent passes.
    expect(p.proposal.Q1?.passes).toBe(true);
    expect(p.proposal.Q1?.cheapestPassing).toMatchObject({ model: "claude-haiku-4-5" });
    expect(p.proposal.Q7).toBeUndefined(); // only the smoke entry
    const text = lines.join("\n");
    for (const s of ["Q4", "claude-opus-5-5", "high", "Q1", "claude-haiku-4-5"]) expect(text).toContain(s);
    const disk = JSON.parse(readFileSync(out, "utf8")) as Proposal;
    expect(disk.barText).toBeTruthy();
    expect(disk.bar.strict).toEqual(loadModels().passBar.strict);
    expect(disk.lines).toEqual(p.lines);
  });

  it("Haiku 5.5 ranks cheapest by its price from models.json", () => {
    const f = join(mkdtempSync(join(tmpdir(), "qsum-")), "r.json");
    writeFileSync(
      f,
      JSON.stringify(
        resultFile([
          entry({ q: QuestionId.Q8, model: "claude-haiku-4-5", effort: Effort.Low }, [1, 1, 1]),
          entry({ q: QuestionId.Q8, model: "claude-haiku-5-5", effort: Effort.Medium }, [1, 1, 1]),
          entry({ q: QuestionId.Q8, model: "claude-haiku-5-5", effort: Effort.Low }, [0.95, 0.95, 0.95]),
        ]),
      ),
    );
    const p = summarize([f], join(mkdtempSync(join(tmpdir(), "qsum-")), "s.json"), () => undefined);
    expect(p.proposal.Q8?.cheapestPassing).toMatchObject({ model: "claude-haiku-5-5", effort: Effort.Low });
  });

  it("the cheapest passing configuration wins on price, not on score", () => {
    const f = join(mkdtempSync(join(tmpdir(), "qsum-")), "r.json");
    writeFileSync(
      f,
      JSON.stringify(
        resultFile([
          entry({ q: QuestionId.Q8, model: "claude-opus-5-5", effort: Effort.Low }, [1, 1, 1]),
          entry({ q: QuestionId.Q8, model: "claude-haiku-4-5", effort: Effort.Low }, [0.92, 0.92, 0.92]),
        ]),
      ),
    );
    const p = summarize([f], join(mkdtempSync(join(tmpdir(), "qsum-")), "s.json"), () => undefined);
    expect(p.proposal.Q8?.cheapestPassing).toMatchObject({ model: "claude-haiku-4-5" });
  });

  it("the standard preset takes the best mean for classification and judgment, the cheapest passing configuration for drafting", () => {
    const opts = {
      passBar: { strict: [], strictMean: 1, strictMinRun: 1, mean: 0.9, minRun: 0.85 },
      kindOf: kindsFrom([QuestionId.Q1], [QuestionId.Q4]),
    };
    const cheap = "claude-haiku-5-5";
    const dear = "claude-opus-5-5";
    const configs = [
      // classification: the dearer configuration has the better mean, and wins in standard; budget keeps the cheap passing one
      entry({ q: QuestionId.Q1, model: cheap, effort: Effort.Low }, [0.92, 0.92, 0.92]),
      entry({ q: QuestionId.Q1, model: dear, effort: Effort.Low }, [1, 1, 1]),
      // judgment: same rule as classification
      entry({ q: QuestionId.Q4, model: cheap, effort: Effort.Low }, [0.91, 0.91, 0.91]),
      entry({ q: QuestionId.Q4, model: dear, effort: Effort.High }, [0.98, 0.98, 0.98]),
      // drafting: the cheap one passes, so it wins although its mean is lower
      entry({ q: QuestionId.Q3, model: cheap, effort: Effort.Low }, [0.93, 0.93, 0.93]),
      entry({ q: QuestionId.Q3, model: dear, effort: Effort.High }, [1, 1, 1]),
      // drafting, none passes: the best mean, flagged
      entry({ q: QuestionId.Q5, model: cheap, effort: Effort.Low }, [0.7, 0.7, 0.7]),
      entry({ q: QuestionId.Q5, model: dear, effort: Effort.High }, [0.8, 0.8, 0.8]),
    ];
    const { presets, bars } = buildPresets(configs, [], opts);
    expect(presets.standard?.Q1).toMatchObject({ model: dear, effort: Effort.Low });
    expect(presets.standard?.Q4).toMatchObject({ model: dear, effort: Effort.High });
    expect(presets.standard?.Q3).toMatchObject({ model: cheap, effort: Effort.Low });
    expect(presets.standard?.Q3?.flagged).toBeUndefined();
    expect(presets.standard?.Q5).toMatchObject({ model: dear, effort: Effort.High, flagged: true });
    expect(presets.budget?.Q1).toMatchObject({ model: cheap });
    for (const s of ["Q3", "Q5"]) expect(JSON.stringify(bars.standard)).toContain(s);
    // premium: the best mean on every question, drafting included
    expect(presets.premium?.Q1).toMatchObject({ model: dear, effort: Effort.Low });
    expect(presets.premium?.Q4).toMatchObject({ model: dear, effort: Effort.High });
    expect(presets.premium?.Q3).toMatchObject({ model: dear, effort: Effort.High });
    expect(presets.premium?.Q3?.flagged).toBeUndefined();
    expect(presets.premium?.Q5).toMatchObject({ model: dear, effort: Effort.High });
    expect(presets.premium?.Q5?.flagged).toBeUndefined();
    expect(Object.keys(presets)).toEqual(["budget", "standard", "premium"]); // no economy table
  });

  it("a pick of a question with 1 pooled configuration is marked, and summarize prints the question", () => {
    const cheap = "claude-haiku-5-5";
    const { presets } = buildPresets(
      [
        entry({ q: QuestionId.Q3, model: cheap, effort: Effort.Low }, [1, 1, 1]),
        entry({ q: QuestionId.Q8, model: cheap, effort: Effort.Low }, [1, 1, 1]),
        entry({ q: QuestionId.Q8, model: "claude-opus-5-5", effort: Effort.Low }, [1, 1, 1]),
      ],
      [],
    );
    for (const table of [presets.budget, presets.standard, presets.premium]) {
      expect(table?.Q3?.singleConfiguration).toBe(true);
      expect(table?.Q8?.singleConfiguration).toBeUndefined();
    }
    const f = join(mkdtempSync(join(tmpdir(), "qsum-")), "r.json");
    writeFileSync(
      f,
      JSON.stringify(resultFile([entry({ q: QuestionId.Q8, model: cheap, effort: Effort.Low }, [1, 1, 1])])),
    );
    const lines: string[] = [];
    const proposal = summarize([f], join(mkdtempSync(join(tmpdir(), "qsum-")), "s.json"), (s) => lines.push(s));
    // The data carries the flag; the printed line of each preset names the question (never checked by its wording).
    for (const table of [
      proposal.presets.presets.budget,
      proposal.presets.presets.standard,
      proposal.presets.presets.premium,
    ]) {
      expect(table.Q8?.singleConfiguration).toBe(true);
    }
    for (const name of ["budget", "standard", "premium"]) {
      const line = lines.find((l) => l.trimStart().startsWith(`${name}:`));
      expect(line).toMatch(/\bQ8\b/);
    }
  });

  it("the standard preset takes the cheapest among tied best means for classification", () => {
    const p = buildPresets(
      [
        entry({ q: QuestionId.Q1, model: "claude-opus-5-5", effort: Effort.Low }, [1, 1, 1]),
        entry({ q: QuestionId.Q1, model: "claude-haiku-5-5", effort: Effort.Low }, [1, 1, 1]),
      ],
      [],
      { kindOf: kindsFrom([QuestionId.Q1], []) },
    );
    expect(p.presets.standard?.Q1).toMatchObject({ model: "claude-haiku-5-5" });
  });

  it("the result file records the bar", async () => {
    const f = await runSets(
      A([QuestionId.Q1], 1, 3, { models: ["claude-haiku-4-5"] }),
      T(counting(QuestionId.Q1).t, tmp()),
    );
    expect(f.bar.strict).toEqual(loadModels().passBar.strict);
  });
});

describe("short form of a fact", () => {
  it("marks an older version as deleted", () => {
    const input = expandInput(QuestionId.Q4, {
      existing: {
        id: "f1",
        header: "h",
        content: "now",
        older: [{ content: "gone", deleted: true }, { content: "first" }],
      },
    });
    const existing = input.existing as { versions: { content: string; isDeleted: boolean }[] };
    expect(existing.versions.map((v) => [v.content, v.isDeleted])).toEqual([
      ["now", false],
      ["gone", true],
      ["first", false],
    ]);
  });

  it("compacts a fact of the long form, and expands it back", () => {
    const short = {
      existing: {
        id: "f1",
        header: "h",
        content: "now",
        just: "j",
        refs: ["r"],
        older: [
          { content: "gone", header: "old h", deleted: true },
          { content: "first", just: "k" },
        ],
      },
      related: [{ id: "f2", header: "h2", content: "c2", deleted: true }],
    };
    const long = expandInput(QuestionId.Q4, short);
    expect(compactInput(QuestionId.Q4, long)).toEqual(short);
    expect(compactInput(QuestionId.Q4, { change: "x", existing: "not a fact" })).toEqual({
      change: "x",
      existing: "not a fact",
    });
  });
});

describe("hard negatives", () => {
  const caseOf = (id: string, over: Partial<Case> = {}): Case => ({
    id,
    note: "n",
    input: { change: "c", candidates: [] },
    expect: { matches: [] },
    ...over,
  });
  const validate = (cases: Case[]): { bad: number; lines: string[] } => {
    const lines: string[] = [];
    const bad = validateSets(
      [QuestionId.Q1],
      (s) => lines.push(s),
      () => ({ question: QuestionId.Q1, cases }),
    );
    return { bad, lines };
  };

  it("the validator accepts a known kind and rejects another", () => {
    expect(validate([caseOf("a", { kind: HardNegativeKind.Negation, family: "f" })]).bad).toBe(0);
    const r = validate([caseOf("a", { kind: "other" as HardNegativeKind })]);
    expect(r.bad).toBe(1);
    expect(r.lines.join("\n")).toContain("unknown kind");
  });

  it("the validator rejects a family with cases on both sides of the held-out split", () => {
    const split = validate([caseOf("a", { family: "f", heldOut: true }), caseOf("b", { family: "f" })]);
    expect(split.bad).toBe(1);
    expect(split.lines.join("\n")).toContain("both sides");
    const together = [caseOf("a", { family: "f", heldOut: true }), caseOf("b", { family: "f", heldOut: true })];
    expect(validate(together).bad).toBe(0);
    expect(validate([caseOf("a", { family: "f" }), caseOf("b", { family: "f" })]).bad).toBe(0);
  });

  it("the report prints the cases, the mean and the interval of each kind, and the interval of the configuration", async () => {
    const lines: string[] = [];
    const f = await runSets(
      A([QuestionId.Q1], 2, undefined, { models: ["claude-haiku-4-5"], full: true }),
      T(oracleTransport(QuestionId.Q1), tmp(), (s) => lines.push(s)),
    );
    const r = must(f.results[0], "no result");
    const kinds = must(r.kinds, "no kinds");
    const PERCENT = 100;
    const INTERVAL = /\[(\d+\.\d)–(\d+\.\d)\]/;
    const printed = lines.filter((l) => l.trimStart().startsWith("kind "));
    for (const k of Object.values(HardNegativeKind)) {
      const line = must(
        printed.find((l) => l.trimStart().startsWith(`kind ${k}:`)),
        `no line for ${k}`,
      );
      const score = must(kinds[k], k);
      const ci = must(score.ci, `no interval of ${k}`);
      const m = must(INTERVAL.exec(line), `no interval on ${line}`);
      expect(line, k).toContain(`${score.cases} cases`);
      expect(Number(m[1]), k).toBeCloseTo(ci[0] * PERCENT, 1);
      expect(Number(m[2]), k).toBeCloseTo(ci[1] * PERCENT, 1);
    }
    const main = must(
      lines.find((l) => l.includes("stage")),
      "no line of the configuration",
    );
    const mm = must(INTERVAL.exec(main), "no interval on the line of the configuration");
    const rci = must(r.ci, "no interval");
    expect(Number(mm[1])).toBeCloseTo(rci[0] * PERCENT, 1);
    expect(Number(mm[2])).toBeCloseTo(rci[1] * PERCENT, 1);
  });
});
