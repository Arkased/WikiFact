// Counting: which requests name a wrong fact, and the counts of one run, read from the store.
import { ChangeOutcome, RequestKind, RetrievalKind, SearchHitKind } from "../../src/domain/index.js";
import {
  countRetrievals,
  countVersions,
  getRequest,
  listRequestIds,
  listRequestIdsWithOutcome,
  search,
  type Store,
} from "../../src/store/index.js";
import { NameMatch } from "../lib/enums.js";
import { isWrong, type Data, type RequestRow, type SeedFact, type Task } from "./data.js";
import { must } from "./must.js";
import type { Seeded } from "./seed.js";

/** What one task produced: the answer, the requests it made and which wrong facts they name. */
export interface TaskResult {
  taskId: string;
  wrongKey: string;
  answer: string;
  answerOk: boolean;
  toolCalls?: number;
  costUsd?: number;
  turns?: number;
  error?: string;
  startedAt: number;
  wallMs: number;
  submissions: RequestRow[];
  namesOwn: boolean;
  namesAny: boolean;
  namedBy: string[];
}

/** The F17 result: where the probe queries rank the new facts. */
interface ProbeCounts {
  probes: number;
  hits: number;
  /** The 1-based rank of the new fact in each probe's results, or null when it is absent. */
  ranks: (number | null)[];
}

/** The counts of one run, all read from the store or from the task results. */
export interface Counts {
  tasks: number;
  /** `retrievals` rows of kind read written by the run. */
  retrievals: number;
  /** The same number; the name used by older result files. */
  getFactCalls: number;
  readsOfWrong: number;
  requestChange: number;
  /** `requestChange` rows that name any wrong fact. */
  namingWrong: number;
  /** `requestChange` rows that name the wrong fact of their own task. */
  namingOwn: number;
  /** Tasks with a request that names their own wrong fact. */
  tasksWithCorrection: number;
  /** Distinct wrong facts named. */
  wrongFactsNamed: number;
  answersOk: number;
  /** Changes rows with outcome accepted for a submission of the run. */
  accepted: number;
  acceptedNamingWrong: number;
  wrongFactsWithNewVersion: number;
  costUsd: number;
  f17: ProbeCounts;
}

/**
 * Does this request name the wrong fact? By target id, by header, or by subject word plus a topic word.
 *
 * @param row - the request row
 * @param f - the wrong fact
 * @param id - the id of that fact in the seeded wiki
 * @param terms - the wrong-term lists
 * @returns how the request names the fact, or null when it does not
 * @sideEffects none
 */
export function namesFact(row: RequestRow, f: SeedFact, id: string, terms: Data["terms"]): NameMatch | null {
  const targets = JSON.parse(row.targets) as string[];
  if (targets.includes(id)) return NameMatch.Target;
  const text = `${row.change ?? ""} ${row.justification ?? ""}`.toLowerCase();
  if (text.includes(f.header.toLowerCase())) return NameMatch.Header;
  const t = terms[f.key];
  if (t && text.includes(t.subject) && t.any.some((w) => text.includes(w))) return NameMatch.Terms;
  return null;
}

/**
 * Reads the submission requests of the store, oldest first, in the form of the result files.
 *
 * @param store - the open store
 * @returns one row per request of kind submission
 * @sideEffects none (reads)
 */
function listSubmissionRows(store: Store): RequestRow[] {
  return listRequestIds(store, RequestKind.Submission).map((id) => {
    const r = must(getRequest(store, id), `request ${id} vanished`);
    return {
      id: r.id,
      kind: r.kind,
      change: r.change,
      targets: JSON.stringify(r.targets),
      justification: r.justification,
      received_at: r.receivedAt,
    };
  });
}

/**
 * Lists the submissions that arrived after a snapshot.
 *
 * @param store - the open store
 * @param seen - the ids of the requests to leave out
 * @returns the other submission rows, oldest first
 * @sideEffects none (reads)
 */
export function submissionsSince(store: Store, seen: Set<string>): RequestRow[] {
  return listSubmissionRows(store).filter((r) => !seen.has(r.id));
}

// The seeded id of a fact.
function idOf(seeded: Seeded, f: SeedFact): string {
  return must(seeded.ids.get(f.key), `no id for the seed fact ${f.key}`);
}

/**
 * Says which wrong facts the requests of one task name.
 *
 * @param rows - the requests assigned to the task
 * @param task - the task
 * @param seeded - the seeded wiki
 * @param data - the seed data
 * @returns whether a request names the task's own wrong fact, whether one names any wrong fact, and how each own-fact request names it
 * @sideEffects none
 */
