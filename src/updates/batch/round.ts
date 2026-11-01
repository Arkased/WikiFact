// technical/updates.md, "High volume mode": one round of a batch. The heads of the requests, the grouping, 1 group call for
// each group with the writes of its answers, and the fall back of a group to 1 request at a time.
import { LogEvent, LogLevel, MemberPrepKind, RunOnceStatus } from "../../domain/enums.js";
import type { Logger } from "../../log/index.js";
import { errorMessage } from "../../must.js";
import {
  StaleChangeError,
  takeRequest,
  takeStagedRequest,
  type BatchProgress,
  type ChangeRequestRow,
  type Store,
} from "../../store/index.js";
import { prepareMember, writeMember, type GroupMember } from "../agent/index.js";
import type { AgentDeps, PipelineConfig, ProcessResult } from "../agent/types.js";
import type { RunOnceResult } from "../run-once.js";
import { failedUsageOf, type GroupClaim, type Questions, type TokenUsage } from "../types.js";
import { halted, isRateLimit, runParallel, type Control } from "./control.js";
import { groupRequests } from "./groups.js";

/** What a request that ran to its end came to: the result of `runOnce` for a request that was taken. */
export type Settled = Exclude<RunOnceResult, { status: RunOnceStatus.Idle }>;

/** A request that stays in its group after its head: its row, taken, and the material that it brings to the group call. */
interface Slot {
  row: ChangeRequestRow;
  member: GroupMember;
}

/** What a round needs from the batch that runs it. */
export interface RoundEnv {
  /** The live store. */
  store: Store;
  /** The store of the heads: reads the live wiki, writes through the overlay store. */
  target: Store;
  /** The overlay store: the live wiki plus the staged set. */
  staging: Store;
  questions: Questions;
  config: PipelineConfig;
  /** The requests that run at once. */
  concurrency: number;
  /** The cosine distance under which 2 requests share a group. */
  groupCut: number;
  control: Control;
  log: Logger;
  now: () => number;
  /** The requests of the batch, in queue order. */
  ids: string[];
  /** The place of each request in the queue order of the batch; the round adds nothing. */
  queueRank: Map<string, number>;
  /** The group of each request, over both rounds; the round adds the groups that it makes. */
  groupOf: Map<string, number>;
  /** The children that the batch took from the staging tables. */
  stagedIds: Set<string>;
  /** The requests taken from the live queue and not settled. */
  inFlight: Set<string>;
  progress: BatchProgress;
  save(): void;
  /** A request that ran to its end on the staging set. */
  complete(row: ChangeRequestRow, result: ProcessResult): void;
  /** A request that waits for the promotion and runs again alone. */
  wait(row: ChangeRequestRow, factIds?: string[]): void;
  settle(r: Settled): void;
  /** The failure of a request, settled on the live wiki or in the staging tables. */
  fail(row: ChangeRequestRow, e: unknown): Settled;
  /** Runs a taken request through the whole pipeline on `on`. */
  runOne(row: ChangeRequestRow, on: Store, extra: AgentDeps): Promise<Settled | { stale: StaleChangeError }>;
  /** Records the rate limit of the model; the batch drops its staging set. */
  rateLimit(requestId: string, error: string): void;
}

/**
 * Turns the members of a group into the claims of the group call.
 *
 * @param slots - the requests that stay in the group, in queue order
 * @returns one claim for each, with positions from 1
 * @sideEffects none
 */
function claimsOf(slots: Slot[]): GroupClaim[] {
  return slots.map((s, i) => ({
    position: i + 1,
    change: s.member.req.change,
    justification: s.member.req.justification,
    ...(s.member.existing ? { existing: s.member.existing } : {}),
    related: s.member.related,
  }));
}

/**
 * Splits the tokens of one group call over the requests of the group: equal shares, the rest to the first.
 *
 * @param u - the tokens of the call
 * @param n - the number of requests in the group; at least 1
 * @returns one share for each request, in queue order; the shares add up to `u`
 * @sideEffects none
 */
export function splitUsage(u: TokenUsage, n: number): TokenUsage[] {
  const part = (v: number, i: number): number => Math.floor(v / n) + (i === 0 ? v % n : 0);
  return Array.from({ length: n }, (_, i) => ({
    input: part(u.input, i),
    output: part(u.output, i),
    cacheRead: part(u.cacheRead ?? 0, i),
    cacheWrite: part(u.cacheWrite ?? 0, i),
  }));
}

/**
 * Takes one request and runs Q7, the gather and Q1 on the live wiki.
 *
 * @param env - the batch
 * @param id - the request
 * @param fromStaging - true for a child that sits in the staging tables
 * @returns the slot when the request stays in a group; undefined for a request that Q7 ends, a request of a crowded scope
 *   and a failed request, and for a request that is not queued any more
 * @sideEffects takes the request (`running`); Q7, the gather and Q1 model calls; embedder runs; writes the progress key;
 *   settles the request that leaves the round
 */
async function head(env: RoundEnv, id: string, fromStaging: boolean): Promise<Slot | undefined> {
  const row = fromStaging ? takeStagedRequest(env.store, id, env.now()) : takeRequest(env.store, id, env.now());
  if (row === null) return undefined;
  if (fromStaging) env.stagedIds.add(id);
  else env.inFlight.add(id);
  env.progress.taken++;
  env.save();
  try {
    const prep = await prepareMember({
      store: env.target,
      questions: env.questions,
      config: env.config,
      row,
      deps: { log: env.log, now: env.now, staleCheck: true, inBatch: true },
    });
    switch (prep.kind) {
      case MemberPrepKind.Ended:
        env.complete(row, prep.result);
        return undefined;
      case MemberPrepKind.Crowded:
        env.wait(row);
        return undefined;
      case MemberPrepKind.Member:
        return { row, member: prep.member };
    }
  } catch (e) {
    if (e instanceof StaleChangeError) env.wait(row, e.factIds);
    else env.settle(env.fail(row, e));
    return undefined;
  }
}

