// The public surface of the config folder (technical/deployment.md, "Install and run").
export {
  DEFAULT_QUESTION_TIMEOUT_S,
  LOCAL_CONDITION,
  QUESTION_IDS,
  type Config,
  type HighVolumeConfig,
  type QuestionSettings,
} from "./schema.js";
export { loadPresets, presetsPath, type Presets } from "./presets.js";
export { costUsd, loadPrices, priceFor, type PriceTable } from "./prices.js";
export { parseConfig, configPath, loadConfig } from "./load.js";
