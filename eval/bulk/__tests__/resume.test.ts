import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readResultFile } from "../resume.js";

describe("readResultFile", () => {
  it("reads a round and a stored group of a file from before the batch size as batch 1", () => {
    const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const round = {
      round: 1,
      requests: 5,
      cut: 0.5,
      sharedCandidate: false,
      groups: 2,
      largestGroup: 3,
      labelPairs: 0,
      splitPairs: 0,
      reconciled: { pairs: 0, merged: 0 },
    };
    const file = {
      startedAt: "t",
      complete: true,
      source: "s",
      requests: 5,
      queuedInSource: 5,
      startSeq: 1,
      batchSize: 10,
      concurrency: 1,
      stub: true,
      batch: {
        path: "batch",
        complete: true,
        startedAtMs: 0,
        wallMs: 0,
        snapshotMs: 0,
        usage: { calls: 0, tokens: zero, usd: 0, unpricedCalls: 0, callsByQuestion: {} },
        outcomes: {},
        steps: 0,
        batches: [],
        attemptErrors: [],
        requests: [],
        rounds: [round],
        roundGroups: { round: 1, groups: [["a", "b"]] },
      },
    };
    const path = join(mkdtempSync(join(tmpdir(), "wikifact-resume-")), "result.json");
    writeFileSync(path, JSON.stringify(file));
    const read = readResultFile(path);
    expect(read.batch?.rounds?.[0]?.batch).toBe(1);
    expect(read.batch?.roundGroups?.batch).toBe(1);
  });
});
