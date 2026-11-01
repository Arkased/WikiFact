// The shapes of the bulk test (technical/updates.md, "High volume mode", "The test of both paths").
import type { ChangeOutcome, RejectReason, RequestStatus } from "../../src/domain/index.js";
import type { BulkArch, BulkPath, BulkStop } from "../lib/enums.js";

/** The cut and the shared-candidate setting of B, as a result file of #60 stored them (read only). */
interface GroupOptions {
  cut: number;
  sharedCandidate: boolean;
}

/** The 4 token counts of a set of model calls. */
export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** What a path used, from the `model_calls` rows of its copy. */
export interface PathUsage {
  /** The model calls of the path. */
  calls: number;
  tokens: TokenCounts;
  /** USD by `config/prices.json`; a call of an unpriced model counts 0. */
  usd: number;
  unpricedCalls: number;
  /** The calls per question name (for example `Q7B`). */
  callsByQuestion: Record<string, number>;
}

/** A live fact as the result file keeps it. */
export interface FactText {
  header: string;
  content: string;
}

/** What one request ended as (a child of a split has the same shape). */
export interface RequestRecord {
  requestId: string;
  status: RequestStatus;
  /** The outcome of the last change of the request; absent when it has none (queued, running, failed). */
  outcome?: ChangeOutcome;
  error?: string;
  /** For a rejected outcome, the reason of the rejection. */
  rejectReason?: RejectReason;
  /** For a duplicate outcome, the id of the fact that the request duplicates. */
  duplicateOf?: string;
  attempts: number;
  /** The ids of the facts that the change wrote (new facts or new versions), live or not, claim fact first. */
  factIds: string[];
  /** The live facts that the change wrote, as they stand at the end of the path. */
  facts: FactText[];
  /** The children of a split, each with its own record. */
  children: RequestRecord[];
}

/** A pair of live facts that Q1 judged to share one scope. */
export interface DuplicatePair {
  a: FactText & { factId: string };
  b: FactText & { factId: string };
  /** Cosine distance of the two texts. */
  distance: number;
}

/** The duplicates among the live facts after a path. */
export interface DuplicateReport {
  /** False when the judging stopped (a rate limit): `pairs` holds what was judged. */
  complete: boolean;
  /** Live facts written in the run. */
  checkedFacts: number;
  /** Pairs that the nearest neighbors proposed, before Q1. */
  candidatePairs: number;
  /** The pairs that Q1 judged to share one scope. */
  pairs: DuplicatePair[];
  /** The tokens and calls of the judging; not part of the path. */
  judge: { calls: number; tokens: TokenCounts };
  error?: string;
}

/** What the judgment of the groups adds to a round of C (technical/updates.md, "The candidate architectures of the bulk test", C). */
interface GroupJudgeCounts {
  /** The group calls made (a retry is not counted here). */
  groupCalls: number;
  /** The group calls asked a second time after an invalid answer. */
  retries: number;
  /** The groups that ran 1 request at a time as B does, after a second invalid answer, a failed call or a failed write. */
  ranAsB: number;
  /** The requests that ended at Q7 (split or rejected) and so left their group. */
  endedAtQ7: number;
  /** The requests that left their group and ran alone: a scope with 2 or more live facts, a request that is no submission, or a failed step before the call. */
  leftAlone: number;
}

/** What one request (or one claim of a split) ended as, against its label. */
export interface EndScore {
  /** The place in the queue, from 0. */
  position: number;
  /** For a child of a split: the claim, counted from 1. */
  claim?: number;
  /** The end that the path gave; `none` when the request has no change. */
  end: string;
  /** The ends that the labels accept. */
  accepted: string[];
  right: boolean;
  /** True for a label that the research note marks as unclear: scored apart, never counted as wrong. */
  unclear: boolean;
  /** True when the end is an accepted request that wrote a version of a fact from before the run. Absent in an older file, and on an end whose verdict a new score kept (an old file, an accepted end whose label accepts neither a correction nor a new fact), so a later new score keeps the verdict again. */
  correction?: boolean;
}

/** One check of the end state of the copy against the labels. */
export interface EndStateCheck {
  name: string;
  /** What the labels give, as text (`41 to 46`, `0`). */
  expected: string;
  actual: string;
  ok: boolean;
  /** The queue positions of the requests that the check names; empty when it names none. */
  positions: number[];
}

/** The score of a path against the labels of `fakes/bulk-expected.ts`. */
export interface PathScore {
  /** The ends that are in the set of correct ends, unclear labels left out. */
  right: number;
  /** The ends that are not, unclear labels left out. */
  wrong: number;
  /** The ends of the unclear labels, scored apart. */
  unclear: { right: number; wrong: number };
  ends: EndScore[];
  endState: EndStateCheck[];
  /** The one line for the path. */
  line: string;
}

