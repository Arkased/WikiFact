// The labels of the bulk test (issue #60): the end state that the wiki must hold after the 100 submissions of
// `bulk-submissions.ts`, run on the seed of `bulk-seed-facts.ts`. A label states what the claim check of
// docs/design/submit.md ("One claim, No beliefs") and the evidence rule of docs/design/updates.md give for the submission,
// when the requests run 1 at a time in queue order. It is written from those rules, never from the outcome of a run.
//
// The submission data (`BULK_SUBMISSIONS`) is the one source of the outcome, the reasons, the seed fact, the kept value and
// the earlier submission of a group. This file adds only what the submission does not hold: the fact that an accepted
// submission writes, the claims of a split, and the reason of a case that the rules do not settle. `BULK_LABELS` joins
// the two by queue position.
//
// Rules that fix the labels:
// - The queue order decides who is "new" and who is "duplicate". The 100 submissions run in queue order, and the children
//   of a split run after them, in the order of their parents.
// - A justification of the kind belief or inference ends as rejected unsupported at once. A justification that is a
//   report (hearsay) or a weak observation (an older draft) loses to the stronger justification of a fact in the wiki: the
//   reason is contradicted.
// - A claim that the wiki already holds, in other words or narrower, is a duplicate and writes no fact.
// - A compound submission is split. A child is never split again.
// - A correction writes a new version of the seed fact it targets, with the new value and without the old one.
// - A case that the rules do not settle carries `unclear`, with the reason. Its label is the best reading.
import { ChangeOutcome, RejectReason } from "../src/domain/enums.js";
import { ExpectedOutcome } from "../eval/lib/enums.js";
import { BULK_SUBMISSIONS, type BulkSubmission } from "./bulk-submissions.js";

/** A fact that the wiki must hold: the claim as a fact reads, and a cheap check of its content. */
interface ExpectedFact {
  /** The claim, written to stand alone. */
  content: string;
  /** Substrings (case-insensitive) that the content of the fact must all hold: the values of the claim. */
  anchors: string[];
  /** Substrings that the content must not hold: the out-of-date or the false value that the claim replaced or lost to. */
  avoid?: string[];
}

/** The fact that a duplicate restates: a seed fact by its header, or the fact that the submission at `position` wrote. */
export type DuplicateTarget = { seed: string } | { position: number };

/** The label of one claim of a split submission. */
export interface ClaimLabel {
  /** The claim, written to stand alone. */
  claim: string;
  outcome: ChangeOutcome.Accepted | ChangeOutcome.Duplicate;
  duplicateOf?: DuplicateTarget;
  fact?: ExpectedFact;
  /** Set when the label is a best reading of a case that the rules do not settle. */
  unclear?: string;
}

/** The label of one submission of the queue. */
export interface BulkLabel {
  /** The place in `BULK_SUBMISSIONS`, counted from 0. */
  position: number;
  outcome: ChangeOutcome;
  /** For a rejection: the reasons that are right; the rejection itself is what the end state needs. */
  reasons?: RejectReason[];
  /** For a duplicate: the fact it restates. */
  duplicateOf?: DuplicateTarget;
  /** For an accepted submission: the fact that the wiki must hold. */
  fact?: ExpectedFact;
  /** For a correction: the header of the seed fact that gets a new version. The version is the `fact`. */
  replaces?: string;
  /** For a split: the claims, in order, each with its own label. */
  claims?: ClaimLabel[];
  /** The value that the fact of a group with conflicting values must keep. */
  keeps?: string;
  /** Set when the label is a best reading of a case that the rules do not settle: the reason. */
  unclear?: string;
}

/** What the whole wiki must hold at the end, after the 100 submissions and their children. */
export interface ExpectedEndState {
  /** Facts that are not in the seed: one for each accepted claim. */
  newFacts: number;
  /** Seed facts that get a new version, by the corrections. */
  correctedSeedFacts: number;
  /** Pairs of live facts in one scope. */
  duplicatePairs: number;
  /** Live facts with 2 or more claims. */
  compoundFacts: number;
}

