import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../../src/config/index.js";
import { Mode, RequestKind } from "../../../src/domain/index.js";
import { setEmbedder } from "../../../src/embed/index.js";
import { closeStore, countFacts, openStoreFor, peekQueue } from "../../../src/store/index.js";
import { FAKE_EMBEDDING_MODEL, fakeEmbed } from "../../../fakes/fake-embedder.js";
import { SEED_FACTS } from "../../../fakes/bulk-seed-facts.js";
import { BULK_SUBMISSIONS, COMPOUND_ENDS } from "../../../fakes/bulk-submissions.js";
import { ExpectedOutcome, JustificationKind, SubmissionKind } from "../../lib/enums.js";
import { assertEmbedderMatches, buildBulkWiki, bulkWikiPath } from "../wiki.js";

const SUBMISSIONS = 100;
const FIRST_BATCH = 10;
const MIN_SEED_FACTS = 150;
const MIN_GROUPS = 5;
const MIN_CONFLICTS = 3;
const COMPOUND_FROM_THE_ISSUE = [
  "The console flags a read when the share of searches with 0 reads is over 0.5 (NO_READ_SHARE), the share with 3 or more reads is over 0.3 (MANY_READS_SHARE), or the share of sessions with no search is over 0.3 (NO_SEARCH_SHARE).",
  "WikiFact is written in TypeScript on Node.js 22 with better-sqlite3.",
];

/** The ends that each kind of submission may carry in its expected set (a same-subject group draws on 2 sets: its first and its others). */
const OUTCOMES_OF_KIND: Record<SubmissionKind, ExpectedOutcome[]> = {
  [SubmissionKind.New]: [ExpectedOutcome.AcceptedNew],
  [SubmissionKind.Duplicate]: [ExpectedOutcome.DuplicateOfSeed],
  [SubmissionKind.Correction]: [ExpectedOutcome.CorrectionAccepted],
  [SubmissionKind.Contradicted]: [ExpectedOutcome.RejectedContradicted],
  [SubmissionKind.Compound]: COMPOUND_ENDS,
  [SubmissionKind.Unsupported]: [ExpectedOutcome.RejectedUnsupported],
  [SubmissionKind.Hearsay]: [ExpectedOutcome.RejectedContradicted],
  [SubmissionKind.SameSubject]: [
    ExpectedOutcome.AcceptedNew,
    ExpectedOutcome.DuplicateOfEarlier,
    ExpectedOutcome.MergedWith,
    ExpectedOutcome.RejectedContradicted,
    ExpectedOutcome.LosesInReconciliation,
  ],
};

/** The kinds whose submission targets a seed fact. */
const KINDS_WITH_SEED = [
  SubmissionKind.Duplicate,
  SubmissionKind.Correction,
  SubmissionKind.Contradicted,
  SubmissionKind.Hearsay,
];

function tempDb(...parts: string[]): string {
  return join(mkdtempSync(join(tmpdir(), "wikifact-bulk-wiki-")), ...parts, "bulk.sqlite");
}

