import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FAKE_PRICES, PRICED_MODEL } from "../../../__tests__/helpers/prices.js";
import { costUsd, loadPrices, priceFor } from "../prices.js";

function fileWith(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "wikifact-prices-"));
  const path = join(dir, "prices.json");
  writeFileSync(path, content);
  return path;
}

describe("loadPrices", () => {
  it("reads a valid table", () => {
    expect(loadPrices(fileWith(JSON.stringify(FAKE_PRICES)))).toEqual(FAKE_PRICES);
  });

  it("reads the shipped file", () => {
    expect(Object.keys(loadPrices().models).length).toBeGreaterThan(0);
  });

  it("names the file when the content does not match the schema", () => {
    const path = fileWith(
      JSON.stringify({ cacheWriteFactor: 1, cacheReadFactor: 0.5, models: { m: { input: -1, output: 1 } } }),
    );
    expect(() => loadPrices(path)).toThrow(path);
  });

  it("reads both cache factors of the shipped file as positive numbers", () => {
    const { cacheWriteFactor, cacheReadFactor } = loadPrices();
    expect(cacheWriteFactor).toBeGreaterThan(0);
    expect(cacheReadFactor).toBeGreaterThan(0);
  });

  it("names the file when the cache write factor is missing", () => {
    const path = fileWith(JSON.stringify({ cacheReadFactor: 0.5, models: { m: { input: 1, output: 1 } } }));
    expect(() => loadPrices(path)).toThrow(path);
  });

  it("names the file when it is not JSON", () => {
    const path = fileWith("{");
    expect(() => loadPrices(path)).toThrow(path);
  });
});

describe("costUsd", () => {
  const table = { cacheWriteFactor: 1.25, cacheReadFactor: 0.1, models: { m: { input: 2, output: 10 } } };

  it("prices a cache write at 1.25 times the input price", () => {
    expect(costUsd(table, "m", { input: 0, cacheWrite: 1_000_000, cacheRead: 0, output: 0 })).toBeCloseTo(2.5, 10);
  });

  it("sums input, cache write, cache read and output", () => {
    const usd = costUsd(table, "m", { input: 1000, cacheWrite: 400, cacheRead: 3000, output: 200 });
    expect(usd).toBeCloseTo((1000 * 2 + 400 * 2 * 1.25 + 3000 * 2 * 0.1 + 200 * 10) / 1e6, 12);
  });

  it("costs 0 for an unlisted model", () => {
    expect(costUsd(table, "x", { input: 5, cacheWrite: 5, cacheRead: 5, output: 5 })).toBe(0);
  });
});

describe("priceFor", () => {
  it("gives the prices of a listed model", () => {
    expect(priceFor(FAKE_PRICES, PRICED_MODEL)).toEqual({ ...FAKE_PRICES.models[PRICED_MODEL], known: true });
  });

  it("gives 0 and 0, marked unknown, for an unlisted model, even one named like an object property", () => {
    expect(priceFor(FAKE_PRICES, "unlisted")).toEqual({ input: 0, output: 0, known: false });
    expect(priceFor(FAKE_PRICES, "toString")).toEqual({ input: 0, output: 0, known: false });
  });
});