/** What a label adds to a submission: the data that `BULK_SUBMISSIONS` does not hold. */
interface LabelData {
  /** The place in `BULK_SUBMISSIONS`. */
  position: number;
  fact?: ExpectedFact;
  claims?: ClaimLabel[];
  unclear?: string;
}

/**
 * Builds the data of an accepted submission.
 *
 * @param position - the place in the queue
 * @param content - the fact that the wiki must hold
 * @param anchors - the values that the fact must hold
 * @param unclear - the reason, for a case that the rules do not settle
 * @returns the data
 * @sideEffects none
 */
function accepted(position: number, content: string, anchors: string[], unclear?: string): LabelData {
  return { position, fact: { content, anchors }, ...(unclear === undefined ? {} : { unclear }) };
}

/**
 * Builds the data of a correction: a new version of the out-of-date seed fact, which the submission names as its seed.
 *
 * @param position - the place in the queue
 * @param content - the new content of the seed fact
 * @param anchors - the new value
 * @param avoid - the old value
 * @returns the data
 * @sideEffects none
 */
function correction(position: number, content: string, anchors: string[], avoid: string[]): LabelData {
  return { position, fact: { content, anchors, avoid } };
}

/**
 * Builds the data of a split into claims.
 *
 * @param position - the place in the queue
 * @param claims - the claims, in order
 * @returns the data
 * @sideEffects none
 */
function split(position: number, claims: ClaimLabel[]): LabelData {
  return { position, claims };
}

/**
 * Builds the label of a claim of a split that restates a fact.
 *
 * @param claim - the claim, standing alone
 * @param duplicateOf - the fact it restates
 * @returns the claim label
 * @sideEffects none
 */
function dupClaim(claim: string, duplicateOf: DuplicateTarget): ClaimLabel {
  return { claim, outcome: ChangeOutcome.Duplicate, duplicateOf };
}

/**
 * Builds the label of a claim of a split that the wiki writes as a new fact.
 *
 * @param claim - the claim, standing alone
 * @param content - the fact that the wiki must hold
 * @param anchors - the values that the fact must hold
 * @param unclear - the reason, for a case that the rules do not settle
 * @returns the claim label
 * @sideEffects none
 */
function acceptedClaim(claim: string, content: string, anchors: string[], unclear?: string): ClaimLabel {
  return {
    claim,
    outcome: ChangeOutcome.Accepted,
    fact: { content, anchors },
    ...(unclear === undefined ? {} : { unclear }),
  };
}

/**
 * Builds the data of a submission whose only addition is the reason that the rules do not settle its case.
 *
 * @param position - the place in the queue
 * @param unclear - the reason
 * @returns the data
 * @sideEffects none
 */
function unclearAt(position: number, unclear: string): LabelData {
  return { position, unclear };
}

/**
 * The data of the labels that the submissions do not hold: the 40 facts of the accepted submissions, the 5 corrections, the
 * claims of the 10 splits, and the reason of each unclear case. A submission with no entry (a duplicate, a rejection) is
 * labeled from its submission alone.
 */