describe("the bulk test data", () => {
  it("holds 100 submissions, the 2 compound claims of the issue first, and no two equal", () => {
    expect(BULK_SUBMISSIONS).toHaveLength(SUBMISSIONS);
    expect(BULK_SUBMISSIONS.slice(0, COMPOUND_FROM_THE_ISSUE.length).map((s) => s.change)).toEqual(
      COMPOUND_FROM_THE_ISSUE,
    );
    const changes = BULK_SUBMISSIONS.map((s) => s.change);
    expect(new Set(changes).size).toBe(changes.length);
  });

  it("holds every kind among the first 10, so that a small run covers them", () => {
    const kinds = new Set(BULK_SUBMISSIONS.slice(0, FIRST_BATCH).map((s) => s.kind));
    for (const k of Object.values(SubmissionKind)) expect(kinds).toContain(k);
  });

  it("gives each submission a non-empty set of ends that its kind allows", () => {
    for (const s of BULK_SUBMISSIONS) {
      expect(s.expected.length).toBeGreaterThan(0);
      for (const end of s.expected) expect(OUTCOMES_OF_KIND[s.kind]).toContain(end);
    }
  });

  it("leaves a compound submission one end, split, and gives the TypeScript claim a note", () => {
    const compounds = BULK_SUBMISSIONS.filter((s) => s.kind === SubmissionKind.Compound);
    expect(compounds.length).toBeGreaterThan(0);
    for (const s of compounds) expect(s.expected).toEqual(COMPOUND_ENDS);
    const stack = BULK_SUBMISSIONS.find((s) => s.change === COMPOUND_FROM_THE_ISSUE[1]);
    expect(stack?.note).toBeDefined();
  });

  it("leaves a contradicted claim one correct end: rejected contradicted", () => {
    const contradicted = BULK_SUBMISSIONS.filter((s) => s.kind === SubmissionKind.Contradicted);
    expect(contradicted.length).toBeGreaterThan(0);
    for (const s of contradicted) expect(s.expected).toEqual([ExpectedOutcome.RejectedContradicted]);
  });

  it("labels each submission by the table of the labels: the justification first, then the claim", () => {
    for (const s of BULK_SUBMISSIONS) {
      switch (s.justificationKind) {
        case JustificationKind.Belief:
        case JustificationKind.Inference:
          // No observation and no report: step 1 rejects it whatever the claim.
          expect(s.expected).toEqual([ExpectedOutcome.RejectedUnsupported]);
          break;
        case JustificationKind.Hearsay:
          // A report goes on to Q4, which weighs it against the seed fact it contradicts.
          expect(s.expected).toEqual([ExpectedOutcome.RejectedContradicted]);
          break;
        case JustificationKind.Observation:
          expect(s.expected).not.toContain(ExpectedOutcome.RejectedUnsupported);
          break;
      }
    }
    const rejected = BULK_SUBMISSIONS.filter((s) => s.expected.includes(ExpectedOutcome.RejectedUnsupported));
    expect(rejected.length).toBeGreaterThan(0);
    expect(rejected).toEqual(BULK_SUBMISSIONS.filter((s) => s.kind === SubmissionKind.Unsupported));
    for (const s of rejected) {
      expect([JustificationKind.Belief, JustificationKind.Inference]).toContain(s.justificationKind);
    }
  });

  it("gives each hearsay claim a seed fact to contradict and the one end rejected contradicted", () => {
    const hearsay = BULK_SUBMISSIONS.filter((s) => s.justificationKind === JustificationKind.Hearsay);
    expect(hearsay.length).toBeGreaterThan(0);
    expect(hearsay).toEqual(BULK_SUBMISSIONS.filter((s) => s.kind === SubmissionKind.Hearsay));
    for (const s of hearsay) {
      expect(s.expected).toEqual([ExpectedOutcome.RejectedContradicted]);
      expect(s.seed).toBeDefined();
    }
  });

  it("gives a contradicted claim or a conflict loser a weak observation, with the ends of the table", () => {
    const losers = BULK_SUBMISSIONS.filter((s) => s.keeps !== undefined && s.mergesWith !== undefined);
    expect(losers.length).toBeGreaterThan(0);
    for (const s of losers)
      expect(s.expected).toEqual([ExpectedOutcome.RejectedContradicted, ExpectedOutcome.LosesInReconciliation]);
    const weak = [...losers, ...BULK_SUBMISSIONS.filter((s) => s.kind === SubmissionKind.Contradicted)];
    for (const s of weak) expect(s.justificationKind).toBe(JustificationKind.Observation);
  });

  it("gives each duplicate the end of its source: a seed fact, or an earlier submission", () => {
    for (const s of BULK_SUBMISSIONS.filter((x) => x.kind === SubmissionKind.Duplicate)) {
      expect(s.expected).toEqual([ExpectedOutcome.DuplicateOfSeed]);
    }
    for (const s of BULK_SUBMISSIONS.filter((x) => x.mergesWith !== undefined && x.keeps === undefined)) {
      expect(s.expected).toEqual([ExpectedOutcome.DuplicateOfEarlier, ExpectedOutcome.MergedWith]);
    }
    const ofEarlier = BULK_SUBMISSIONS.filter((s) => s.expected.includes(ExpectedOutcome.DuplicateOfEarlier));
    expect(ofEarlier.every((s) => s.mergesWith !== undefined)).toBe(true);
  });

  it("names a seed fact for each duplicate, correction and contradicted claim", () => {
    const headers = new Set(SEED_FACTS.map((f) => f.header));
    for (const s of BULK_SUBMISSIONS) {
      if (KINDS_WITH_SEED.includes(s.kind)) expect(headers).toContain(s.seed);
      else expect(s.seed).toBeUndefined();
    }
  });

  it("targets with the corrections exactly the seed facts that are out of date", () => {
    const targets = BULK_SUBMISSIONS.filter((s) => s.kind === SubmissionKind.Correction).map((s) => s.seed);
    const stale = SEED_FACTS.filter((f) => f.outOfDate).map((f) => f.header);
    expect([...targets].sort()).toEqual([...stale].sort());
  });

  it("merges each later member of a group with the first, which comes earlier in the queue", () => {
    const keys = BULK_SUBMISSIONS.map((s) => s.key);
    const groups = new Set<string>();
    BULK_SUBMISSIONS.forEach((s, i) => {
      if (s.mergesWith === undefined) return;
      const first = keys.indexOf(s.mergesWith);
      expect(first).toBeGreaterThanOrEqual(0);
      expect(first).toBeLessThan(i);
      groups.add(s.mergesWith);
    });
    expect(groups.size).toBeGreaterThanOrEqual(MIN_GROUPS);
  });

  it("has later members in the same-claim groups", () => {
    expect(BULK_SUBMISSIONS.filter((s) => s.mergesWith !== undefined && s.keeps === undefined).length).toBeGreaterThan(
      0,
    );
  });

  it("makes each conflicting pair decidable: the true member comes first and names the value that must win", () => {
    const conflicts = BULK_SUBMISSIONS.filter((s) => s.keeps !== undefined);
    const firsts = conflicts.filter((s) => s.mergesWith === undefined);
    expect(firsts.length).toBeGreaterThanOrEqual(MIN_CONFLICTS);
    for (const first of firsts) {
      expect(first.expected).toEqual([ExpectedOutcome.AcceptedNew]);
      expect(first.change).toContain(first.keeps);
      const losers = conflicts.filter((s) => s.mergesWith === first.key);
      expect(losers.length).toBeGreaterThan(0);
      for (const loser of losers) {
        expect(loser.keeps).toBe(first.keeps);
        expect(loser.expected).not.toContain(ExpectedOutcome.AcceptedNew);
        expect(loser.change).not.toContain(first.keeps ?? "");
      }
    }
  });

  it("gives no seed fact a header twice", () => {
    const headers = SEED_FACTS.map((f) => f.header.toLowerCase());
    expect(new Set(headers).size).toBe(headers.length);
    expect(SEED_FACTS.length).toBeGreaterThanOrEqual(MIN_SEED_FACTS);
  });
});

