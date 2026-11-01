import { describe, expect, it } from "vitest";
import { ChangeOutcome } from "../../src/domain/enums.js";
import { BULK_END_STATE, BULK_LABELS, type DuplicateTarget } from "../bulk-expected.js";
import { SEED_FACTS } from "../bulk-seed-facts.js";
import { BULK_SUBMISSIONS } from "../bulk-submissions.js";

const SEED_HEADERS = new Set(SEED_FACTS.map((f) => f.header));

/** The queue positions whose fact a duplicate may restate: an accepted submission. */
const WRITERS = new Set(BULK_LABELS.filter((l) => l.outcome === ChangeOutcome.Accepted).map((l) => l.position));

/**
 * Tells whether a duplicate target exists in the seed or among the accepted submissions.
 *
 * @param target - the target of a label
 * @returns true when the target names a seed header or an accepted position
 * @sideEffects none
 */
function exists(target: DuplicateTarget): boolean {
  return "seed" in target ? SEED_HEADERS.has(target.seed) : WRITERS.has(target.position);
}

describe("BULK_LABELS", () => {
  it("holds one label for each submission, in queue order, with a fact that states the change of its position", () => {
    expect(BULK_LABELS).toHaveLength(BULK_SUBMISSIONS.length);
    BULK_LABELS.forEach((label, i) => {
      expect(label.position).toBe(i);
      const change = BULK_SUBMISSIONS[i]?.change.toLowerCase() ?? "";
      for (const anchor of label.fact?.anchors ?? []) expect(change).toContain(anchor.toLowerCase());
      for (const old of label.fact?.avoid ?? []) expect(change).not.toContain(old.toLowerCase());
    });
  });

  it("names a real target for every duplicate and every correction", () => {
    for (const label of BULK_LABELS) {
      if (label.duplicateOf) {
        expect(exists(label.duplicateOf)).toBe(true);
        // The queue runs in order: a duplicate restates a fact that an earlier submission wrote.
        if ("position" in label.duplicateOf) expect(label.duplicateOf.position).toBeLessThan(label.position);
      }
      // The children of a split run after the whole queue, so a claim may restate any accepted submission.
      for (const claim of label.claims ?? []) if (claim.duplicateOf) expect(exists(claim.duplicateOf)).toBe(true);
      if (label.replaces !== undefined) {
        const seed = SEED_FACTS.find((f) => f.header === label.replaces);
        expect(seed?.outOfDate).toBe(true);
      }
    }
  });

  it("gives every accepted label a fact and every split at least 2 claims", () => {
    for (const label of BULK_LABELS) {
      if (label.outcome === ChangeOutcome.Accepted) expect(label.fact?.anchors.length).toBeGreaterThan(0);
      if (label.outcome === ChangeOutcome.Split) expect(label.claims?.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("adds up to the end state", () => {
    const accepted = BULK_LABELS.filter((l) => l.outcome === ChangeOutcome.Accepted);
    const corrections = accepted.filter((l) => l.replaces !== undefined);
    const claims = BULK_LABELS.flatMap((l) => l.claims ?? []);
    const acceptedClaims = claims.filter((c) => c.outcome === ChangeOutcome.Accepted);
    expect(accepted.length - corrections.length + acceptedClaims.length).toBe(BULK_END_STATE.newFacts);
    expect(corrections).toHaveLength(BULK_END_STATE.correctedSeedFacts);
  });
});