const LABEL_DATA_LIST: LabelData[] = [
  split(0, [
    dupClaim(
      "The console rates the reads per search as poor when the share of searches with 0 reads is over 0.5 (NO_READ_SHARE).",
      { seed: "No read share" },
    ),
    dupClaim(
      "The console rates the reads per search as poor when the share with 3 or more reads is over 0.3 (MANY_READS_SHARE).",
      { seed: "Many reads share" },
    ),
    acceptedClaim(
      "The console flags the sessions with no search when their share is over 0.3 (NO_SEARCH_SHARE).",
      "The console flags a health signal when the share of sessions with no search is over 0.3 (NO_SEARCH_SHARE).",
      ["NO_SEARCH_SHARE", "0.3"],
      "The evidence rule makes it accepted: the justification is an observation and no fact of the wiki disagrees. The constant NO_SEARCH_SHARE is not in src/ at v0.1.81, so the claim may be false; the wiki cannot know.",
    ),
  ]),
  split(1, [
    dupClaim("The source code of WikiFact is TypeScript.", { seed: "Source language" }),
    dupClaim("WikiFact runs on Node.js 22.", { seed: "Runtime version" }),
    dupClaim("WikiFact uses better-sqlite3.", { seed: "Database driver" }),
  ]),
  accepted(
    2,
    "The command npm run demo:seed creates the demo wiki with 10 facts and 3 tags.",
    ["demo:seed", "10 facts", "3 tags"],
    "Rule 3 of the claim check: 2 counts with their own names joined by and are 2 claims. Here they describe 1 output (the content of the demo wiki), so the label is 1 fact. A path that splits it into 10 facts and 3 tags is also defensible; it adds 1 fact and changes the children of position 56.",
  ),
  accepted(4, "The command npm run clean-temp is never run by npm run check.", ["clean-temp", "npm run check"]),
  split(7, [
    dupClaim("The tool listWikis is annotated read-only.", { position: 49 }),
    dupClaim("The question Q12 runs on sonnet with low effort in the question tests.", { position: 63 }),
    dupClaim("The command npm run clean-temp deletes only the temp folders that are older than 1 hour.", {
      position: 75,
    }),
  ]),
  correction(9, "The search tool returns at most 10 results by default.", ["10 results"], ["20 results"]),
  accepted(10, "The command npm run demo:seed deletes an existing database file at its path.", [
    "demo:seed",
    "deletes",
    "database file",
  ]),
  accepted(
    12,
    "The command npm run demo:seed writes a wikifact.json in local mode when the folder of the database has none.",
    ["demo:seed", "wikifact.json", "local"],
  ),
  accepted(14, "The command npm test runs the unit tests alone.", ["npm test", "unit tests"]),
  accepted(17, "The command npm run test:ui runs the browser test of the console alone.", ["test:ui", "browser test"]),
  split(18, [
    dupClaim("The typecheck of npm run check runs tsc with the incremental option.", { position: 86 }),
    dupClaim("WikiFact loads .env files through the dotenv library.", { position: 74 }),
  ]),
  unclearAt(
    19,
    "The claim adds that the operator runs clean-temp by hand. If that part counts as a new attribute, the label is accepted as a new fact. The core, that npm run check never starts it, is the fact of position 4.",
  ),
  accepted(21, "The format check of npm run check keeps a content-based cache.", ["format check", "cache", "content"]),
  accepted(23, "The unit tests and the browser test of npm run check run at the same time.", [
    "unit tests",
    "browser test",
    "same time",
  ]),
  correction(24, "A question call times out after 120 seconds by default.", ["120 seconds"], ["60 seconds"]),
  accepted(25, "The dead code check reports a dependency that sits in the wrong group.", [
    "dead code",
    "dependency",
    "wrong group",
  ]),
  accepted(
    26,
    "While the steps of npm run check run, the file wikifact-check-steps.json in the common git folder holds their pid.",
    ["wikifact-check-steps.json", "pid"],
  ),
  accepted(29, "The file package-lock.json pins the version of each library.", ["package-lock.json", "pins"]),
  split(30, [
    dupClaim("The file docs/future.md holds the ideas that have no plan, each with its trigger.", { position: 66 }),
    dupClaim("The folder docs/research/ holds the notes of measurements.", { position: 69 }),
    dupClaim("The project runs on Windows only.", { position: 84 }),
  ]),
  accepted(31, "A library module in src/ does not call console.", ["src/", "console"]),
  accepted(
    35,
    "An index file exports the public surface of its folder and holds no logic.",
    ["index file", "public surface", "no logic"],
    "Rule 3 of the claim check: 2 attributes that a reader would look up alone are 2 claims, and this sentence of docs/code-standard.md joins the export and the absence of logic. As one rule of the standard it reads as 1 claim. If it splits, the wiki holds 2 facts, and the claim of position 42 that an index file holds no logic is a duplicate of the second.",
  ),
  accepted(36, "No file in the repo carries an absolute local path.", ["absolute", "path"]),
  accepted(40, "An object type in the code is an interface, not a type alias.", ["interface", "type alias"]),
  accepted(41, "The lint step of npm run check runs without a cache.", ["lint", "without a cache"]),
  split(42, [
    dupClaim("An index file holds no logic.", { position: 35 }),
    dupClaim("The typecheck keeps its cache in the .cache folder.", { position: 89 }),
    dupClaim("The tool archiveWiki is annotated destructive.", { position: 53 }),
  ]),
  accepted(43, "A switch over an enum has no default branch, so that the compiler reports a missing case.", [
    "switch",
    "enum",
    "no default",
  ]),
  correction(45, "The default concurrency of a batch is 4 groups at the same time.", ["4 groups"], ["8 groups"]),
  accepted(46, "The environment variable WIKIFACT_TRANSPORT selects the transport of the question calls.", [
    "WIKIFACT_TRANSPORT",
    "transport",
  ]),
  accepted(49, "The tool listWikis is annotated read-only.", ["listWikis", "read-only"]),
  accepted(
    52,
    "The tool createWiki is annotated idempotent and not destructive.",
    ["createWiki", "idempotent", "destructive"],
    "Rule 3 of the claim check: idempotent and destructive are 2 annotations that a reader would look up alone, so it may split into 2 claims. They are the 2 hints of one tool annotation block, so the label is 1 fact.",
  ),
  accepted(53, "The tool archiveWiki is annotated destructive.", ["archiveWiki", "destructive"]),
  split(56, [
    dupClaim("The command npm run demo:seed creates a demo wiki with 10 facts.", { position: 2 }),
    dupClaim("The command npm test runs the unit tests alone.", { position: 14 }),
  ]),
  accepted(57, "When several archives share a name, unarchiveWiki restores the newest and says so in its answer.", [
    "unarchiveWiki",
    "newest",
  ]),
  accepted(60, "The question Q4 runs on opus with high effort in the question tests.", ["Q4", "opus", "high"]),
  accepted(61, "A check that finds the lock held prints a waiting message and tries again every 3 seconds.", [
    "lock",
    "3 seconds",
  ]),
  accepted(63, "The question Q12 runs on sonnet with low effort in the question tests.", ["Q12", "sonnet", "low"]),
  correction(64, "The cleanup queues at most 20 requests per finder per run.", ["20 requests"], ["50 requests"]),
  accepted(66, "The file docs/future.md holds the ideas that have no plan, each with its trigger.", [
    "docs/future.md",
    "no plan",
    "trigger",
  ]),
  split(67, [
    dupClaim("Each model call writes a row in the model_calls table.", { position: 78 }),
    dupClaim("The environment variable WIKIFACT_TRANSPORT selects the transport of the question calls.", {
      position: 46,
    }),
    dupClaim("The question Q4 runs on opus in the question tests.", { position: 60 }),
  ]),
  accepted(69, "The folder docs/research/ holds the notes of measurements.", ["docs/research", "measurements"]),
  accepted(
    73,
    "The first log line of serve and of worker names the mode, the transport and the condition.",
    ["first log line", "mode", "transport"],
    'Rules 2 and 3 of the claim check: the mode, the transport and the condition are 3 attributes that a reader looks up alone, and position 91 already treats "names the mode" as its own claim. They are the 3 parts of one log line, so the label is 1 fact. If it splits, the wiki holds 3 facts (2 more), and the first claim of position 91 is a duplicate of the first.',
  ),
  accepted(74, "WikiFact loads .env files through the dotenv library.", ["dotenv", ".env"]),
  accepted(75, "The command npm run clean-temp deletes only the temp folders that are older than 1 hour.", [
    "clean-temp",
    "1 hour",
  ]),
  accepted(78, "Each model call writes a row in the model_calls table.", ["model call", "model_calls"]),
  split(79, [
    dupClaim("The lint step of npm run check runs without a cache.", { position: 41 }),
    dupClaim("A switch over an enum has no default branch.", { position: 43 }),
    dupClaim("An object type in the code is an interface, not a type alias.", { position: 40 }),
  ]),
  accepted(80, "Step 1 of the pipeline is the claim check and the gathering of the facts around the claim.", [
    "step 1",
    "claim check",
  ]),
  accepted(84, "The project runs on Windows only.", ["Windows"]),
  correction(
    85,
    "A live tag with more than 15 live facts is a broad tag candidate.",
    ["15 live facts"],
    ["25 live facts"],
  ),
  accepted(86, "The typecheck of npm run check runs tsc with the incremental option.", [
    "typecheck",
    "tsc",
    "incremental",
  ]),
  accepted(88, "The command npm run clean-temp deletes the run folders of test runs that were stopped.", [
    "clean-temp",
    "stopped",
  ]),
  accepted(89, "The caches of the typecheck and of the format check live in the .cache folder.", [
    "typecheck",
    "format check",
    ".cache",
  ]),
  split(91, [
    dupClaim("The first log line of serve names the mode.", { position: 73 }),
    dupClaim("When several archives share a name, unarchiveWiki restores the newest.", { position: 57 }),
    dupClaim("The file package-lock.json pins the version of each library.", { position: 29 }),
  ]),
  accepted(92, "Application code and the evals delete their own temp folders.", ["temp folders", "evals"]),
  accepted(95, "The check lock of npm run check is named after the hash of the common git folder.", [
    "check lock",
    "hash",
    "git folder",
  ]),
  accepted(
    97,
    "The command npm run eval:bulk-wiki builds the wiki of the bulk test under the .cache folder of the repo.",
    ["bulk-wiki", ".cache"],
  ),
  accepted(99, "The command npm run clean-temp prints the counts of the folders it deleted.", ["clean-temp", "counts"]),
];

