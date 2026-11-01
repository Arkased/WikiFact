// A worker child that the test ends by hand, for the tests of the restart (technical/deployment.md, "Worker restart").
import type { ChildProcess } from "node:child_process";
import { WorkerChildState } from "../../../domain/enums.js";
import type { WorkerChild } from "../../../mcp/worker-child.js";

/** A fake worker child and the handles that drive it. */
export interface FakeChild {
  worker: WorkerChild;
  /** Marks the child as running past its start window. */
  runs(): void;
  /** Ends the child as an exit that nobody asked for. */
  exit(code: number | null, signal?: NodeJS.Signals | null): void;
  /** True once `stop` was called on it. */
  readonly stopped: boolean;
}

/**
 * Makes a fake worker child.
 *
 * @returns the child and its handles; `stop` ends the child the way a kill would
 * @sideEffects none
 */
export function fakeChild(): FakeChild {
  const proc = { exitCode: null as number | null, signalCode: null as NodeJS.Signals | null };
  let resolveExited: () => void = () => undefined;
  const exited = new Promise<void>((resolve) => (resolveExited = resolve));
  let settled = false;
  let resolveStarted: (v: WorkerChildState.Running | WorkerChildState.Exited) => void = () => undefined;
  const started = new Promise<WorkerChildState.Running | WorkerChildState.Exited>((resolve) => {
    resolveStarted = resolve;
  });
  let stopped = false;
  const end = (code: number | null, signal: NodeJS.Signals | null): void => {
    proc.exitCode = code;
    proc.signalCode = signal;
    resolveExited();
    if (!settled) {
      settled = true;
      resolveStarted(WorkerChildState.Exited);
    }
  };
  return {
    worker: {
      child: proc as unknown as ChildProcess,
      started,
      exited,
      stop: () => {
        stopped = true;
        end(null, "SIGTERM");
      },
    },
    runs: () => {
      if (settled) return;
      settled = true;
      resolveStarted(WorkerChildState.Running);
    },
    exit: (code, signal = null) => end(code, signal),
    get stopped() {
      return stopped;
    },
  };
}
