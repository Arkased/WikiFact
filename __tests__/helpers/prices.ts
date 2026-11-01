// A fake price table for the tests of the cost signal: no test repeats a price of `config/prices.json`.
import type { PriceTable } from "../../src/config/index.js";

/** The model that `FAKE_PRICES` lists; a call of any other model is unpriced. */
export const PRICED_MODEL = "m";

/** 1 cent per input token, 2 cents per output token, a cache write at twice and a cache read at half the input price. */
export const FAKE_PRICES: PriceTable = {
  cacheWriteFactor: 2,
  cacheReadFactor: 0.5,
  models: { [PRICED_MODEL]: { input: 10_000, output: 20_000 } },
};