/**
 * Gives the outcome that a submission must end as, from its acceptable ends. The ends of one submission agree on the outcome.
 *
 * @param submission - the submission
 * @returns the outcome of its first acceptable end
 * @throws {Error} when the submission has no acceptable end
 * @sideEffects none
 */
function outcomeOf(submission: BulkSubmission): ChangeOutcome {
  switch (submission.expected[0]) {
    case ExpectedOutcome.AcceptedNew:
    case ExpectedOutcome.CorrectionAccepted:
      return ChangeOutcome.Accepted;
    case ExpectedOutcome.DuplicateOfSeed:
    case ExpectedOutcome.DuplicateOfEarlier:
    case ExpectedOutcome.MergedWith:
      return ChangeOutcome.Duplicate;
    case ExpectedOutcome.RejectedUnsupported:
    case ExpectedOutcome.RejectedContradicted:
    case ExpectedOutcome.RejectedCompound:
    case ExpectedOutcome.LosesInReconciliation:
      return ChangeOutcome.Rejected;
    case ExpectedOutcome.Split:
      return ChangeOutcome.Split;
    case undefined:
      throw new Error("A submission of the bulk test has no acceptable end.");
  }
}

/**
 * Gives the reasons that fit a rejection, from the acceptable ends of the submission.
 *
 * @param submission - a submission that ends as rejected
 * @returns the reasons, without repeats
 * @sideEffects none
 */
