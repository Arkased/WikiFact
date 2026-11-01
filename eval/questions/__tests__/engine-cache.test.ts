import { describe, expect, it } from "vitest";
import { Effort, QuestionId } from "../../../src/domain/enums.js";
import type { Transport } from "../../../src/updates/index.js";
import { runConfig } from "../engine.js";

const CACHE_READ = 7;
const CACHE_WRITE = 11;
const CASES = 3;

// A transport whose every call reports the same cache use. Its answer is not valid, so a call may retry; the test
// counts calls through the totals.
const transport: Transport = {
  send: () =>
    Promise.resolve({
      stopReason: "end_turn",
      text: "{}",
      usage: { input: 100, output: 5, cacheRead: CACHE_READ, cacheWrite: CACHE_WRITE },
    }),
};

describe("the result of a configuration", () => {
  it("records the cache tokens of all calls, and counts them inside the input tokens", async () => {
    const r = await runConfig({
      q: QuestionId.Q2,
      settings: { model: "claude-sonnet-5-5", effort: Effort.Low },
      runs: 1,
      limit: CASES,
      transport,
    });
    expect(r.cache.read).toBeGreaterThanOrEqual(CASES * CACHE_READ);
    expect(r.cache.read / CACHE_READ).toBe(r.cache.write / CACHE_WRITE);
    expect(r.tokens.input).toBeGreaterThanOrEqual(r.cache.read + r.cache.write);
  });
});
