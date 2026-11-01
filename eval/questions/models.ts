// The models the question runner knows (models.json) and what it derives from them: prices, the cost order, the kind of each question.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { loadPrices, priceFor, type PriceTable } from "../../src/config/index.js";
import { Effort, QuestionId, QuestionKind, enumValues, isMember } from "../../src/domain/index.js";
import { SPECS, modelFeatures } from "../../src/updates/index.js";

/** A model of models.json. */
interface ModelInfo {
  id: string;
  /** True puts the model in the default matrix. */
  candidate?: boolean;
  /** Replaces the efforts of the kind of question. */
  efforts?: Effort[];
}

/** The pass bar of technical/questions.md, "Test plan". The questions in `strict` pass at `strictMean` and `strictMinRun`, every other at `mean` and `minRun`. */
export interface PassBar {
  strict: string[];
  strictMean: number;
  strictMinRun: number;
  mean: number;
  minRun: number;
}

/** The lower bar of the staging: the questions in `strict` count at 100 percent, the others at `mean` with no run under `minRun`. */
interface EconomyBar {
  strict: string[];
  mean: number;
  minRun: number;
}

/** The content of models.json. */
export interface ModelsFile {
  models: ModelInfo[];
  passBar: PassBar;
  economyBar: EconomyBar;
  /** The model calls in flight at the start of a run. */
  concurrency?: { start: number };
  /** The slack of the staging bar, in accuracy (0..1). */
  staging?: { slack: number };
  /** The efforts the matrix tries: for classification questions, and for the others. */
  efforts: { classification: Effort[]; other: Effort[] };
}

/** A model and an effort: the two fields that decide the cost of a configuration. */
export interface ModelEffort {
  model: string;
  effort: string;
}

/** The output price of a model that config/prices.json does not list, in USD per million tokens: it ranks last. */
const UNKNOWN_MODEL_PRICE = 99;
/** The weight of the output price in the cost rank. The effort index is below it, so that price decides and effort breaks ties. */
const PRICE_RANK_WEIGHT = 10;

const MODELS_PATH = join(dirname(fileURLToPath(import.meta.url)), "models.json");

// The pass bar is written to the result files and to the presets file as it is in models.json (with its `_comment`
// first), so it stays loose and the schema lists the comment first.
const modelsSchema = z.object({
  models: z.array(
    z.object({
      id: z.string(),
      candidate: z.boolean().optional(),
      efforts: z.array(z.enum(Effort)).optional(),
    }),
  ),
  passBar: z.looseObject({
    _comment: z.string().optional(),
    strict: z.array(z.string()),
    strictMean: z.number(),
    strictMinRun: z.number(),
    mean: z.number(),
    minRun: z.number(),
  }),
  economyBar: z.object({ strict: z.array(z.string()), mean: z.number(), minRun: z.number() }),
  concurrency: z.object({ start: z.number() }).optional(),
  staging: z.object({ slack: z.number() }).optional(),
  efforts: z.object({ classification: z.array(z.enum(Effort)), other: z.array(z.enum(Effort)) }),
});

/**
 * Reads and validates models.json.
 *
 * @param path - the file to read; default: models.json next to this module
 * @returns the models, the pass bar and the settings of the run
 * @sideEffects reads the file; throws a ZodError when it does not match the schema
 */
export function loadModels(path: string = MODELS_PATH): ModelsFile {
  const m: ModelsFile = modelsSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  return m;
}

/** The price table of the service (config/prices.json), read once when the module loads. */
export const PRICES: PriceTable = loadPrices();

/** The models of models.json, read once when the module loads. */
export const MODELS: ModelsFile = loadModels();

/**
 * Tells whether a model takes an effort, from the model table of src. An unknown model is assumed to take it (what the transport does too).
 *
 * @param id - the API model id
 * @returns true when the effort is sent to the model
 * @sideEffects none
 */
export function takesEffort(id: string): boolean {
  return modelFeatures(id).thinking;
}

/**
 * Ranks a configuration by cost: cheaper is lower. An unknown model ranks last.
 *
 * @param model - the API model id
 * @param effort - the effort of the configuration
 * @returns the output price weighted, plus the position of the effort
 * @sideEffects none
 */
function rank(model: string, effort: string): number {
  const effortIndex = isMember(Effort, effort) ? enumValues(Effort).indexOf(effort) : -1;
  const price = priceFor(PRICES, model);
  return (price.known ? price.output : UNKNOWN_MODEL_PRICE) * PRICE_RANK_WEIGHT + Math.max(0, effortIndex);
}

/**
 * Compares two configurations by cost, for `sort`.
 *
 * @param a - the first configuration
 * @param b - the second configuration
 * @returns a negative number when `a` is cheaper, a positive one when `b` is, else 0
 * @sideEffects none
 */
export function byCost(a: ModelEffort, b: ModelEffort): number {
  return rank(a.model, a.effort) - rank(b.model, b.effort);
}

/**
 * Gives the kind of a question, which comes from its spec in src.
 *
 * @param q - the question
 * @returns classification, judgment or drafting
 * @sideEffects none
 */
export function kindOf(q: QuestionId): QuestionKind {
  return SPECS[q].kind;
}
