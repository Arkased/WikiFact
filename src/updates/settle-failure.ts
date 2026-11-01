// technical/updates.md, "Queue and worker", "Model call failures": what a failed request becomes. `runOnce` and the batch share it.
import { CallFailureKind, LogEvent, LogLevel, RequestStatus, RunOnceStatus } from "../domain/enums.js";
import type { Logger } from "../log/index.js";
import { InvariantError, errorMessage } from "../must.js";
import { failAttempt, failRequest, releaseRequest, type ChangeRequestRow, type Store } from "../store/index.js";
import { classifyCallFailure } from "./questions/index.js";

/** How a failed request was settled, with the error text. */
export interface Settled {
  status: RunOnceStatus.Queued | RunOnceStatus.Failed | RunOnceStatus.RateLimited;
  error: string;
}

/**
 * Settles a request that threw: a rate limit puts it back unchanged, a broken invariant fails it at its first attempt, any
 * other error counts an attempt (queued again, or failed after the last one).
 *
 * @param store - the open store with the write connection
 * @param log - the logger
 * @param row - the request as taken (its attempt count before this failure)
 * @param e - what was thrown
 * @returns the status of the request and the error text
 * @sideEffects one update on the row; one `LogEvent.AttemptFailed` line, except for a rate limit
 */
export function settleFailure(store: Store, log: Logger, row: ChangeRequestRow, e: unknown): Settled {
  const error = errorMessage(e);
  if (classifyCallFailure(error) === CallFailureKind.RateLimit) {
    releaseRequest(store, row.id, error);
    return { status: RunOnceStatus.RateLimited, error };
  }
  let status: RunOnceStatus.Queued | RunOnceStatus.Failed;
  if (e instanceof InvariantError) {
    failRequest(store, row.id, error);
    status = RunOnceStatus.Failed;
  } else {
    status = failAttempt(store, row.id, error) === RequestStatus.Queued ? RunOnceStatus.Queued : RunOnceStatus.Failed;
  }
  // F12: one log line per failure. A queued row is a retry (warn); a failed row is out of attempts (error).
  const level = status === RunOnceStatus.Failed ? LogLevel.Error : LogLevel.Warn;
  log({ event: LogEvent.AttemptFailed, level, request_id: row.id, attempt: row.attempts + 1, status, error });
  return { status, error };
}
