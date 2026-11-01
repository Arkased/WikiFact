// technical/submit.md, "requestChange": the `warning` of `requestChange`, built from the worker status of technical/updates.md, "Queue and worker".
import { CallFailureKind } from "../domain/enums.js";
import { MAX_ATTEMPTS, type QueuePause, type WorkerStatus } from "../store/index.js";

/** A worker whose last poll is older than this is reported as not polling, in milliseconds. */
export const STALE_POLL_MS = 60_000;

const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * Names the condition that keeps the worker from processing a request, or nothing when the worker is healthy.
 *
 * @param status - the worker status of the database, or undefined when no worker has written one
 * @param now - the time, in ms since the epoch
 * @param pause - the `queue_pause` key of the database, or undefined when the queue runs; read from the key, not from the
 *   worker status, so that the warning holds before the worker has seen the key
 * @returns the warning text, or undefined when the worker polls and its calls work. The checks run in this order:
 *   no status, a stale poll, the operator pause, a credential failure, `MAX_ATTEMPTS` failures in a row
 * @sideEffects none
 */
export function workerWarning(status: WorkerStatus | undefined, now: number, pause?: QueuePause): string | undefined {
  if (status === undefined) return "no worker has run on this database";
  if (now - status.lastPollAt > STALE_POLL_MS) return `the worker has not polled since ${iso(status.lastPollAt)}`;
  if (pause !== undefined) {
    return `the operator paused the queue at ${iso(pause.at)}: ${pause.note}; the request waits until the operator resumes the queue`;
  }
  const call = status.lastCall;
  if (call && !call.ok && call.kind === CallFailureKind.Credential) {
    return `the worker's model credential failed at ${iso(call.at)}: ${call.message}; an expired token needs \`claude setup-token\``;
  }
  if (call && !call.ok && status.consecutiveFailures >= MAX_ATTEMPTS) {
    return `the worker's last ${status.consecutiveFailures} model calls failed: ${call.message}`;
  }
  return undefined;
}
