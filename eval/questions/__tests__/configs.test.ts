import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPresets } from "../../../src/config/index.js";
import { EnvVar, Quality, QuestionId } from "../../../src/domain/index.js";
import { presetQuestions } from "../configs.js";
import { MODELS } from "../models.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

// A copy of the presets file without the given questions in the standard table, named by WIKIFACT_PRESETS.
function presetsWithout(...missing: QuestionId[]): void {
  const file = loadPresets();
  const standard: Record<string, unknown> = { ...file.presets[Quality.Standard] };
  for (const q of missing) delete standard[q];
  const dir = mkdtempSync(join(tmpdir(), "wikifact-presets-"));
  const path = join(dir, "presets.json");
  writeFileSync(path, JSON.stringify({ ...file, presets: { ...file.presets, [Quality.Standard]: standard } }));
  vi.stubEnv(EnvVar.WikifactPresets, path);
}

describe("presetQuestions", () => {
  it("returns the settings of the presets file for the questions it holds", () => {
    const real = presetQuestions();
    presetsWithout(QuestionId.Q10);
    const partial = presetQuestions();
    expect(partial[QuestionId.Q1]).toEqual(real[QuestionId.Q1]);
  });

  it("starts a question that the file lacks on the first candidate model at the first effort of its kind", () => {
    presetsWithout(QuestionId.Q10, QuestionId.Q1);
    const settings = presetQuestions();
    const model = MODELS.models.find((m) => m.candidate);
    expect(model).toBeDefined();
    // Q1 is a classification, Q10 a judgment: the efforts of the model replace those of the kind.
    const first = model?.efforts?.[0];
    expect(first).toBeDefined();
    expect(settings[QuestionId.Q10]).toEqual({ model: model?.id, effort: first });
    expect(settings[QuestionId.Q1]).toEqual({ model: model?.id, effort: first });
  });
});