function reasonsOf(submission: BulkSubmission): RejectReason[] {
  const reasons = new Set<RejectReason>();
  for (const end of submission.expected) {
    if (end === ExpectedOutcome.RejectedUnsupported) reasons.add(RejectReason.Unsupported);
    if (end === ExpectedOutcome.RejectedContradicted || end === ExpectedOutcome.LosesInReconciliation)
      reasons.add(RejectReason.Contradicted);
    if (end === ExpectedOutcome.RejectedCompound) reasons.add(RejectReason.Compound);
  }
  return [...reasons];
}

/**
 * Gives the fact that a duplicate restates: its seed fact, or the first submission of its group.
 *
 * @param submission - a submission that ends as a duplicate
 * @returns the target
 * @sideEffects none
 */
function targetOf(submission: BulkSubmission): DuplicateTarget | undefined {
  if (submission.seed !== undefined) return { seed: submission.seed };
  const position = BULK_SUBMISSIONS.findIndex((s) => s.key !== undefined && s.key === submission.mergesWith);
  return position < 0 ? undefined : { position };
}

/**
 * Indexes the data of the labels by position.
 *
 * @param list - the data of the labels
 * @returns the data by position
 * @throws {Error} when 2 entries hold the same position
 * @sideEffects none
 */
function indexByPosition(list: LabelData[]): Map<number, LabelData> {
  const byPosition = new Map<number, LabelData>();
  for (const d of list) {
    if (byPosition.has(d.position)) throw new Error(`Two label entries for position ${d.position}`);
    byPosition.set(d.position, d);
  }
  return byPosition;
}

