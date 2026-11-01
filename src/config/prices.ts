// technical/console.md, "Store API reads for the signals": the price table `config/prices.json`, shared by the cost signal of the console
// and the cost of a configuration in the question runner.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { projectRoot } from "../paths.js";

const pricesSchema = z.object({
  _comment: z.string().optional(),
  cacheWriteFactor: z.number().min(0),
  cacheReadFactor: z.number().min(0),
  models: z.record(z.string(), z.object({ input: z.number().min(0), output: z.number().min(0) })),
});

/** The price table: the cache write and cache read factors and the prices of each model, in USD per million tokens. */
export type PriceTable = z.infer<typeof pricesSchema>;

/** The price of a model, in USD per million tokens. */
export interface ModelPrice {
  input: number;
  output: number;
  /** False for a model the table does not list; its prices are 0. */
  known: boolean;
}

/**
 * Names the price file: `config/prices.json` in the project root.
 *
 * @returns the path of the price file
 * @sideEffects reads the file system for the project root
 */
function pricesPath(): string {
  return join(projectRoot(), "config", "prices.json");
}

/**
 * Reads and validates the price table.
 *
 * @param path - the file to read; default `pricesPath()`
 * @returns the table
 * @throws {Error} that names the file when it is not JSON or does not match the schema
 * @sideEffects reads the file
 */
export function loadPrices(path: string = pricesPath()): PriceTable {
  try {
    return pricesSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch (e) {
    throw new Error(`The price file ${path} is invalid: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
}

/**
 * Looks up the price of a model.
 *
 * @param table - the price table
 * @param model - the API model id
 * @returns the prices; 0 and 0 with `known` false for a model the table does not list
 * @sideEffects none
 */
export function priceFor(table: PriceTable, model: string): ModelPrice {
  const entry = Object.hasOwn(table.models, model) ? table.models[model] : undefined;
  return entry === undefined ? { input: 0, output: 0, known: false } : { ...entry, known: true };
}

/** The token counts of model calls, by price class. */
export interface TokenCounts {
  /** Input tokens that are neither written to nor read from the cache. */
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

/** The prices of the table are USD per this many tokens. */
const TOKENS_PER_MILLION = 1e6;

/**
 * Prices the tokens of model calls: the one formula of every cost in the code base. `tokens_in * input +
 * tokens_cache_write * input * cacheWriteFactor + tokens_cache_read * input * cacheReadFactor + tokens_out * output`,
 * divided by 1,000,000.
 *
 * @param table - the price table
 * @param model - the API model id; a model the table does not list costs 0
 * @param tokens - the token counts
 * @returns the cost in USD
 * @sideEffects none
 */
export function costUsd(table: PriceTable, model: string, tokens: TokenCounts): number {
  const price = priceFor(table, model);
  return (
    (tokens.input * price.input +
      tokens.cacheWrite * price.input * table.cacheWriteFactor +
      tokens.cacheRead * price.input * table.cacheReadFactor +
      tokens.output * price.output) /
    TOKENS_PER_MILLION
  );
}
