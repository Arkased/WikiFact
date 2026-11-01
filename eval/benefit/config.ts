// The configuration of the benefit test: `eval/benefit/config.json`.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const configSchema = z.object({
  /** The model of both agents when `--model` is not given. */
  model: z.string().min(1),
});

/** The configuration of the benefit test. */
export type BenefitConfig = z.infer<typeof configSchema>;

/** The config file next to this module. */
const BENEFIT_CONFIG_PATH = join(dirname(fileURLToPath(import.meta.url)), "config.json");

/**
 * Reads the configuration of the benefit test.
 *
 * @param path - the config file; default `eval/benefit/config.json`
 * @returns the configuration
 * @throws {Error} that names the file when it is not JSON or does not match the schema
 * @sideEffects reads the file
 */
export function loadBenefitConfig(path: string = BENEFIT_CONFIG_PATH): BenefitConfig {
  try {
    return configSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch (e) {
    throw new Error(`The benefit config ${path} is invalid: ${e instanceof Error ? e.message : String(e)}`, {
      cause: e,
    });
  }
}