/** The counts of one grouping: what `--group-only` writes for each setting, and what each round of B writes. */
interface GroupCounts {
  /** The cosine distance cut of the grouping. */
  cut: number;
  /** True when requests that share a candidate fact joined 1 group. */
  sharedCandidate: boolean;
  /** The count of groups. */
  groups: number;
  /** The size of the largest group, in requests. */
  largestGroup: number;
  /** The pairs of requests that belong together by the labels (`labelPairs.ts`); 0 for a sample that has no labels. */
  labelPairs: number;
  /** The label pairs that 2 different groups hold. */
  splitPairs: number;
}

/** One round of B: the first round of a batch runs its requests, the second the children of its splits. */
interface GroupRound extends GroupCounts {
  /** The batch of the round, from 1, in queue order. */
  batch: number;
  /** 1 for the batch of the sample, 2 for the children of its splits. */
  round: number;
  /** The requests of the round. */
  requests: number;
  /** The reconciliation across the groups of the round: the pairs that Q1 looked at, and the merges. */
  reconciled: { pairs: number; merged: number };
  /** The counts of the group judgment; present only on a round of C (`--arch group-judge`). */
  judged?: GroupJudgeCounts;
}

/** The groups of the round that B started last, stored before any request of the round runs (the resume takes them). */
interface StoredGroups {
  /** The batch of the round. */
  batch: number;
  /** The round of the groups. */
  round: number;
  /** The groups, each a list of request ids in queue order. */
  groups: string[][];
}

/** The result of one path. */
export interface PathResult {
  path: BulkPath;
  /** True when the path ran to the end of its queue. */
  complete: boolean;
  /** The clock reading at the start of the path, in ms; the usage window opens there, and a resume keeps it. */
  startedAtMs: number;
  /** The time of the path alone, in ms: the sum of the time of its steps, without the snapshots. */
  wallMs: number;
  /** The time that the harness spent on the snapshots between the steps (reading the requests, the usage, the file), in ms. */
  snapshotMs: number;
  usage: PathUsage;
  /** Count of requests per final outcome; `none` for a request with no change. */
  outcomes: Record<string, number>;
  /** `runOnce` steps for the sequential path, batches for the batch path. */
  steps: number;
  /** The batches of the batch path: result status and size. */
  batches: { status: string; size?: number }[];
  /** The errors of failed attempts, in order. */
  attemptErrors: string[];
  /** One record per sampled request, in queue order. */
  requests: RequestRecord[];
  /** The requests of the sample, children included, still `running` or `queued` at the end; present only when more than 0. */
  unfinished?: number;
  duplicates?: DuplicateReport;
  /** The score against the labels; present when the sample is the queue of the bulk test wiki and the duplicates were judged. */
  score?: PathScore;
  /** The rounds of B and C (`--arch groups`, `--arch group-judge`); absent on the other paths. */
  rounds?: GroupRound[];
  /** The groups of the latest round of B, stored at its start; absent on the other paths. */
  roundGroups?: StoredGroups;
  /** The requests still queued on the copy at the end of B, the repair requests of step 9 that B does not run; absent on the other paths. */
  queuedAfter?: number;
}

/** A request whose outcomes differ between the paths. */
interface OutcomeDifference {
  requestId: string;
  change: string;
  sequential: string;
  batch: string;
}

/** The facts that differ between the two copies. */
export interface FactDifferences {
  /** Requests whose outcome differs. */
  outcomes: OutcomeDifference[];
  /** Facts written in the run whose header (matched in lower case; kept as written) only the sequential copy holds. */
  onlySequential: FactText[];
  /** Facts written in the run whose header (matched in lower case; kept as written) only the batch copy holds. */
  onlyBatch: FactText[];
  /** Facts written in the run under the same header in both copies. */
  sameHeader: number;
  /** Of `sameHeader`, those with the same content. */
  sameContent: number;
}

/** The result file. */
export interface BulkResultFile {
  startedAt: string;
  /** True when both paths ran to the end and the comparison is written. */
  complete: boolean;
  stoppedBy?: BulkStop;
  source: string;
  /** The environment that the source wiki came from; absent for a `--db` run. */
  env?: string;
  /** The wiki of that environment that the source was copied from; absent for a `--db` run. */
  wiki?: string;
  /** The requests of the sample. */
  requests: number;
  queuedInSource: number;
  /** The highest change seq of the copies at the start; the facts written in the run are those after it. */
  startSeq: number;
  batchSize: number;
  concurrency: number;
  /** The cosine distance cut of the grouping of the batch path; absent in a file of #60. */
  groupCut?: number;
  stub: boolean;
  /** True for `--second-only`: no sequential path and no differences; a resume continues it as second-only. */
  secondOnly?: boolean;
  /** The architecture that the `batch` result of a file of #60 holds; a new run writes none (the batch path is the worker's). */
  arch?: BulkArch;
  /** The cut and the shared-candidate setting of B in a file of #60; a new run writes none. */
  grouping?: GroupOptions;
  sequential?: PathResult;
  /** The path of the architecture under test (the batch path of the worker when `arch` is absent). */
  batch?: PathResult;
  differences?: FactDifferences;
}