describe("bulkWikiPath", () => {
  it("gives a stub wiki and a real wiki 2 different folders and file names under .cache", () => {
    const stub = bulkWikiPath(true);
    const real = bulkWikiPath(false);
    expect(stub).not.toBe(real);
    expect(dirname(stub)).not.toBe(dirname(real));
    expect(stub.replace(/\\/g, "/")).toContain("/.cache/");
    expect(real.replace(/\\/g, "/")).toContain("/.cache/");
  });
});

describe("assertEmbedderMatches", () => {
  it("stops a real run on a stub wiki, and a stub run on a real wiki", () => {
    expect(() => assertEmbedderMatches(FAKE_EMBEDDING_MODEL, false)).toThrow(/fake embedder/);
    expect(() => assertEmbedderMatches("Xenova/bge-small-en-v1.5", true)).toThrow(/--stub/);
  });

  it("lets a stub run on a stub wiki and a real run on a real wiki go on", () => {
    expect(() => assertEmbedderMatches(FAKE_EMBEDDING_MODEL, true)).not.toThrow();
    expect(() => assertEmbedderMatches("Xenova/bge-small-en-v1.5", false)).not.toThrow();
  });
});

describe("buildBulkWiki", () => {
  beforeEach(() => setEmbedder(fakeEmbed));
  afterEach(() => setEmbedder(null));

  it("builds a wiki with the seed facts and the submissions queued in order, and records the fake embedder", async () => {
    const db = tempDb("wiki");
    const counts = await buildBulkWiki({ dbPath: db, stub: true });
    expect(counts).toEqual({ facts: SEED_FACTS.length, queued: SUBMISSIONS });
    const config = loadConfig(db);
    expect(config.embeddingModel).toBe(FAKE_EMBEDDING_MODEL);
    const store = openStoreFor(config, db);
    try {
      const queue = peekQueue(store, SUBMISSIONS + 1).filter((r) => r.kind === RequestKind.Submission);
      expect(queue.map((r) => r.change)).toEqual(BULK_SUBMISSIONS.map((s) => s.change));
    } finally {
      closeStore(store);
    }
  });

  it("writes its own config over one left in the folder, so the embedder of the config is always the one that was built", async () => {
    const db = tempDb();
    mkdirSync(dirname(db), { recursive: true });
    writeFileSync(
      join(dirname(db), "wikifact.json"),
      JSON.stringify({ mode: Mode.Local, subject: "x", embeddingModel: "Xenova/bge-small-en-v1.5" }),
    );
    await buildBulkWiki({ dbPath: db, stub: true });
    expect(loadConfig(db).embeddingModel).toBe(FAKE_EMBEDDING_MODEL);
    const store = openStoreFor(loadConfig(db), db);
    closeStore(store);
  });

  it("replaces an earlier build at the same path and leaves no temp file", async () => {
    const db = tempDb();
    await buildBulkWiki({ dbPath: db, stub: true });
    const again = await buildBulkWiki({ dbPath: db, stub: true });
    expect(again.queued).toBe(SUBMISSIONS);
    expect(readdirSync(dirname(db)).filter((f) => f.includes(".tmp"))).toEqual([]);
    expect(existsSync(db)).toBe(true);
  });

  it("builds 2 at once into the same path without corrupting the file", async () => {
    const db = tempDb();
    await Promise.all([buildBulkWiki({ dbPath: db, stub: true }), buildBulkWiki({ dbPath: db, stub: true })]);
    const store = openStoreFor(loadConfig(db), db);
    try {
      expect(countFacts(store)).toBe(SEED_FACTS.length);
      expect(peekQueue(store, SUBMISSIONS + 1).filter((r) => r.kind === RequestKind.Submission)).toHaveLength(
        SUBMISSIONS,
      );
    } finally {
      closeStore(store);
    }
    expect(readdirSync(dirname(db)).filter((f) => f.includes(".tmp"))).toEqual([]);
  });
});
