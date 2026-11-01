import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../../src/config/index.js";
import { RetrievalKind, SearchHitKind } from "../../../src/domain/index.js";
import { closeStore, openStoreFor, recordRetrieval, recordSearch, type Store } from "../../../src/store/index.js";
import { T0, accepted, draft, factIdOf, write } from "../../../__tests__/helpers/store.js";
import { ReadLabel, ReadsSample, ReadsTargetKind, SampleVerdict } from "../../lib/enums.js";
import type { Labeler } from "../labeler.js";
import { MIN_SAMPLE } from "../sample.js";
import { EXCLUDED, runReadsPerSearch, type ReadsPerSearchResult } from "../run.js";

// A store file with one fact and `counts[i]` reads on search i; the first search lies in a fill range when `fill` is set.
function makeCopy(counts: number[], fill: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "wikifact-reads-"));
  const db = join(dir, "game.sqlite");
  const store: Store = openStoreFor(loadConfig(db), db);
  write(store, accepted([draft()]), T0);
  const factId = factIdOf(store);
  const fillAt = (EXCLUDED[0]?.fromAt ?? 0) + 1;
  counts.forEach((n, i) => {
    const id = `s${i}`;
    recordSearch(store, {
      id,
      sessionId: null,
      query: `query ${i}`,
      at: fill && i === 0 ? fillAt : T0 + i,
      durationMs: 1,
      results: [{ kind: SearchHitKind.Fact, targetId: factId, rank: 1, ref: `${id}:${factId}` }],
    });
    for (let r = 0; r < n; r++) {
      recordRetrieval(store, factId, { now: T0 + 100 + i, kind: RetrievalKind.Read, ref: `${id}:${factId}` });
    }
  });
  closeStore(store);
  return db;
}

// A labeler that says what the count of reads of the search agrees with, and counts its calls.
function agreeingLabeler(): Labeler & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    label(search) {
      calls.push(search.id);
      const n = search.reads.length;
      const label = n === 0 ? ReadLabel.NotFound : n === 1 ? ReadLabel.Found : ReadLabel.Misled;
      return Promise.resolve({ label, reason: "stub", costUsd: 0.5 });
    },
  };
}

describe("runReadsPerSearch", () => {
  const out = (): string => join(mkdtempSync(join(tmpdir(), "wikifact-reads-out-")), "result.json");

  it("labels each search of the 3 samples once, leaves out the fill, and writes each search with its count, label and reason", async () => {
    const db = makeCopy([0, 0, 1, 1, 3, 2], true);
    const labeler = agreeingLabeler();
    const path = out();

    const { result } = await runReadsPerSearch({
      db,
      labeler,
      labelerModel: "stub",
      target: { kind: ReadsTargetKind.New, path },
      print: () => undefined,
    });

    expect(labeler.calls.sort()).toEqual(["s1", "s2", "s3", "s4"]);
    expect(result.meta).toMatchObject({ excluded: 1, costUsd: 2 });
    const none = result.samples.find((s) => s.sample === ReadsSample.None);
    expect(none?.searches).toEqual([
      { id: "s1", query: "query 1", reads: 0, label: ReadLabel.NotFound, reason: "stub", omitted: [] },
    ]);
    expect(result.samples.every((s) => s.agreement === 1 && s.verdict === SampleVerdict.NoVerdict)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(result);
  });

  it("keeps the labels and the cost when the labeler fails, and a resume labels only the searches without a label", async () => {
    const db = makeCopy([0, 0, 1, 1, 3], false);
    const path = out();
    const good = agreeingLabeler();
    const failing: Labeler = {
      label: (search) => (search.id === "s4" ? Promise.reject(new Error("boom")) : good.label(search)),
    };

    await expect(
      runReadsPerSearch({
        db,
        labeler: failing,
        labelerModel: "stub",
        target: { kind: ReadsTargetKind.New, path },
        print: () => undefined,
      }),
    ).rejects.toThrow("boom");
    await new Promise((resolve) => setImmediate(resolve));

    const partial = JSON.parse(readFileSync(path, "utf8")) as ReadsPerSearchResult;
    const labeledIds = partial.samples.flatMap((s) => s.searches.map((x) => x.id)).sort();
    expect(labeledIds).toEqual(["s0", "s1", "s2", "s3"]);
    expect(partial.meta.costUsd).toBe(2);

    const again = agreeingLabeler();
    const { result, path: written } = await runReadsPerSearch({
      db,
      labeler: again,
      labelerModel: "stub",
      target: { kind: ReadsTargetKind.Resume, path },
      print: () => undefined,
    });

    expect(again.calls).toEqual(["s4"]);
    expect(written).toBe(path);
    expect(result.meta.costUsd).toBe(2.5);
    expect(
      result.samples
        .flatMap((s) => s.searches)
        .map((x) => x.id)
        .sort(),
    ).toEqual(["s0", "s1", "s2", "s3", "s4"]);
  });

  it("marks a run stopped after some labels as partial and gives no verdict, though MIN_SAMPLE or more labels are in", async () => {
    const total = MIN_SAMPLE + 2;
    const db = makeCopy(
      Array.from({ length: total }, () => 0),
      false,
    );
    const path = out();
    const good = agreeingLabeler();
    let calls = 0;
    const failing: Labeler = {
      label: async (search) => {
        calls += 1;
        if (calls === total) {
          await new Promise((resolve) => setImmediate(resolve));
          throw new Error("boom");
        }
        return good.label(search);
      },
    };

    await expect(
      runReadsPerSearch({
        db,
        labeler: failing,
        labelerModel: "stub",
        sampleSize: total,
        target: { kind: ReadsTargetKind.New, path },
        print: () => undefined,
      }),
    ).rejects.toThrow("boom");
    await new Promise((resolve) => setImmediate(resolve));

    const partial = JSON.parse(readFileSync(path, "utf8")) as ReadsPerSearchResult;
    const none = partial.samples.find((s) => s.sample === ReadsSample.None);
    expect(partial.meta.partial).toBe(true);
    expect(none).toMatchObject({ size: total, labeled: total - 1, verdict: SampleVerdict.NoVerdict });

    const { result } = await runReadsPerSearch({
      db,
      labeler: agreeingLabeler(),
      labelerModel: "stub",
      sampleSize: total,
      target: { kind: ReadsTargetKind.Resume, path },
      print: () => undefined,
    });
    expect(result.meta.partial).toBe(false);
    expect(result.samples.find((s) => s.sample === ReadsSample.None)).toMatchObject({
      size: total,
      labeled: total,
      verdict: SampleVerdict.Passes,
    });
  });
});
