import { ChangeOutcome } from "../../src/domain/enums.js";
import type { LogLine } from "../../src/log/index.js";
import { enqueueRequest, searchAndLog, seedChange, type FactDraft, type Store } from "../../src/store/index.js";
import { StubQuestions } from "../../fakes/stub-questions.js";
import { runOnce, type RunOnceResult } from "../../src/updates/index.js";
import { makeStore } from "./store.js";

export const cfg = { subject: "Minecraft" };

export interface VersionRow {
  id: number;
  fact_id: string;
  seq: number;
  header: string;
  content: string;
  justification: string;
  change_reasoning: string;
  is_deleted: number;
}

export function versions(store: Store, factId: string): VersionRow[] {
  return store.db.prepare("SELECT * FROM fact_versions WHERE fact_id = ? ORDER BY seq").all(factId) as VersionRow[];
}

export function refs(store: Store, versionId: number): string[] {
  return (
    store.db
      .prepare("SELECT ref_fact_id FROM fact_version_refs WHERE fact_version_id = ? ORDER BY ref_fact_id")
      .all(versionId) as { ref_fact_id: string }[]
  )
    .map((r) => r.ref_fact_id)
    .sort();
}

export function count(store: Store, table: string, where = "1=1"): number {
  return (store.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number }).n;
}

export interface ChangeRow {
  seq: number;
  request_id: string;
  outcome: string;
  reject_reason: string | null;
  duplicate_of: string | null;
  summary: string;
}

export function changesOf(store: Store, requestId: string): ChangeRow[] {
  return store.db.prepare("SELECT * FROM changes WHERE request_id = ? ORDER BY seq").all(requestId) as ChangeRow[];
}

/** A store, a stub and the helpers of `world`. */
export interface World {
  store: Store;
  q: StubQuestions;
  logs: LogLine[];
  seed: (d: Partial<FactDraft> & { header: string; content: string }) => Promise<string>;
  seedEdit: (factId: string, d: Partial<FactDraft> & { header: string; content: string }) => Promise<void>;
  seedDelete: (factId: string, justification?: string) => Promise<void>;
  enqueue: (change: string, justification: string, extra?: { targets?: string[]; searchId?: string }) => string;
  run: () => Promise<RunOnceResult>;
  submit: (
    change: string,
    justification: string,
    extra?: { targets?: string[]; priorQuery?: string },
  ) => Promise<{ id: string; r: RunOnceResult }>;
}

/**
 * A store, a stub and helpers that seed facts and run requests.
 *
 * @param answers - the canned answers of the stub questions
 * @param store - the store of the world; default a store in memory (a batch needs a file store: `makeFileStore`)
 * @returns the store, the stub, the captured logs and the helpers
 */
export function world(answers: ConstructorParameters<typeof StubQuestions>[0] = {}, store: Store = makeStore()): World {
  const q = new StubQuestions(answers);
  const logs: LogLine[] = [];
  const log = (l: LogLine) => logs.push(l);

  /**
   * Writes a fact straight through applyChange, under a request that is already done.
   *
   * @param d - the draft of the fact
   * @returns the id of the new fact
   */
  async function seed(d: Partial<FactDraft> & { header: string; content: string }): Promise<string> {
    const res = await seedChange(store, {
      outcome: ChangeOutcome.Accepted,
      summary: "SECRET SUMMARY",
      changeReasoning: "SECRET REASON",
      facts: [{ justification: "I saw it.", references: [], ...d }],
    });
    const factId = res.factIds[0];
    if (factId === undefined) throw new Error("seedChange returned no fact id");
    return factId;
  }

  /**
   * Writes a new version of an existing fact.
   *
   * @param factId - the fact to edit
   * @param d - the new version
   */
  async function seedEdit(factId: string, d: Partial<FactDraft> & { header: string; content: string }): Promise<void> {
    await seedChange(store, {
      outcome: ChangeOutcome.Accepted,
      summary: "SECRET SUMMARY",
      changeReasoning: "SECRET REASON",
      facts: [{ factId, justification: "I saw it.", references: [], ...d }],
    });
  }

  async function seedDelete(factId: string, justification = "It is gone."): Promise<void> {
    await seedChange(store, {
      outcome: ChangeOutcome.Accepted,
      summary: "SECRET SUMMARY",
      changeReasoning: "SECRET REASON",
      facts: [{ factId, header: "", content: "", justification, references: [], isDeleted: true }],
    });
  }

  function enqueue(
    change: string,
    justification: string,
    extra: { targets?: string[]; searchId?: string } = {},
  ): string {
    return enqueueRequest(store, { change, justification, ...extra });
  }

  function run(): Promise<RunOnceResult> {
    return runOnce(store, q, cfg, { log });
  }

  /**
   * Enqueues a submission and runs the next request.
   *
   * @param change - the change text
   * @param justification - the justification text
   * @param extra - the optional targets and prior query
   * @param extra.targets - the fact ids the change targets
   * @param extra.priorQuery - the text of a search the caller ran before: the helper runs and logs it, and sends its `searchId`
   * @returns the request id and the run result
   */
  async function submit(
    change: string,
    justification: string,
    extra: { targets?: string[]; priorQuery?: string } = {},
  ): Promise<{ id: string; r: RunOnceResult }> {
    const { priorQuery, ...rest } = extra;
    const searchId =
      priorQuery === undefined ? undefined : (await searchAndLog(store, priorQuery, { strict: true })).searchId;
    const id = enqueue(change, justification, { ...rest, searchId });
    return { id, r: await run() };
  }

  return { store, q, logs, seed, seedEdit, seedDelete, enqueue, run, submit };
}
