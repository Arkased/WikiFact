// The model call rows of technical/updates.md, "Model call rows".
import { newId } from "./queue.js";
import type { Store } from "./types/index.js";

/** What `recordModelCall` stores for one model call of the worker. */
export interface ModelCallInput {
  /** The change request that the call served. */
  requestId: string;
  /** The question name, for example `Q4`. */
  question: string;
  model: string;
  effort: string;
  tokensIn: number;
  tokensOut: number;
  tokensCacheRead: number;
  tokensCacheWrite: number;
  /** The duration of the call, in ms. */
  durationMs: number;
  /** The time of the call, in ms since the epoch. */
  at: number;
}

/**
 * Writes the `model_calls` row of one model call, in its own transaction. A request that exists only as a staged child of
 * a split (a row in `stg_change_requests`, not in `change_requests`) gets its row under its live parent.
 *
 * @param store - the open store with the write connection
 * @param input - the request, the question, the model, the effort, the 4 token counts, the duration and the time
 * @returns the id of the row, a ULID
 * @throws {Error} when `requestId` names no change request
 * @sideEffects one transaction on the store
 */
export function recordModelCall(store: Store, input: ModelCallInput): string {
  const id = newId();
  store.db
    .transaction(() => {
      // `model_calls.request_id` refers to the live `change_requests`; a staged child is not there, its parent is.
      const staged = store.db
        .prepare(
          `SELECT parent_id AS parentId FROM main.stg_change_requests
           WHERE id = ? AND NOT EXISTS (SELECT 1 FROM main.change_requests WHERE id = ?)`,
        )
        .get(input.requestId, input.requestId) as { parentId: string | null } | undefined;
      const requestId = staged?.parentId ?? input.requestId;
      store.db
        .prepare(
          `INSERT INTO model_calls(id, request_id, question, model, effort, tokens_in, tokens_out, tokens_cache_read,
                                   tokens_cache_write, duration_ms, at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          requestId,
          input.question,
          input.model,
          input.effort,
          input.tokensIn,
          input.tokensOut,
          input.tokensCacheRead,
          input.tokensCacheWrite,
          input.durationMs,
          input.at,
        );
    })
    .immediate();
  return id;
}

/** The sums of the `model_calls` rows of one model and one question (technical/updates.md, "Model call rows"). */
export interface ModelCallTotals {
  model: string;
  question: string;
  calls: number;
  tokensIn: number;
  tokensOut: number;
  tokensCacheRead: number;
  tokensCacheWrite: number;
}

/**
 * Sums the model call rows from a time on, by model and question, for the test of both paths of the high volume mode.
 *
 * @param store - the open store
 * @param sinceAt - the lower bound of `at`, in ms since the epoch; a row at this time counts
 * @returns one entry per model and question that has a row; empty when there is none
 * @sideEffects none (reads `model_calls`)
 */
export function modelCallTotals(store: Store, sinceAt: number): ModelCallTotals[] {
  return store.db
    .prepare(
      `SELECT model, question, COUNT(*) AS calls, SUM(tokens_in) AS tokensIn, SUM(tokens_out) AS tokensOut,
              SUM(tokens_cache_read) AS tokensCacheRead, SUM(tokens_cache_write) AS tokensCacheWrite
       FROM model_calls WHERE at >= ? GROUP BY model, question ORDER BY model, question`,
    )
    .all(sinceAt) as ModelCallTotals[];
}