const LABEL_DATA = indexByPosition(LABEL_DATA_LIST);

/**
 * Joins a submission with the data of its label.
 *
 * @param submission - the submission at `position`
 * @param position - the place in the queue
 * @param data - the data of the label, when the submission has any
 * @returns the label
 * @throws {Error} when `data` gives a fact to a position that is not accepted, or claims to one that is not split
 * @sideEffects none
 */
function labelOf(submission: BulkSubmission, position: number, data: LabelData | undefined): BulkLabel {
  const outcome = outcomeOf(submission);
  const duplicateOf = outcome === ChangeOutcome.Duplicate ? targetOf(submission) : undefined;
  if (data?.fact !== undefined && outcome !== ChangeOutcome.Accepted) {
    throw new Error(`Position ${position} has a fact but its outcome is not accepted`);
  }
  if (data?.claims !== undefined && submission.expected[0] !== ExpectedOutcome.Split) {
    throw new Error(`Position ${position} has claims but its outcome is not split`);
  }
  return {
    position,
    outcome,
    ...(outcome === ChangeOutcome.Rejected ? { reasons: reasonsOf(submission) } : {}),
    ...(duplicateOf === undefined ? {} : { duplicateOf }),
    ...(data?.fact === undefined ? {} : { fact: data.fact }),
    ...(submission.expected[0] === ExpectedOutcome.CorrectionAccepted && submission.seed !== undefined
      ? { replaces: submission.seed }
      : {}),
    ...(data?.claims === undefined ? {} : { claims: data.claims }),
    ...(submission.keeps === undefined ? {} : { keeps: submission.keeps }),
    ...(data?.unclear === undefined ? {} : { unclear: data.unclear }),
  };
}

/**
 * The label of each of the 100 submissions, in queue order (by `position`).
 *
 * 40 are accepted as new facts, 5 are corrections, 23 are duplicates (18 of a seed fact, 5 of an earlier submission), 22
 * are rejections (9 unsupported, 13 contradicted) and 10 are splits. The 10 splits hold 28 claims: 1 is accepted and 27
 * are duplicates. So the wiki ends with 41 new facts, besides the 5 corrected seed facts.
 */
export const BULK_LABELS: BulkLabel[] = BULK_SUBMISSIONS.map((submission, position) =>
  labelOf(submission, position, LABEL_DATA.get(position)),
);

/**
 * The end state of the wiki, from the labels: 41 new facts (40 accepted submissions and 1 accepted claim of a split),
 * 5 corrected seed facts, no pair of live facts in one scope, no live fact with 2 or more claims.
 */
export const BULK_END_STATE: ExpectedEndState = {
  newFacts: 41,
  correctedSeedFacts: 5,
  duplicatePairs: 0,
  compoundFacts: 0,
};

/**
 * The new facts that a path adds to the end state when it splits an unclear accepted submission (research note
 * bulk-architectures-2026-10-22, "Unclear cases"): the positions 2, 35, 52 and 73 end as 1 fact by their label and as 2, 2,
 * 2 and 3 facts when split. The end state then holds 41 to 46 new facts, and a scorer takes any count in that range.
 */
export const MAY_SPLIT_EXTRA_FACTS: Record<number, number> = { 2: 1, 35: 1, 52: 1, 73: 2 };