/**
 * Runs the members of a group that fall back: the pipeline of 1 request at a time on the overlay store, in queue order, with
 * the stale check. A request that the group call has already written is not among them.
 *
 * @param env - the batch
 * @param slots - the requests that fall back
 * @param group - the ids of the whole group, whose staged writes do not count as a change
 * @param reason - why the group fell back, for the log
 * @sideEffects logs a warning; the pipeline of each request; settles each
 */
async function fallBack(env: RoundEnv, slots: Slot[], group: string[], reason: string): Promise<void> {
  env.log({
    event: LogEvent.Unhandled,
    level: LogLevel.Warn,
    error: `the group fell back to 1 request at a time: ${reason}`,
  });
  for (const s of slots) {
    if (halted(env.control)) return;
    const r = await env.runOne(s.row, env.staging, { staleCheck: true, inBatch: true, group });
    if ("stale" in r) env.wait(s.row, r.stale.factIds);
    else if (r.status === RunOnceStatus.Done) env.complete(s.row, r.result);
    else env.settle(r);
  }
}

/**
 * Judges the claims of 1 group with 1 group call and writes the answers in queue order. A second invalid answer or a failed
 * call makes the group fall back; a failed write makes the rest of the group fall back, from the failed claim on; a rate
 * limit stops the batch.
 *
 * @param env - the batch
 * @param slots - the requests of the group, in queue order
 * @sideEffects the group call (a `model_calls` row for each attempt, under the first request); the tokens of the call,
 *   a failed call included, go to the usage account of the questions in equal shares, one before the write of each request, and all
 *   of a failed call before the first fall back; writes the answers to the
 *   staging set; settles the requests
 */
async function judgeGroup(env: RoundEnv, slots: Slot[]): Promise<void> {
  const first = slots[0];
  if (first === undefined) return;
  const group = slots.map((s) => s.row.id);
  let answers;
  let shares: TokenUsage[];
  try {
    const res = await env.questions.group.ask(
      { claims: claimsOf(slots) },
      { subject: env.config.subject, requestId: first.row.id },
    );
    answers = res.output.answers;
    shares = splitUsage(res.usage, slots.length);
  } catch (e) {
    const message = errorMessage(e);
    if (isRateLimit(e)) {
      env.rateLimit(first.row.id, message);
      return;
    }
    // The failed call used tokens too: every share goes to the account before the first request runs, so a stop in the
    // fall back loses none.
    const used = failedUsageOf(e);
    if (used) for (const share of splitUsage(used, slots.length)) env.questions.addUsage?.(share);
    await fallBack(env, slots, group, `group call: ${message}`);
    return;
  }
  const addShare = (i: number): void => {
    const share = shares[i];
    if (share !== undefined) env.questions.addUsage?.(share);
  };
  // The fact that each claim wrote, by position, for the claims that target an earlier claim.
  const earlier = new Map<number, string>();
  for (const [i, slot] of slots.entries()) {
    if (halted(env.control)) return;
    addShare(i);
    try {
      const answer = answers[i];
      if (!answer) throw new Error(`the group answer has no entry for claim ${i + 1}`);
      const result = await writeMember(slot.member, answer, earlier, { store: env.staging, group });
      env.complete(slot.row, result);
      if (result.claimFactId) earlier.set(answer.position, result.claimFactId);
    } catch (e) {
      if (e instanceof StaleChangeError) {
        env.wait(slot.row, e.factIds);
      } else if (isRateLimit(e)) {
        env.rateLimit(slot.row.id, errorMessage(e));
        return;
      } else {
        // The request that failed has its share; the requests after it take theirs before they run.
        for (let j = i + 1; j < slots.length; j++) addShare(j);
        await fallBack(env, slots.slice(i), group, `group write: ${errorMessage(e)}`);
        return;
      }
    }
  }
}

/**
 * Runs one round: the heads of the requests, the groups, and the group calls.
 *
 * @param env - the batch
 * @param roundIds - the requests of the round
 * @param fromStaging - true for the children of the first round, which sit in the staging tables
 * @sideEffects as `head`, `judgeGroup` and `fallBack`; the grouping runs the embedder; adds the groups to `env.groupOf`
 */
export async function runRound(env: RoundEnv, roundIds: string[], fromStaging: boolean): Promise<void> {
  const slots: Slot[] = [];
  await runParallel(
    env.control,
    env.concurrency,
    roundIds.map((id) => async (): Promise<void> => {
      const slot = await head(env, id, fromStaging);
      if (slot !== undefined) slots.push(slot);
    }),
  );
  if (halted(env.control)) return;
  slots.sort(
    (a, b) => (env.queueRank.get(a.row.id) ?? env.ids.length) - (env.queueRank.get(b.row.id) ?? env.ids.length),
  );
  const groups = await groupRequests(
    slots.map((s) => ({ id: s.row.id, change: s.row.change })),
    env.groupCut,
  );
  const slotOf = new Map(slots.map((s) => [s.row.id, s]));
  const base = env.groupOf.size;
  for (const [g, members] of groups.entries()) for (const id of members) env.groupOf.set(id, base + g);
  await runParallel(
    env.control,
    env.concurrency,
    groups.map((members) => async (): Promise<void> => {
      await judgeGroup(
        env,
        members.flatMap((id) => slotOf.get(id) ?? []),
      );
    }),
  );
}
