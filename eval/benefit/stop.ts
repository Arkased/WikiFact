// The errors that stop a whole run of the benefit test (technical/evaluation.md, "Order, stop and resume").
import { looksRateLimited } from "../../src/updates/index.js";

/** The characters of an error text kept in the stop reason and in the log line of a failed job. */
export const ERROR_TEXT_CHARS = 200;

/** The characters of the error of an agent run kept in its log line. */
export const LOG_ERROR_CHARS = 80;

/** The text of an error that means the login or the account cannot go on, so the whole run stops and keeps its rows. */
const STOP_PATTERN =
  /hit your .{0,20}limit|usage limit|limit reached|reached your .{0,30}limit|failed to authenticate|oauth session expired|invalid api key|credit balance/i;

/**
 * Tells whether an error text is one that stops the whole run: a rate limit or a failed login.
 *
 * @param text - the error text of an agent run, of the judge or of a worker step
 * @returns the reason for the result file, or undefined when the run goes on
 * @sideEffects none
 */
export function stopReasonOf(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  if (looksRateLimited(text) || STOP_PATTERN.test(text))
    return `rate limit or login: ${text.slice(0, ERROR_TEXT_CHARS)}`;
  return undefined;
}
