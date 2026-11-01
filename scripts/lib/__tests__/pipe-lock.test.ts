import { createServer } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { pipeName, takePipeLock } from "../pipe-lock.js";

const RETRY_MS = 50;

// A unique pipe name per test, so that no test sees the lock of another.
function freshName(): string {
  return pipeName(`test-${process.pid}-${Math.random().toString(36).slice(2)}`, "pipe-lock-test", "fixture");
}

async function hold(name: string): Promise<() => Promise<void>> {
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(name, resolve);
  });
  return () => new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("takePipeLock", () => {
  it("sleeps while the pipe is held, calls onWait once, and takes the pipe when the holder frees it", async () => {
    const name = freshName();
    const free = await hold(name);
    const sleeps = 3;
    const sleep = vi.fn(async () => {
      if (sleep.mock.calls.length === sleeps) await free();
    });
    const onWait = vi.fn();
    const server = await takePipeLock({ name, sleep, retryMs: RETRY_MS, onWait });
    try {
      expect(sleep).toHaveBeenCalledTimes(sleeps);
      expect(sleep).toHaveBeenCalledWith(RETRY_MS);
      expect(onWait).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
