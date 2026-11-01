// The update agent: the 9 steps of technical/updates.md, "Pipeline" and the dependents loop of technical/updates.md, "Dependents loop", as deterministic code.
// Every judgment goes to a `Questions` method (types.ts). Nothing here calls a model directly.
import { RequestKind } from "../../domain/enums.js";
import type { ChangeRequestRow, Store } from "../../store/index.js";
import type { Questions } from "../types.js";
import { createContext, requestOf } from "./context.js";
import { operatorEdit } from "../operator-edit.js";
import { cleanupRepair } from "../cleanup-repair.js";
import { lookupRepair } from "./lookup-repair.js";
import { submission } from "./submission.js";
import type { AgentDeps, PipelineConfig, ProcessResult } from "./types.js";

/** The inputs of `processRequest`. */
export interface ProcessRequestOptions {
  store: Store;
  questions: Questions;
  config: PipelineConfig;
  row: ChangeRequestRow;
  deps?: AgentDeps;
}

/**
 * Runs one queued request by the kind of its row (technical/updates.md, "Queue and worker", technical/cleanup.md, "Cleanup").
 * A submission goes through the pipeline, a lookupRepair through its repair, an operatorEdit runs no model
 * question, and a cleanupRepair of the cleanup runs at most one question.
 *
 * @param opts - the store, the questions, the config, the queued request and the injection points
 * @returns the outcome of the request (accepted, duplicate, rejected or skipped) with the seqs it wrote
 * @throws {Error} on any failure, a `LintError` for a draft that fails the lint twice; the caller counts the attempt
 * @sideEffects reads the store; writes the store (one change per merge and one for the request, through
 *   `applyChange`, each with an embedder run; at most one queued lookupRepair row); makes the question calls; logs
 *   change and drop lines; reads the clock
 */
export async function processRequest(opts: ProcessRequestOptions): Promise<ProcessResult> {
  const { store, questions, config, row, deps = {} } = opts;
  const ctx = createContext(store, questions, config, { ...deps, requestId: row.id });
  const req = requestOf(row);
  switch (row.kind) {
    case RequestKind.Submission:
      return submission(ctx, req);
    case RequestKind.LookupRepair:
      return lookupRepair(ctx, req);
    case RequestKind.OperatorEdit:
      return operatorEdit(ctx, req);
    case RequestKind.CleanupRepair:
      return cleanupRepair(ctx, req);
  }
}
