import { describe, expect, it } from "vitest";
import { HealthLevel, InterpretationId, InterpretationStatus, Signal, enumValues } from "../../domain/enums.js";
import { INTERPRETATIONS, noResultLevel, searchMissLevel, type InterpretationData } from "../interpretations.js";
import { SEARCH_MISS_SHARE, SIGNAL_DEFINITIONS, STAGE_MATURE_MAX, STAGE_NEW_MIN } from "../signals.js";

describe("the definitions of the signals", () => {
  it("has a definition for every signal, so that a new signal has one", () => {
    for (const signal of enumValues(Signal)) expect(SIGNAL_DEFINITIONS[signal], signal).toBeTruthy();
  });
});

describe("the list of interpretations", () => {
  it("holds each id once", () => {
    const ids = INTERPRETATIONS.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives an entry with the status tested the test that backs it", () => {
    for (const entry of INTERPRETATIONS) {
      if (entry.status === InterpretationStatus.Tested) expect(entry.test, entry.id).not.toBeNull();
    }
  });

  it("reads a signal that has a definition", () => {
    for (const entry of INTERPRETATIONS) expect(SIGNAL_DEFINITIONS[entry.of], entry.id).toBeTruthy();
  });

  it("leads every reading with a verdict word, and holds no number", () => {
    const readings = [
      stageAt(STAGE_NEW_MIN + 0.1, 0),
      stageAt(STAGE_NEW_MIN, 0),
      stageAt(0, 0),
      missesOf(100),
      missesOf(0),
    ];
    for (const data of readings)
      for (const entry of INTERPRETATIONS) {
        const text = entry.read(data);
        if (text === null) continue;
        expect(text, entry.id).toMatch(/^(Growing fast|Growing|Mature|Good|Poor|Weak)\. /);
        expect(text, entry.id).not.toMatch(/\d/);
      }
  });
});

const read = (id: InterpretationId, data: InterpretationData): string | null =>
  INTERPRETATIONS.find((i) => i.id === id)?.read(data) ?? null;

// A stage with 1000 searches, `a` additions and `c` corrections per search.
const stageAt = (a: number, c: number): InterpretationData => ({
  stage: { searches: 1000, additions: Math.round(a * 1000), corrections: Math.round(c * 1000) },
});

describe("the reading of the stage", () => {
  it("is new over STAGE_NEW_MIN, whatever the corrections", () => {
    expect(read(InterpretationId.Stage, stageAt(STAGE_NEW_MIN + 0.1, 0.3))).toBe(
      "Growing fast. Agents add far more than they find: quality should rise as the gaps fill.",
    );
  });

  it("is growing at STAGE_NEW_MIN, and at STAGE_MATURE_MAX, and under it when the corrections are fewer than the additions", () => {
    const growing = "Growing. Agents add and correct in step: quality should rise slowly.";
    expect(read(InterpretationId.Stage, stageAt(STAGE_NEW_MIN, 0))).toBe(growing);
    expect(read(InterpretationId.Stage, stageAt(STAGE_MATURE_MAX, STAGE_MATURE_MAX))).toBe(growing);
    expect(read(InterpretationId.Stage, stageAt(STAGE_MATURE_MAX - 0.1, 0))).toBe(growing);
  });

  it("is mature under STAGE_MATURE_MAX when the corrections are at or over the additions", () => {
    const mature = "Mature. Agents correct more than they add: quality holds, and the wiki has what they search for.";
    expect(read(InterpretationId.Stage, stageAt(STAGE_MATURE_MAX - 0.1, STAGE_MATURE_MAX - 0.1))).toBe(mature);
    expect(read(InterpretationId.Stage, stageAt(STAGE_MATURE_MAX - 0.1, 0.3))).toBe(mature);
  });

  it("says nothing without a search", () => {
    expect(read(InterpretationId.Stage, { stage: { searches: 0, additions: 0, corrections: 0 } })).toBeNull();
    expect(read(InterpretationId.Stage, {})).toBeNull();
  });
});

const SHARE_OF_100 = 100;

// 100 change requests after a search, `missed` of them for a fact the search did not list.
const missesOf = (missed: number): InterpretationData => ({
  misses: { afterSearch: 100, missed },
});

describe("the reading of the poor searches", () => {
  it("is poor over SEARCH_MISS_SHARE, and good at it", () => {
    const over = Math.round(SEARCH_MISS_SHARE * SHARE_OF_100) + 1;
    expect(read(InterpretationId.PoorSearches, missesOf(over))).toBe(
      "Poor. The search misses facts the wiki has, and agents find them another way.",
    );
    expect(read(InterpretationId.PoorSearches, missesOf(over - 1))).toBe(
      "Good. The search finds the facts the wiki has.",
    );
    expect(read(InterpretationId.PoorSearches, missesOf(0))).toBe("Good. The search finds the facts the wiki has.");
  });

  it("says nothing when no change request followed a search", () => {
    expect(read(InterpretationId.PoorSearches, { misses: { afterSearch: 0, missed: 0 } })).toBeNull();
    expect(read(InterpretationId.PoorSearches, {})).toBeNull();
  });
});

describe("the levels of the numbers with a reading rule", () => {
  const OF_100 = 100;
  const atShare = (share: number): number => Math.round(share * OF_100);

  it("Facts the search missed: ok at SEARCH_MISS_SHARE, failing over it", () => {
    expect(searchMissLevel(atShare(SEARCH_MISS_SHARE), OF_100)).toBe(HealthLevel.Green);
    expect(searchMissLevel(atShare(SEARCH_MISS_SHARE) + 1, OF_100)).toBe(HealthLevel.Red);
  });

  it("Searches with no result: ok at 0, warning over 0", () => {
    expect(noResultLevel(0)).toBe(HealthLevel.Green);
    expect(noResultLevel(1)).toBe(HealthLevel.Yellow);
  });
});
