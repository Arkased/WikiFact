import { setTimeout as delay } from "node:timers/promises";
import pMap from "p-map";
import PQueue from "p-queue";
import pRetry from "p-retry";
import { RateLimitError, TransientError } from "../../src/updates/index.js";
import { HALF, BACKOFF_FACTOR } from "../../src/constants.js";

/**
 * Runs the jobs with at most `n` in flight. The results keep the order of the jobs.
 *
 * @param n - the number of jobs in flight; below 1 counts as 1
 * @param jobs - the jobs, each started once
 * @returns the results in the order of `jobs`
 * @sideEffects whatever the jobs do; a job that throws rejects the whole call
 */
export function pool<T>(n: number, jobs: (() => Promise<T>)[]): Promise<T[]> {
  return pMap(jobs, (job) => job(), { concurrency: Math.max(1, Math.floor(n)) });
}

/** The model calls in flight when no `--concurrency` is given. */
export const DEFAULT_CONCURRENCY = 6;

/** The settings of an `AdaptivePool`; only `start` is required. */
export interface PoolOptions {
  /** The limit at the start, and the ceiling when it climbs back. */
  start: number;
  /** Never halved below this. */
  floor?: number;
  /** First pause after a rate limit, doubling up to `maxPauseMs`. */
  pauseMs?: number;
  maxPauseMs?: number;
  /** Successful calls needed to climb back by 1. */
  climbEvery?: number;
  /** Attempts per call before the rate-limit error is returned to the caller. */
  maxAttempts?: number;
  /** Called with the exact text of the first rate limit, so that the shape is learned. */
  onFirstRateLimit?: (text: string) => void;
}

/** The lowest concurrency after a halving. */
const DEFAULT_FLOOR = 2;
/** The first wait after a rate limit, in ms. */
const DEFAULT_PAUSE_MS = 1000;
/** The longest wait after a rate limit, in ms. */
const DEFAULT_MAX_PAUSE_MS = 30_000;
/** Successful calls between two climbs of the limit. */
const DEFAULT_CLIMB_EVERY = 20;
/** Attempts of one call before it fails. */
const DEFAULT_MAX_ATTEMPTS = 8;

/**
 * One pool for a whole run. `submit` runs a call when a slot is free. On a RateLimitError the limit is halved
 * (floor 2, at most once per pause window, so a burst of 429s counts once), the call waits 1 s, doubling up to 30 s,
 * and runs again. Every `climbEvery` successful calls the limit climbs back by 1, up to the start value.
 */
export class AdaptivePool {
  limit: number;
  readonly start: number;
  rateLimitRetries = 0;
  /** Retries of transient errors (a corrupted config file): a short pause, no halving. */
  transientRetries = 0;
  firstTransientText?: string;
  firstRateLimitText?: string;
  /** The limit over time: t in ms since the pool was made. */
  readonly history: { t: number; limit: number }[] = [];
  private readonly queue: PQueue;
  private ok = 0;
  private lastHalveAt = -Infinity;
  private readonly t0 = Date.now();
  private readonly o: Required<Omit<PoolOptions, "onFirstRateLimit">> & Pick<PoolOptions, "onFirstRateLimit">;

  /**
   * Makes a pool.
   *
   * @param opts - the start limit and the retry and climb settings
   * @sideEffects reads the clock
   */
  constructor(opts: PoolOptions) {
    this.o = {
      floor: DEFAULT_FLOOR,
      pauseMs: DEFAULT_PAUSE_MS,
      maxPauseMs: DEFAULT_MAX_PAUSE_MS,
      climbEvery: DEFAULT_CLIMB_EVERY,
      maxAttempts: DEFAULT_MAX_ATTEMPTS,
      ...opts,
    };
    this.start = Math.max(1, opts.start);
    this.limit = this.start;
    this.history.push({ t: 0, limit: this.limit });
    this.queue = new PQueue({ concurrency: this.limit });
  }

  /**
   * Counts the calls running now.
   *
   * @returns the number of calls in a slot
   * @sideEffects none
   */
  get active(): number {
    return this.queue.pending;
  }

  /**
   * Runs a call when a slot is free, retrying it after a rate limit or a transient error.
   *
   * @param fn - the call; it receives the time it waited in the queue
   * @returns the result of the call, or its error once the attempts are used up
   * @sideEffects runs `fn`; may pause and retry; reads the clock
   */
  submit<T>(fn: (info: { waitMs: number }) => Promise<T>): Promise<T> {
    return pRetry(
      (attemptNumber) => {
        const enqueuedAt = Date.now();
        // A retry goes ahead of the calls that have not started.
        return this.queue.add(() => this.attempt(fn, Date.now() - enqueuedAt), { priority: attemptNumber > 1 ? 1 : 0 });
      },
      {
        retries: this.o.maxAttempts - 1,
        // The pause is made in `onFailedAttempt`, which knows the kind of error; p-retry's own delay is off.
        minTimeout: 0,
        shouldRetry: ({ error }) => error instanceof RateLimitError || error instanceof TransientError,
        onFailedAttempt: async ({ error, attemptNumber, retriesLeft }) => {
          if (retriesLeft <= 0) return;
          if (error instanceof TransientError) {
            this.transientRetries++;
            this.firstTransientText ??= error.text;
            await delay(Math.min(this.o.pauseMs * attemptNumber, this.o.maxPauseMs));
          } else if (error instanceof RateLimitError) {
            this.rateLimitRetries++;
            if (this.firstRateLimitText === undefined) {
              this.firstRateLimitText = error.text;
              this.o.onFirstRateLimit?.(error.text);
            }
            const now = Date.now();
            if (now - this.lastHalveAt >= this.o.pauseMs) {
              this.lastHalveAt = now;
              this.setLimit(Math.max(this.o.floor, Math.floor(this.limit / HALF)));
            }
            await delay(Math.min(this.o.pauseMs * BACKOFF_FACTOR ** (attemptNumber - 1), this.o.maxPauseMs));
          }
        },
      },
    );
  }

  // One try of a call, in a slot. A success counts toward the climb back.
  private async attempt<T>(fn: (info: { waitMs: number }) => Promise<T>, waitMs: number): Promise<T> {
    const value = await fn({ waitMs });
    this.ok++;
    if (this.ok % this.o.climbEvery === 0 && this.limit < this.start) this.setLimit(this.limit + 1);
    return value;
  }

  private setLimit(n: number) {
    if (n === this.limit) return;
    this.limit = n;
    this.queue.concurrency = n;
    this.history.push({ t: Date.now() - this.t0, limit: n });
  }
}
