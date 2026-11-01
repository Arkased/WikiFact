// The configurations (model and effort) that the runner tries for a question.
import { QUESTION_IDS, loadPresets, parseConfig, type QuestionSettings } from "../../src/config/index.js";
import { Effort, Quality, QuestionId, QuestionKind } from "../../src/domain/index.js";
import { must } from "../lib/questions-guard.js";
import { MODELS, kindOf, takesEffort } from "./models.js";

/**
 * Names a configuration. A model without effort has one configuration, whatever the effort in the config says.
 *
 * @param model - the API model id
 * @param effort - the effort of the configuration
 * @returns a key that is equal for two configurations that call the model the same way
 * @sideEffects none
 */
function configKey(model: string, effort: string): string {
  return `${model}|${takesEffort(model) ? effort : "-"}`;
}

function dedupe(cs: QuestionSettings[]): QuestionSettings[] {
  const seen = new Set<string>();
  return cs.filter((c) => {
    const k = configKey(c.model, c.effort);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// The start of a question that the presets file does not hold yet (a new question, before its first `summarize`):
// the first candidate model of models.json at the first effort of the question's kind.
function startConfig(q: QuestionId): QuestionSettings {
  const model = must(
    MODELS.models.find((m) => m.candidate),
    "models.json has no candidate model",
  );
  const efforts =
    model.efforts ?? (kindOf(q) === QuestionKind.Classification ? MODELS.efforts.classification : MODELS.efforts.other);
  return { model: model.id, effort: must(efforts[0], "models.json lists no effort") };
}

/**
 * Reads the settings of every question from the presets file (the `standard` table). A question that the file does
 * not hold yet starts at the cheapest candidate, so that its first measurement can run.
 *
 * @returns the model and effort of each question
 * @sideEffects reads config/presets.json; throws when the file is missing
 */
export function presetQuestions(): Record<QuestionId, QuestionSettings> {
  const file = loadPresets();
  const standard = { ...file.presets[Quality.Standard] };
  for (const q of QUESTION_IDS) standard[q] ??= startConfig(q);
  return parseConfig({}, { presets: { ...file, presets: { ...file.presets, [Quality.Standard]: standard } } })
    .questions;
}

/**
 * Lists the configurations of the O6 matrix for a question: its preset and the candidates above it (models.json: `candidate`).
 *
 * @param q - the question
 * @param base - the settings of every question; default: the presets file
 * @returns the preset first, then each candidate at each of its efforts, without doubles
 * @sideEffects reads the presets file when `base` is absent
 */
export function matrix(
  q: QuestionId,
  base: Record<QuestionId, QuestionSettings> = presetQuestions(),
): QuestionSettings[] {
  const def = base[q];
  const efforts: Effort[] =
    kindOf(q) === QuestionKind.Classification ? MODELS.efforts.classification : MODELS.efforts.other;
  const out: QuestionSettings[] = [def];
  for (const m of MODELS.models.filter((x) => x.candidate)) {
    if (!takesEffort(m.id)) out.push({ model: m.id, effort: def.effort });
    else for (const effort of m.efforts ?? efforts) out.push({ model: m.id, effort });
  }
  return dedupe(out);
}

/** The models and efforts that the command line names. */
export interface ConfigSelection {
  models: string[];
  efforts: Effort[];
}

/**
 * Picks the configurations to run for a question. `--model` and `--effort` may repeat and the lists multiply;
 * a missing list takes the default of the question.
 *
 * @param q - the question
 * @param a - the models and efforts from the command line
 * @param base - the settings of every question; default: the presets file
 * @returns the matrix when both lists are empty, else the product of the lists
 * @sideEffects reads the presets file when `base` is absent
 */
export function selectedConfigs(
  q: QuestionId,
  a: ConfigSelection,
  base: Record<QuestionId, QuestionSettings> = presetQuestions(),
): QuestionSettings[] {
  if (a.models.length === 0 && a.efforts.length === 0) return matrix(q, base);
  const def = base[q];
  const models = a.models.length ? a.models : [def.model];
  const efforts = a.efforts.length ? a.efforts : [def.effort];
  return dedupe(models.flatMap((model) => efforts.map((effort) => ({ model, effort }))));
}
