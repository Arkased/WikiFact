import { describe, expect, it } from "vitest";
import { BatchRunStatus, RunOnceStatus } from "../../domain/enums.js";
import type { WorkerStatus } from "../../store/index.js";
import type { BatchRunResult } from "../batch/run.js";
import type { RunOnceResult } from "../run-once.js";
import { afterSoloStep, initialWorkerStatus, nextBatchWorkerStatus } from "../worker-status.js";

const NOW = 5_000_000;
const withError: WorkerStatus = {
  ...initialWorkerStatus(1_000),
  lastBatchError: { message: "the live wiki moved", at: 2_000 },
};
const done = (failed: number, error?: string): BatchRunResult =>
  ({ status: BatchRunStatus.Done, size: 3, failed, ...(error === undefined ? {} : { error }) }) as BatchRunResult;

describe('the batch error of the worker status (technical/updates.md, "Queue and worker")', () => {
  it("records a dropped batch as its own event, with no model call failure", () => {
    const next = nextBatchWorkerStatus(
      initialWorkerStatus(1_000),
      { status: BatchRunStatus.Dropped, error: "the live wiki moved", ids: ["a"] },
      NOW,
    );
    expect(next.lastBatchError).toEqual({ message: "the live wiki moved", at: NOW });
    expect(next.consecutiveFailures).toBe(0);
    expect(next.lastCall).toBeUndefined();
  });

  it("clears it when a batch ends, also when every request of the batch failed an attempt", () => {
    expect(nextBatchWorkerStatus(withError, done(0), NOW).lastBatchError).toBeUndefined();
    const allFailed = nextBatchWorkerStatus(withError, done(3, "boom"), NOW);
    expect(allFailed.lastBatchError).toBeUndefined();
    expect(allFailed.consecutiveFailures).toBe(1);
  });
});

describe('the steps left of the 1-at-a-time run after a dropped batch (technical/updates.md, "High volume mode", rule 6)', () => {
  const idle: RunOnceResult = { status: RunOnceStatus.Idle };
  const limited: RunOnceResult = { status: RunOnceStatus.RateLimited, requestId: "r", error: "429" };
  const queued: RunOnceResult = { status: RunOnceStatus.Queued, requestId: "r", error: "boom" };

  it("sets the steps left to 0 on an idle poll", () => {
    expect(afterSoloStep(3, withError, idle).left).toBe(0);
  });

  it("does not count a rate-limited step, and counts a failed attempt", () => {
    const limitedStep = afterSoloStep(3, withError, limited);
    expect(limitedStep.left).toBe(3);
    expect(limitedStep.status.lastBatchError).toBeDefined();
    expect(afterSoloStep(3, withError, queued).left).toBe(2);
  });

  it("clears the batch error when the run ends, by its last step or by an idle poll, and not before", () => {
    expect(afterSoloStep(2, withError, queued).status.lastBatchError).toBeDefined();
    expect(afterSoloStep(1, withError, queued).status.lastBatchError).toBeUndefined();
    expect(afterSoloStep(3, withError, idle).status.lastBatchError).toBeUndefined();
  });

  it("leaves a worker with no run alone", () => {
    expect(afterSoloStep(0, withError, idle)).toEqual({ left: 0, status: withError });
  });
});
