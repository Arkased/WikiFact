// The queued submissions of the bulk test wiki (technical/updates.md, "The wiki of the bulk test"): 100 submissions about
// the WikiFact code base, each with the outcome it must end as. `npm run eval:bulk-wiki` queues them on the built wiki. A new
// failure case of the pipeline adds its submission here. The first 2 are the compound claims that the old batch path
// accepted and the one-at-a-time path rejected (issue #45).
import { ExpectedOutcome, JustificationKind, SubmissionKind } from "../eval/lib/enums.js";

import {
  COMPOUND,
  CONTRADICTED,
  CORRECTIONS,
  DUPLICATES,
  GROUP_CLAIMS,
  HEARSAY,
  NEW_FACTS,
  UNSUPPORTED,
  type Entry,
  type Member,
  type UnsupportedEntry,
} from "./bulk-claims.js";

/** One submission as `requestChange` takes it, with the outcome it must end as. */
export interface BulkSubmission {
  kind: SubmissionKind;
  /** The acceptable ends of a path that judges the submission right: a non-empty set, any member is right. */
  expected: ExpectedOutcome[];
  /** For a group with conflicting values, the value that the kept fact must hold, for a scorer that checks the kept fact. */
  keeps?: string;
  /** What else a scorer needs to know about the ends of the submission. */
  note?: string;
  change: string;
  justification: string;
  /** The kind of the justification: step 1 judges it before the claim, so a kind with no observation leaves 1 end. */
  justificationKind: JustificationKind;
  /** The name of the submission, for a later one that merges with it. */
  key?: string;
  /** The header of the seed fact that a duplicate restates, a correction replaces, a hearsay claim or a contradicted claim disagrees with. */
  seed?: string;
  /** The `key` of the earlier submission that this one merges with. */
  mergesWith?: string;
}

/**
 * The end of a compound submission with an observation as justification: the claim check splits it (docs/design/submit.md,
 * "One claim, No beliefs"). Only a child that is still compound is rejected as compound, and the queue holds no child.
 */
export const COMPOUND_ENDS = [ExpectedOutcome.Split];

/** The ends of a later member of a group that states the claim of the first in other words. */
const SAME_CLAIM_ENDS = [ExpectedOutcome.DuplicateOfEarlier, ExpectedOutcome.MergedWith];

/** The ends of a later member of a group that gives a value against the first, with a weaker observation. */
const CONFLICT_LOSS_ENDS = [ExpectedOutcome.RejectedContradicted, ExpectedOutcome.LosesInReconciliation];

const COMPOUND_FROM_THE_ISSUE: BulkSubmission[] = [
  {
    kind: SubmissionKind.Compound,
    expected: COMPOUND_ENDS,
    justificationKind: JustificationKind.Observation,
    change:
      "The console flags a read when the share of searches with 0 reads is over 0.5 (NO_READ_SHARE), the share with 3 or more reads is over 0.3 (MANY_READS_SHARE), or the share of sessions with no search is over 0.3 (NO_SEARCH_SHARE).",
    justification:
      "I read the signals section of docs/technical/console.md and the constants in src/console/signals.ts.",
  },
  {
    kind: SubmissionKind.Compound,
    expected: COMPOUND_ENDS,
    justificationKind: JustificationKind.Observation,
    note: "The split children (TypeScript, Node.js 22, better-sqlite3) are duplicates of seed facts.",
    change: "WikiFact is written in TypeScript on Node.js 22 with better-sqlite3.",
    justification: "I read the stack assumptions in docs/technical/README.md (A1) and package.json.",
  },
];

/**
 * Builds the submissions of one kind from its claims.
 *
 * @param kind - the kind of every submission of the list
 * @param expected - the acceptable ends of every submission of the list
 * @param list - the claims; the third item of a claim, when present, is the seed header it targets; the justification of
 *   each is an observation
 * @returns one submission per claim, in order
 * @sideEffects none
 */
function entries(kind: SubmissionKind, expected: ExpectedOutcome[], list: Entry[]): BulkSubmission[] {
  return list.map(([change, justification, seed]) => ({
    kind,
    expected,
    change,
    justification,
    justificationKind: JustificationKind.Observation,
    ...(seed === undefined ? {} : { seed }),
  }));
}

/**
 * Builds the submissions with a hearsay justification against a seed fact: step 1 lets a report through, and Q4 rejects
 * the claim as contradicted by the stronger justification of the seed fact.
 *
 * @param list - the claims, each with the header of the seed fact that states the true value
 * @returns one submission per claim, in order
 * @sideEffects none
 */
