import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig, loadPresets, parseConfig, presetsPath } from "../index.js";
import { readEnv } from "../../env.js";
import { QuestionId } from "../../domain/enums.js";

// Every test here uses a fixture presets file in a temp dir. The real file is the default configuration; no test pins its values.
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wikifact-presets-"));
});

const entry = (model: string, effort: string) => ({ model, effort });
function table(model: string, effort: string, skip: string[] = []) {
  const t: Record<string, unknown> = {};
  for (const id of Object.values(QuestionId)) if (!skip.includes(id)) t[id] = entry(model, effort);
  return t;
}
function writePresets(p: unknown): string {
  const path = join(dir, "presets.json");
  writeFileSync(path, JSON.stringify(p));
  return path;
}
const good = () => ({
  source: "summary-2026-10-10T00-00-00.000Z.json",
  presets: {
    budget: table("budget-model", "low"),
    standard: table("std-model", "high"),
    premium: table("premium-model", "max"),
  },
});
const dbPath = () => join(dir, "g.sqlite");

describe("quality presets", () => {
  it("applies the standard preset by default and ignores a table with an unknown name", () => {
    const p = good();
    const withExtra = { ...p, presets: { ...p.presets, extra: table("extra-model", "low") } };
    const c = loadConfig(dbPath(), { presetsPath: writePresets(withExtra) });
    expect(c.quality).toBe("standard");
    for (const q of Object.values(c.questions)) expect(q).toEqual({ model: "std-model", effort: "high" });
  });

  it("ignores the entries of the removed questions Q7B and Q5B", () => {
    const p = good();
    const withRemoved = {
      ...p,
      presets: {
        ...p.presets,
        standard: {
          ...p.presets.standard,
          Q7B: entry("old", "low"),
          Q5B: entry("old", "low"),
        },
      },
    };
    const loaded = loadPresets({ path: writePresets(withRemoved) });
    expect(Object.keys(loaded.presets.standard ?? {})).not.toContain("Q5B");
    const c = loadConfig(dbPath(), { presetsPath: writePresets(withRemoved) });
    expect(c.questions.Q5).toEqual({ model: "std-model", effort: "high" });
  });

  it("budget picks the budget table", () => {
    writeFileSync(join(dir, "wikifact.json"), JSON.stringify({ quality: "budget" }));
    const c = loadConfig(dbPath(), { presetsPath: writePresets(good()) });
    expect(c.quality).toBe("budget");
    expect(c.questions.Q5).toEqual({ model: "budget-model", effort: "low" });
  });

  it("premium picks the premium table", () => {
    writeFileSync(join(dir, "wikifact.json"), JSON.stringify({ quality: "premium" }));
    const c = loadConfig(dbPath(), { presetsPath: writePresets(good()) });
    expect(c.quality).toBe("premium");
    expect(c.questions.Q5).toEqual({ model: "premium-model", effort: "max" });
  });

  it("a wikifact.json entry wins over the preset", () => {
    writeFileSync(join(dir, "wikifact.json"), JSON.stringify({ questions: { Q2: { model: "mine", effort: "max" } } }));
    const c = loadConfig(dbPath(), { presetsPath: writePresets(good()) });
    expect(c.questions.Q2).toEqual({ model: "mine", effort: "max" });
    expect(c.questions.Q3.model).toBe("std-model");
  });

  it("throws and names the file when the presets file is missing", () => {
    const path = join(dir, "none.json");
    expect(() => loadConfig(dbPath(), { presetsPath: path })).toThrow(path);
    expect(() => loadPresets({ path })).toThrow(/missing/);
  });

  it("throws and names the file and the question when a table lacks a question", () => {
    const path = writePresets({ presets: { standard: table("std-model", "low", ["Q3"]) } });
    expect(() => loadConfig(dbPath(), { presetsPath: path })).toThrow(
      new RegExp(`${path.replace(/[\\.]/g, "\\$&")}.*Q3|Q3.*${path.replace(/[\\.]/g, "\\$&")}`),
    );
  });

  it("reads a file with no group sizes, and drops the group sizes and the entries of the removed tag questions of an older file", () => {
    const p = good();
    const older = {
      ...p,
      groupSizes: { Q11B: 7 },
      presets: {
        ...p.presets,
        standard: { ...p.presets.standard, Q11: entry("old", "low"), Q14: entry("old", "low") },
      },
    };
    const path = writePresets(older);
    const loaded = loadPresets({ path });
    expect(loaded).not.toHaveProperty("groupSizes");
    expect(Object.keys(loaded.presets.standard ?? {})).not.toContain("Q14");
    const c = loadConfig(dbPath(), { presetsPath: path });
    expect(c).not.toHaveProperty("groupSizes");
    expect(Object.keys(c.questions)).not.toContain("Q11");
  });

  it("drops the entries of the removed questions in the questions of a wiki config", () => {
    const c = parseConfig(
      {
        questions: {
          Q1: entry("own-model", "low"),
          Q11: entry("old", "low"),
          Q11B: entry("old", "low"),
          Q15: entry("old", "low"),
        },
      },
      { presets: loadPresets() },
    );
    expect(c.questions.Q1).toEqual(entry("own-model", "low"));
    expect(Object.keys(c.questions).sort()).toEqual(Object.values(QuestionId).sort());
  });

  it("throws and names the file when the table of the chosen quality is absent", () => {
    const path = writePresets({ presets: { standard: table("std-model", "low") } });
    writeFileSync(join(dir, "wikifact.json"), JSON.stringify({ quality: "budget" }));
    expect(() => loadConfig(dbPath(), { presetsPath: path })).toThrow(/"budget" table/);
    expect(() => loadConfig(dbPath(), { presetsPath: path })).toThrow(path);
  });

  it("throws and names the file for an invalid file", () => {
    for (const bad of [{ presets: { standard: { Q1: { model: "m", effort: "turbo" } } } }, { nope: 1 }]) {
      const path = writePresets(bad);
      expect(() => loadPresets({ path })).toThrow(path);
    }
    const path = join(dir, "presets.json");
    writeFileSync(path, "{ not json");
    expect(() => loadPresets({ path })).toThrow(/invalid/);
  });

  it("reads the source line and ignores a key it does not know", () => {
    const presets = loadPresets({ path: writePresets({ ...good(), note: "x" }) });
    expect(presets.source).toBe("summary-2026-10-10T00-00-00.000Z.json");
    expect(presets).not.toHaveProperty("note");
  });

  it("rejects an unknown quality name", () => {
    const presets = loadPresets({ path: writePresets(good()) });
    expect(() => parseConfig({ quality: "economy" }, { presets })).toThrow();
    expect(() => parseConfig({ quality: "ultra" }, { presets })).toThrow();
  });

  it("WIKIFACT_PRESETS overrides the path", () => {
    expect(presetsPath(readEnv({ WIKIFACT_PRESETS: "/x/p.json" }))).toBe("/x/p.json");
    expect(presetsPath(readEnv({}))).toMatch(/[\\/]config[\\/]presets\.json$/);
  });

  it("parseConfig with the loaded presets builds the questions from the chosen table", () => {
    const presets = loadPresets({ path: writePresets(good()) });
    expect(parseConfig({ subject: "S" }, { presets }).questions.Q10).toEqual({ model: "std-model", effort: "high" });
    expect(parseConfig({ quality: "budget" }, { presets }).questions.Q10).toEqual({
      model: "budget-model",
      effort: "low",
    });
  });

  it("the shipped presets file has a full table for each quality", () => {
    const presets = loadPresets();
    for (const quality of ["budget", "standard", "premium"] as const) {
      expect(Object.keys(parseConfig({ quality }, { presets }).questions)).toHaveLength(
        Object.values(QuestionId).length,
      );
    }
  });
});