export function attribute(
  rows: RequestRow[],
  task: Task,
  seeded: Seeded,
  data: Data,
): Pick<TaskResult, "namesOwn" | "namesAny" | "namedBy"> {
  const wrong = data.facts.filter(isWrong);
  const own = must(
    data.facts.find((f) => f.key === task.wrong),
    `task ${task.id} names the unknown fact ${task.wrong}`,
  );
  const namedBy: string[] = [];
  let namesOwn = false;
  let namesAny = false;
  for (const r of rows) {
    const o = namesFact(r, own, idOf(seeded, own), data.terms);
    if (o) {
      namesOwn = true;
      namesAny = true;
      namedBy.push(o);
      continue;
    }
    if (wrong.some((w) => namesFact(r, w, idOf(seeded, w), data.terms))) namesAny = true;
  }
  return { namesOwn, namesAny, namedBy };
}

/**
 * F17: runs the probe queries of the new facts as a consumer search and reports where each new fact ranks.
 *
 * @param seeded - the seeded wiki
 * @param data - the seed data
 * @returns the number of probes, the number that returned the new fact, and the ranks
 * @sideEffects runs the embedder and reads the store
 */
async function probeNewFacts(seeded: Seeded, data: Data): Promise<ProbeCounts> {
  const ranks: (number | null)[] = [];
  for (const f of data.newFacts) {
    for (const q of f.probes ?? []) {
      const results = await search(seeded.store, q);
      const i = results.findIndex((r) => r.kind === SearchHitKind.Fact && r.id === seeded.ids.get(f.key));
      ranks.push(i < 0 ? null : i + 1);
    }
  }
  return { probes: ranks.length, hits: ranks.filter((r) => r !== null).length, ranks };
}

/** The input of `countRun`. */
export interface CountRunInput {
  seeded: Seeded;
  data: Data;
  results: TaskResult[];
  /** The start of the run, in ms since the epoch; earlier retrievals rows (the seed history) are not counted. */
  runStart: number;
  /** False when no worker ran: then no change was accepted and no fact has a new version. */
  workerRan: boolean;
}

/**
 * Counts one run from the task results and the store.
 *
 * @param input - the seeded wiki, the data, the task results, the run start and whether the worker ran
 * @returns the counts of the run
 * @sideEffects reads the store; runs the F17 probes (the embedder)
 */
export async function countRun(input: CountRunInput): Promise<Counts> {
  const { seeded, data, results, runStart, workerRan } = input;
  const { store } = seeded;
  const wrong = data.facts.filter(isWrong);
  const wrongIds = wrong.map((w) => idOf(seeded, w));
  const names = (row: RequestRow, f: SeedFact): boolean => namesFact(row, f, idOf(seeded, f), data.terms) !== null;
  const namesWrong = (row: RequestRow): boolean => wrong.some((w) => names(row, w));
  const submissions = results.flatMap((r) => r.submissions);

  const namedKeys = new Set<string>();
  for (const s of submissions) for (const w of wrong) if (names(s, w)) namedKeys.add(w.key);

  let accepted: RequestRow[] = [];
  if (workerRan) {
    const ids = new Set(listRequestIdsWithOutcome(store, RequestKind.Submission, ChangeOutcome.Accepted));
    accepted = submissions.filter((s) => ids.has(s.id));
  }
  const withNew = workerRan ? wrongIds.filter((id) => countVersions(store, id) > 1).length : 0;
  const retrievals = countRetrievals(store, { since: runStart, kind: RetrievalKind.Read });
  const readsOfWrong = countRetrievals(store, { since: runStart, kind: RetrievalKind.Read, factIds: wrongIds });

  const namingOwn = results.reduce((n, r) => {
    const own = must(
      data.facts.find((f) => f.key === r.wrongKey),
      `no seed fact ${r.wrongKey}`,
    );
    return n + r.submissions.filter((s) => names(s, own)).length;
  }, 0);

  return {
    tasks: results.length,
    retrievals,
    getFactCalls: retrievals,
    readsOfWrong,
    requestChange: submissions.length,
    namingWrong: submissions.filter(namesWrong).length,
    namingOwn,
    tasksWithCorrection: results.filter((r) => r.namesOwn).length,
    wrongFactsNamed: namedKeys.size,
    answersOk: results.filter((r) => r.answerOk).length,
    accepted: accepted.length,
    acceptedNamingWrong: accepted.filter(namesWrong).length,
    wrongFactsWithNewVersion: withNew,
    costUsd: results.reduce((s, r) => s + (r.costUsd ?? 0), 0),
    f17: await probeNewFacts(seeded, data),
  };
}