function hearsay(list: Entry[]): BulkSubmission[] {
  return list.map(([change, justification, seed]) => ({
    kind: SubmissionKind.Hearsay,
    expected: [ExpectedOutcome.RejectedContradicted],
    change,
    justification,
    justificationKind: JustificationKind.Hearsay,
    ...(seed === undefined ? {} : { seed }),
  }));
}

/**
 * Builds the submissions whose justification is a belief or an inference: step 1 rejects each as unsupported, whatever the claim.
 *
 * @param list - the claims, each with the kind of its justification
 * @returns one submission per claim, in order
 * @sideEffects none
 */
function unsupported(list: UnsupportedEntry[]): BulkSubmission[] {
  return list.map(([change, justification, justificationKind]) => ({
    kind: SubmissionKind.Unsupported,
    expected: [ExpectedOutcome.RejectedUnsupported],
    change,
    justification,
    justificationKind,
  }));
}

/**
 * Builds a group on one new subject: the first member is new, each later member merges with it. The members state the
 * same claim in other words, or give values that conflict, so that the reconciliation of a batch has to merge or choose.
 *
 * @param name - the name of the group; the key of member `i` is `<name>-<i>` counted from 1
 * @param members - the claims of the group, the first one the earliest in the queue
 * @param winner - for a group with conflicting values, the value that the kept fact must hold; the first member is true
 *   and the later ones lose; absent: the members state one claim
 * @returns one submission per member, in order
 * @sideEffects none
 */
function group(name: string, members: Member[], winner?: string): BulkSubmission[] {
  const later = winner === undefined ? SAME_CLAIM_ENDS : CONFLICT_LOSS_ENDS;
  return members.map(([change, justification], i) => ({
    kind: SubmissionKind.SameSubject,
    expected: i === 0 ? [ExpectedOutcome.AcceptedNew] : later,
    change,
    justification,
    justificationKind: JustificationKind.Observation,
    key: `${name}-${i + 1}`,
    ...(winner === undefined ? {} : { keeps: winner }),
    ...(i === 0 ? {} : { mergesWith: `${name}-1` }),
  }));
}

/** The 6 groups on new subjects, in order. */
const SAME_SUBJECT: BulkSubmission[] = GROUP_CLAIMS.flatMap(([name, members, winner]) => group(name, members, winner));

/**
 * Spreads the lists over the queue so that every kind comes early and none comes in a block: at each step it takes the
 * next item of the list with the largest share still to place. The order inside a list stays.
 *
 * @param lists - the lists to merge, none empty
 * @returns every item of every list, in the merged order
 * @sideEffects none
 */
function interleave(lists: BulkSubmission[][]): BulkSubmission[] {
  const queues = lists.map((l) => ({ items: l, next: 0 }));
  const out: BulkSubmission[] = [];
  for (;;) {
    const open = queues.filter((q) => q.next < q.items.length);
    const best = open.reduce<(typeof open)[number] | undefined>(
      (a, q) => (a === undefined || share(q) > share(a) ? q : a),
      undefined,
    );
    const item = best?.items[best.next];
    if (best === undefined || item === undefined) return out;
    out.push(item);
    best.next++;
  }
}

// The part of a list that is still to place, from 0 to 1.
function share(q: { items: BulkSubmission[]; next: number }): number {
  return (q.items.length - q.next) / q.items.length;
}

/**
 * The 100 submissions of the bulk test wiki, in queue order: the 2 compound claims of the issue come first, then the
 * kinds alternate, so that the first 10 hold every kind.
 */
export const BULK_SUBMISSIONS: BulkSubmission[] = [
  ...COMPOUND_FROM_THE_ISSUE,
  ...interleave([
    entries(SubmissionKind.New, [ExpectedOutcome.AcceptedNew], NEW_FACTS),
    entries(SubmissionKind.Duplicate, [ExpectedOutcome.DuplicateOfSeed], DUPLICATES),
    SAME_SUBJECT,
    unsupported(UNSUPPORTED),
    hearsay(HEARSAY),
    entries(SubmissionKind.Compound, COMPOUND_ENDS, COMPOUND),
    entries(SubmissionKind.Contradicted, [ExpectedOutcome.RejectedContradicted], CONTRADICTED),
    entries(SubmissionKind.Correction, [ExpectedOutcome.CorrectionAccepted], CORRECTIONS),
  ]),
];
