import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LogEvent, LogLevel } from "../../domain/enums.js";
import type { LogLine } from "../../log/index.js";
import { RESTART_DELAY_MAX_MS, RESTART_DELAY_MS, RESTART_RESET_MS, superviseWorker } from "../worker-supervisor.js";
import { fakeChild, type FakeChild } from "./helpers/fake-child.js";

let children: FakeChild[];
let logs: LogLine[];
let restarts: number;

beforeEach(() => {
  vi.useFakeTimers();
  children = [];
  logs = [];
  restarts = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

function supervise(): ReturnType<typeof superviseWorker> {
  return superviseWorker({
    wiki: "alpha",
    log: (l) => void logs.push(l),
    countRestart: () => ++restarts,
    start: () => {
      const c = fakeChild();
      children.push(c);
      return c.worker;
    },
  });
}

// Lets the exit handler run: it waits on the `started` promise of the child.
const settle = async (ms = 0): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
};

describe('worker restart (technical/deployment.md, "Worker restart")', () => {
  it("starts a new child after the first delay, counts the restart and logs one error line", async () => {
    supervise();
    children[0]?.runs();
    children[0]?.exit(1);
    await settle(RESTART_DELAY_MS - 1);
    expect(children).toHaveLength(1);
    await settle(1);
    expect(children).toHaveLength(2);
    expect(restarts).toBe(1);
    expect(logs.filter((l) => l.event === LogEvent.WorkerRestart)).toMatchObject([
      { level: LogLevel.Error, wiki: "alpha", code: 1, delayMs: RESTART_DELAY_MS, restarts: 1 },
    ]);
  });

  it("doubles the delay with each exit in a row, up to the maximum", async () => {
    supervise();
    const delays: number[] = [];
    for (let i = 0; i < 12; i++) {
      const c = children.at(-1);
      c?.runs();
      c?.exit(1);
      await settle(RESTART_DELAY_MAX_MS);
      const line = logs.filter((l) => l.event === LogEvent.WorkerRestart).at(-1);
      if (line?.event === LogEvent.WorkerRestart) delays.push(line.delayMs);
    }
    expect(delays[0]).toBe(RESTART_DELAY_MS);
    expect(delays[1]).toBe(RESTART_DELAY_MS * 2);
    expect(Math.max(...delays)).toBe(RESTART_DELAY_MAX_MS);
    expect(delays.at(-1)).toBe(RESTART_DELAY_MAX_MS);
  });

  it("starts again with the first delay after a child that ran for the reset time", async () => {
    supervise();
    children[0]?.runs();
    children[0]?.exit(1);
    await settle(RESTART_DELAY_MS);
    children[1]?.runs();
    children[1]?.exit(1);
    await settle(RESTART_DELAY_MS * 2);
    children[2]?.runs();
    await settle(RESTART_RESET_MS);
    children[2]?.exit(1);
    await settle(RESTART_DELAY_MS);
    expect(children).toHaveLength(4);
    const delays = logs.flatMap((l) => (l.event === LogEvent.WorkerRestart ? [l.delayMs] : []));
    expect(delays).toEqual([RESTART_DELAY_MS, RESTART_DELAY_MS * 2, RESTART_DELAY_MS]);
  });

  it("starts no child after a stop that was asked for, and none while a delay is pending", async () => {
    const sup = supervise();
    children[0]?.runs();
    sup.stop();
    await settle(RESTART_DELAY_MAX_MS);
    expect(children).toHaveLength(1);
    expect(restarts).toBe(0);
    expect(logs.filter((l) => l.event === LogEvent.WorkerRestart)).toEqual([]);

    const sup2 = supervise();
    children[1]?.runs();
    children[1]?.exit(1);
    await settle(RESTART_DELAY_MS / 2);
    sup2.stop();
    await settle(RESTART_DELAY_MAX_MS);
    expect(children).toHaveLength(2);
  });

  it("starts no child after a first child that ended inside its start window", async () => {
    supervise();
    children[0]?.exit(1);
    await settle(RESTART_DELAY_MAX_MS);
    expect(children).toHaveLength(1);
    expect(restarts).toBe(0);
  });

  it("stands for the newest child", async () => {
    const sup = supervise();
    children[0]?.runs();
    children[0]?.exit(1);
    await settle(RESTART_DELAY_MS);
    expect(sup.child).toBe(children[1]?.worker.child);
    sup.stop();
    expect(children[1]?.stopped).toBe(true);
  });
});
