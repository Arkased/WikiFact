// The result file of a stopped run, read back for `--resume`.
import { readFileSync } from "node:fs";
import { z } from "zod";
import { ChangeOutcome, RejectReason, RequestStatus } from "../../src/domain/index.js";
import { BulkArch, BulkPath, BulkStop } from "../lib/enums.js";
import type { BulkResultFile, RequestRecord } from "./types.js";

const tokenCounts = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
});

const factText = z.object({ header: z.string(), content: z.string() });

const requestRecord: z.ZodType<RequestRecord> = z.lazy(() =>
  z.object({
    requestId: z.string(),
    status: z.enum(RequestStatus),
    outcome: z.enum(ChangeOutcome).optional(),
    error: z.string().optional(),
    rejectReason: z.enum(RejectReason).optional(),
    duplicateOf: z.string().optional(),
    attempts: z.number(),
    factIds: z.array(z.string()),
    facts: z.array(factText),
    children: z.array(requestRecord),
  }),
);

const factWithId = factText.extend({ factId: z.string() });

const duplicateReport = z.object({
  complete: z.boolean(),
  checkedFacts: z.number(),
  candidatePairs: z.number(),
  pairs: z.array(z.object({ a: factWithId, b: factWithId, distance: z.number() })),
  judge: z.object({ calls: z.number(), tokens: tokenCounts }),
  error: z.string().optional(),
});

const pathScore = z.object({
  right: z.number(),
  wrong: z.number(),
  unclear: z.object({ right: z.number(), wrong: z.number() }),
  ends: z.array(
    z.object({
      position: z.number(),
      claim: z.number().optional(),
      end: z.string(),
      accepted: z.array(z.string()),
      right: z.boolean(),
      unclear: z.boolean(),
      correction: z.boolean().optional(),
    }),
  ),
  endState: z.array(
    z.object({
      name: z.string(),
      expected: z.string(),
      actual: z.string(),
      ok: z.boolean(),
      positions: z.array(z.number()),
    }),
  ),
  line: z.string(),
});

const groupRound = z.object({
  /** A file from before the batch size has no batch on its rounds; such a round is batch 1 (technical/updates.md, "The batch size of B and C"). */
  batch: z.number().default(1),
  round: z.number(),
  requests: z.number(),
  cut: z.number(),
  sharedCandidate: z.boolean(),
  groups: z.number(),
  largestGroup: z.number(),
  labelPairs: z.number(),
  splitPairs: z.number(),
  reconciled: z.object({ pairs: z.number(), merged: z.number() }),
  judged: z
    .object({
      groupCalls: z.number(),
      retries: z.number(),
      ranAsB: z.number(),
      endedAtQ7: z.number(),
      leftAlone: z.number(),
    })
    .optional(),
});

const storedGroups = z.object({
  /** A stored group from before the batch size has no batch; it is batch 1 (technical/updates.md, "The batch size of B and C"). */
  batch: z.number().default(1),
  round: z.number(),
  groups: z.array(z.array(z.string())),
});

const pathResult = z.object({
  path: z.enum(BulkPath),
  complete: z.boolean(),
  startedAtMs: z.number(),
  wallMs: z.number(),
  snapshotMs: z.number(),
  usage: z.object({
    calls: z.number(),
    tokens: tokenCounts,
    usd: z.number(),
    unpricedCalls: z.number(),
    callsByQuestion: z.record(z.string(), z.number()),
  }),
  outcomes: z.record(z.string(), z.number()),
  steps: z.number(),
  batches: z.array(z.object({ status: z.string(), size: z.number().optional() })),
  attemptErrors: z.array(z.string()),
  requests: z.array(requestRecord),
  unfinished: z.number().optional(),
  duplicates: duplicateReport.optional(),
  score: pathScore.optional(),
  rounds: z.array(groupRound).optional(),
  roundGroups: storedGroups.optional(),
  queuedAfter: z.number().optional(),
});

const factDifferences = z.object({
  outcomes: z.array(z.object({ requestId: z.string(), change: z.string(), sequential: z.string(), batch: z.string() })),
  onlySequential: z.array(factText),
  onlyBatch: z.array(factText),
  sameHeader: z.number(),
  sameContent: z.number(),
});

/** The shape of the result file; a file of an older run without `startSeq` fails it. */
const resultFile: z.ZodType<BulkResultFile> = z.object({
  startedAt: z.string(),
  complete: z.boolean(),
  stoppedBy: z.enum(BulkStop).optional(),
  source: z.string(),
  env: z.string().optional(),
  wiki: z.string().optional(),
  requests: z.number(),
  queuedInSource: z.number(),
  startSeq: z.number(),
  batchSize: z.number(),
  concurrency: z.number(),
  groupCut: z.number().optional(),
  stub: z.boolean(),
  secondOnly: z.boolean().optional(),
  arch: z.enum(BulkArch).optional(),
  grouping: z.object({ cut: z.number(), sharedCandidate: z.boolean() }).optional(),
  sequential: pathResult.optional(),
  batch: pathResult.optional(),
  differences: factDifferences.optional(),
});

/**
 * Reads the result file of a stopped run.
 *
 * @param path - the result file
 * @returns the file as the run wrote it
 * @throws {Error} the read error of `readFileSync` (code `ENOENT`) when the file is missing, and a plain `Error` when the
 *   file holds no path to continue
 * @throws {SyntaxError} when the file is not valid JSON
 * @throws {z.ZodError} when the JSON has the wrong shape (a file of an older run has no `startSeq`)
 * @sideEffects reads the file
 */
export function readResultFile(path: string): BulkResultFile {
  const data = resultFile.parse(JSON.parse(readFileSync(path, "utf8")));
  if (!data.sequential && !data.batch) throw new Error(`${path} holds no path to resume`);
  return data;
}
