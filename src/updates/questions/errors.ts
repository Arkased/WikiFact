// The errors that the transports and the caller throw, and the text checks that classify a failure.
import { CallFailureKind, type QuestionErrorCode } from "../../domain/enums.js";

/**
 * The API or the CLI said "slow down" (HTTP 429, or "rate limit" in the text). The eval pool halves its limit and
 * retries.
 */
export class RateLimitError extends Error {
  /**
   * Creates the error.
   *
   * @param message - the message of the error
   * @param text - the exact text that was matched, for the log
   */
  constructor(
    message: string,
    readonly text: string,
  ) {
    super(message);
  }
}

/**
 * A failure that a retry fixes and that says nothing about the limit of the account (a corrupted config file read
 * by a racing child).
 */
export class TransientError extends Error {
  /**
   * Creates the error.
   *
   * @param message - the message of the error
   * @param text - the exact text that was matched, for the log
   */
  constructor(
    message: string,
    readonly text: string,
  ) {
    super(message);
  }
}

/** A question failed in a way the caller names with a code: refusal, truncation, invalid output or timeout. */
export class QuestionError extends Error {
  /**
   * Creates the error.
   *
   * @param code - which failure it is
   * @param message - the message of the error
   */
  constructor(
    readonly code: QuestionErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Tells whether a failure text is a transient one that a retry fixes.
 *
 * @param s - the error or stderr text
 * @returns true for a corrupted-config-file error
 * @sideEffects none
 */
export const looksTransient = (s: string): boolean => /configuration file .* is corrupted/i.test(s);

/**
 * Tells whether a failure text is a rate limit.
 *
 * @param s - the error or stderr text
 * @returns true for HTTP 429, "rate limit", "too many requests" or "overloaded"
 * @sideEffects none
 */
export const looksRateLimited = (s: string): boolean => /\b429\b|rate[ _-]?limit|too many requests|overloaded/i.test(s);

/**
 * Tells whether a failure text is a credential failure: HTTP 401 from the SDK, or a CLI result that says the login
 * is missing or expired.
 *
 * @param s - the error or stderr text
 * @returns true for HTTP 401, "not logged in", "login", "log in", "authentication" or "unauthorized"
 * @sideEffects none
 */
export const looksCredential = (s: string): boolean =>
  /\b401\b|not logged in|\blog ?in\b|authenticat|unauthori[sz]ed|invalid x-api-key/i.test(s);

/**
 * Sorts the text of a failed model call into the kinds that the worker status records. A credential failure wins
 * over a rate limit, because it is the one that needs a person.
 *
 * @param s - the error text of the failed attempt
 * @returns `Credential`, `RateLimit` or `Other`
 * @sideEffects none
 */
export function classifyCallFailure(s: string): CallFailureKind {
  if (looksCredential(s)) return CallFailureKind.Credential;
  if (looksRateLimited(s)) return CallFailureKind.RateLimit;
  return CallFailureKind.Other;
}
