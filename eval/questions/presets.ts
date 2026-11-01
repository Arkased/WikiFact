// The quality presets of technical/questions.md, "Quality presets", built from the pooled runs of each configuration.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { QUESTION_IDS, type Presets } from "../../src/config/index.js";
import { REMOVED_QUESTION_IDS } from "../../src/constants.js";
import { Quality, QuestionId, QuestionKind } from "../../src/domain/index.js";
import { must } from "../lib/questions-guard.js";
import { MODELS, byCost, kindOf, type PassBar } from "./models.js";
import { passes, type Entry } from "./results.js";

/** The tolerance of a comparison between two means. */
const EPSILON = 1e-9;

/** The presets file that `summarize` writes: config/presets.json in the project root. */
export const DEFAULT_PRESETS_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "config", "presets.json");

type ShippedPick = NonNullable<NonNullable<Presets["presets"][Quality]>[QuestionId]>;

/** The pick for one question: its model and effort, and the mean and cost that led to it. */
interface PresetPick extends ShippedPick {
  mean: number;
  costUsd: number;
  /** Set when no configuration passes the bar and the pick is the best mean. */
  flagged?: true;
  /** Set when the question has 1 pooled configuration only: the pick is the one measured configuration, not a choice among several. */
  singleConfiguration?: true;
}

type PresetTable = Partial<Record<QuestionId, PresetPick>>;

/** The measured proposal: the 3 tables with the mean and cost of each pick, the rules, and where the data came from. It goes to the summary file. */
export interface PresetsProposal {
  generatedAt: string;
  sourceFiles: string[];
  /** The pick rule of each preset: the pass bar for budget, a sentence for the others. */
  bars: Record<Quality, string | PassBar>;
  presets: Record<Quality, PresetTable>;
}

/** What `buildPresets` takes besides the pooled configurations. */
export interface BuildPresetsOptions {
  /** The budget bar; default: models.json. */
  passBar?: PassBar;
  /** The kind of each question, which picks the rule of the standard preset; default: the `kind` of the specs. */
  kindOf?: (q: QuestionId) => QuestionKind;
}

const pick = (e: Entry, flagged = false, single = false): PresetPick => ({
  model: e.model,
  effort: e.effort,
  mean: e.mean,
  costUsd: e.costEstimateUsd,
  ...(flagged ? { flagged: true } : {}),
  ...(single ? { singleConfiguration: true } : {}),
});

// The best mean, and the cheapest among ties.
function bestOf(es: Entry[]): Entry {
  const top = Math.max(...es.map((e) => e.mean));
  return must(es.filter((e) => e.mean >= top - EPSILON).sort(byCost)[0], "no configuration to pick from");
}

/**
 * Builds the 3 tables of technical/questions.md, "Quality presets" from the pooled runs of each configuration. Budget: the cheapest configuration
 * that passes the bar, else the best mean, flagged. A pick of a question with 1 pooled configuration carries `singleConfiguration`. Premium: the best mean, cheapest among ties. Standard: the budget
 * pick for a drafting question, the premium pick for the others.
 *
 * @param configurations - the pooled configurations
 * @param sourceFiles - the result files that they came from, for the record
 * @param opts - the bar and the kinds, when they are not the defaults
 * @returns the measured proposal: a pick per question for budget, standard and premium, with mean and cost
 * @sideEffects reads the clock for `generatedAt`
 */
export function buildPresets(
  configurations: Entry[],
  sourceFiles: string[],
  opts: BuildPresetsOptions = {},
): PresetsProposal {
  const passBar = opts.passBar ?? MODELS.passBar;
  const kind = opts.kindOf ?? kindOf;
  const budget: PresetTable = {};
  const standard: PresetTable = {};
  const premium: PresetTable = {};
  for (const q of QUESTION_IDS) {
    const es = configurations.filter((e) => e.question === q);
    if (es.length === 0) continue;
    const ok = es.filter((e) => passes(e, passBar)).sort(byCost)[0];
    // No configuration passes: the best mean, flagged.
    const single = es.length === 1;
    const budgetPick = ok ? pick(ok, false, single) : pick(bestOf(es), true, single);
    const premiumPick = pick(bestOf(es), false, single);
    budget[q] = budgetPick;
    premium[q] = premiumPick;
    standard[q] = kind(q) === QuestionKind.Drafting ? budgetPick : premiumPick;
  }
  const listOf = (k: QuestionKind): string => QUESTION_IDS.filter((q) => kind(q) === k).join(", ");
  return {
    generatedAt: new Date().toISOString(),
    sourceFiles,
    bars: {
      budget: passBar,
      standard: `classification (${listOf(QuestionKind.Classification)}) and judgment (${listOf(QuestionKind.Judgment)}): best mean, cheapest among ties; drafting (${listOf(QuestionKind.Drafting)}): the cheapest configuration that passes the budget bar, the best mean flagged when none passes`,
      premium: "best mean, cheapest among ties, on every question",
    },
    presets: { [Quality.Budget]: budget, [Quality.Standard]: standard, [Quality.Premium]: premium },
  };
}

/**
 * Cuts a measured proposal down to the shipped presets file: the model and effort of each pick, and the name of the
 * summary file that holds the measurement.
 *
 * @param proposal - the measured proposal
 * @param source - the file name of the summary file that holds the measurement
 * @returns the content of `config/presets.json`
 * @sideEffects none
 */
export function toPresetsFile(proposal: PresetsProposal, source: string): Presets {
  const cut = (table: PresetTable): NonNullable<Presets["presets"][Quality]> =>
    Object.fromEntries(
      Object.entries(table)
        .filter(([q]) => !REMOVED_QUESTION_IDS.has(q))
        .map(([q, p]) => [q, { model: p.model, effort: p.effort }]),
    );
  return {
    source,
    presets: {
      [Quality.Budget]: cut(proposal.presets[Quality.Budget]),
      [Quality.Standard]: cut(proposal.presets[Quality.Standard]),
      [Quality.Premium]: cut(proposal.presets[Quality.Premium]),
    },
  };
}
