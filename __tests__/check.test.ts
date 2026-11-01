import { existsSync, mkdtempSync, readFileSync, watch, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { execa } from "execa";
import { describe, expect, it, vi } from "vitest";
import {
  isAlive,
  killOrphan,
  lockName,
  readStartTime,
  runSteps,
  stepsArgs,
  takeLock,
  type RunStepsOptions,
} from "../scripts/check.js";
import { scopeOf } from "../scripts/lib/check-scope.js";
import { ChangeKind } from "../eval/lib/enums.js";
import { PROCESS_START_TIMEOUT_MS } from "./helpers/timeouts.js";

const CHECK_MODULE = pathToFileURL(join(import.meta.dirname, "..", "scripts", "check.ts")).href;

/** The timeout of a test that spawns a process, in milliseconds. It is the only limit of a wait in these tests. */
const TEST_TIMEOUT_MS = 20000;

// Resolves on the first 'data' event after which the text of the stream includes the marker.
function outputIncludes(stream: NodeJS.ReadableStream, marker: string): Promise<void> {
  return new Promise((resolve) => {
    let output = "";
    stream.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes(marker)) resolve();
    });
  });
}

describe("check lock across processes", () => {
  it(
    "frees the lock when the holder process is killed hard",
    async () => {
      const name = lockName(mkdtempSync(join(tmpdir(), "check-lock-test-")), "fixture");
      const script = `import { takeLock } from ${JSON.stringify(CHECK_MODULE)};
      await takeLock({ name: ${JSON.stringify(name)}, sleep: async () => undefined, log: () => undefined });
      console.log("held");
      setInterval(() => undefined, 1000);`;
      const holder = execa(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
        reject: false,
        stdout: "pipe",
        stderr: "inherit",
      });
      try {
        await outputIncludes(holder.stdout, "held");
      } finally {
        holder.kill("SIGKILL");
        await holder;
      }
      const taken = await takeLock({
        name,
        sleep: () => Promise.reject(new Error("the lock was still held after the kill")),
        log: () => undefined,
      });
      taken.close();
    },
    TEST_TIMEOUT_MS,
  );
});

// A process that stays alive until it is killed.
function idleProcess(): ReturnType<typeof execa> {
  return execa(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], { reject: false, stdio: "ignore" });
}

describe("check steps", () => {
  it(
    "passes on the exit code of the steps",
    async () => {
      expect(await runSteps(process.execPath, ["-e", "process.exit(7)"])).toBe(7);
      expect(await runSteps(process.execPath, ["-e", "process.exit(0)"])).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "kills the whole tree of the steps on a stop and returns 1",
    async () => {
      // The steps spawn a grandchild; the grandchild connects to this test and sends its pid. The test learns of the
      // pid by the 'data' event and of the death of the grandchild by the 'close' event of its connection.
      let connect: (socket: Socket) => void = () => undefined;
      const connected = new Promise<Socket>((resolve) => {
        connect = resolve;
      });
      const server = createServer((socket) => connect(socket));
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("the test server has no port");
      const grandchild = `require("node:net").connect(${address.port}, "127.0.0.1", function () { this.write(String(process.pid)); }); setInterval(() => undefined, 1000);`;
      const steps = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { stdio: "ignore" }); setInterval(() => undefined, 1000);`;
      const stop = new AbortController();
      const running = runSteps(process.execPath, ["-e", steps], { stop: stop.signal });
      let grandchildPid = 0;
      try {
        const socket = await connected;
        // The kill of the grandchild resets its connection; that is the event under test, not a fault.
        socket.on("error", () => undefined);
        grandchildPid = await new Promise<number>((resolve) => {
          socket.once("data", (data: Buffer) => resolve(Number(data.toString())));
        });
        expect(isAlive(grandchildPid)).toBe(true);
        const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
        stop.abort();
        expect(await running).toBe(1);
        await closed;
        expect(isAlive(grandchildPid)).toBe(false);
      } finally {
        if (grandchildPid !== 0 && isAlive(grandchildPid)) process.kill(grandchildPid, "SIGKILL");
        stop.abort();
        await running;
        server.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "writes the record of the steps while they run and deletes it when they end",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "check-record-test-"));
      const file = join(dir, "steps.json");
      expect(await runSteps(process.execPath, ["-e", "process.exit(0)"], { recordFile: file })).toBe(0);
      expect(existsSync(file)).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );
});

// Steps that stay alive: the program connects to the test, sends its pid, and exits with the given code on the first
// message it gets. The test decides when it ends, so no wall clock is involved.
const FIXTURE = `import { connect } from "node:net";
const [port, code] = process.argv.slice(2);
const socket = connect(Number(port), "127.0.0.1", () => socket.write(String(process.pid) + "\\n"));
socket.on("data", () => process.exit(Number(code)));
`;
const STEPS_EXIT_CODE = 3;

interface LiveSteps {
  /** The pid that the steps report. */
  pid: number;
  /** Tells the steps to exit. */
  release: () => void;
  /** Resolves with the record once it is written and complete. */
  record: Promise<unknown>;
  /** The result of `runSteps`. */
  result: Promise<number>;
}

// Starts `runSteps` on the fixture and waits until the steps are alive and have reported their pid.
async function startLiveSteps(options: RunStepsOptions = {}): Promise<LiveSteps> {
  const dir = mkdtempSync(join(tmpdir(), "check-steps-test-"));
  const script = join(dir, "steps.mjs");
  writeFileSync(script, FIXTURE);
  const recordFile = join(dir, "record.json");
  const record = new Promise<unknown>((resolve) => {
    const watcher = watch(dir, () => {
      try {
        resolve(JSON.parse(readFileSync(recordFile, "utf8")));
        watcher.close();
      } catch {
        // The file is not there yet, or half written: the next event of the folder tries again.
      }
    });
  });
  const server = createServer();
  const connected = new Promise<{ socket: Socket; pid: number }>((resolve) => {
    server.once("connection", (socket) => {
      // The steps exit while the socket is open, which the OS reports as a reset; that is the end of the steps here.
      socket.on("error", () => undefined);
      socket.once("data", (data) => resolve({ socket, pid: Number(String(data).trim()) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no TCP address");
  const result = runSteps(process.execPath, [script, String(address.port), String(STEPS_EXIT_CODE)], {
    ...options,
    recordFile,
  }).finally(() => server.close());
  const { socket, pid } = await connected;
  return { pid, release: () => socket.write("go"), record, result };
}

describe("check steps record", () => {
  it(
    "writes the pid and the start time of the live steps to the record file, and returns their exit code",
    async () => {
      const steps = await startLiveSteps();
      const record = await steps.record;
      expect(record).toEqual({ pid: steps.pid, start: await readStartTime(steps.pid) });
      steps.release();
      expect(await steps.result).toBe(STEPS_EXIT_CODE);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "returns the exit code of the steps and kills nothing when a stop arrives after they exited",
    async () => {
      const controller = new AbortController();
      const kill = vi.fn(() => Promise.resolve());
      // The stop comes at the moment that runSteps reports the exit: the steps are already gone.
      const steps = await startLiveSteps({ stop: controller.signal, kill, onExit: () => controller.abort() });
      await steps.record;
      steps.release();
      expect(await steps.result).toBe(STEPS_EXIT_CODE);
      expect(controller.signal.aborted).toBe(true);
      expect(kill).not.toHaveBeenCalled();
    },
    TEST_TIMEOUT_MS,
  );
});

describe("check orphan steps", () => {
  it(
    "kills a running steps process whose pid and start time match the record, and deletes the record",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "check-orphan-test-"));
      const file = join(dir, "steps.json");
      const fake = idleProcess();
      const pid = fake.pid;
      if (pid === undefined) throw new Error("the fake steps did not start");
      const start = await readStartTime(pid);
      writeFileSync(file, JSON.stringify({ pid, start }));
      const lines: string[] = [];
      await killOrphan(file, (line) => lines.push(line));
      await fake;
      expect(isAlive(pid)).toBe(false);
      expect(lines).toHaveLength(1);
      expect(existsSync(file)).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "spares a process whose start time differs from the record, and deletes the record",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "check-orphan-test-"));
      const file = join(dir, "steps.json");
      const fake = idleProcess();
      const pid = fake.pid;
      if (pid === undefined) throw new Error("the fake steps did not start");
      try {
        writeFileSync(file, JSON.stringify({ pid, start: "1" }));
        const lines: string[] = [];
        await killOrphan(file, (line) => lines.push(line));
        expect(isAlive(pid)).toBe(true);
        expect(lines).toHaveLength(0);
        expect(existsSync(file)).toBe(false);
      } finally {
        fake.kill("SIGKILL");
        await fake;
      }
    },
    TEST_TIMEOUT_MS,
  );
});

describe("the scoped command line, run for real", () => {
  // A small module that few test files import, and not this file (the run would call itself).
  const FILE = "scripts/lib/console-timing.ts";

  it(
    "runs the related-tests step of the command through npm and run-p",
    async () => {
      const scope = scopeOf([{ path: FILE, kind: ChangeKind.Present }], false);
      const args = stepsArgs(scope).filter((a, i) => i < 5 || a.includes("test:related"));
      // Without the markers of this worker, the inner vitest is a run of its own.
      const run = await execa("npm", args, {
        all: true,
        reject: false,
        env: { VITEST: undefined, VITEST_WORKER_ID: undefined, VITEST_POOL_ID: undefined },
      });
      expect(run.exitCode, run.all).toBe(0);
      // The passing step prints 1 line and none of the output of vitest.
      expect(
        run.all
          .trim()
          .split("\n")
          .filter((line) => line.startsWith("pass test:related (")),
      ).toHaveLength(1);
      expect(run.all).not.toMatch(/Test Files/);
    },
    PROCESS_START_TIMEOUT_MS,
  );

  it(
    "with --verbose runs the same step through run-p with its output inherited",
    async () => {
      const scope = scopeOf([{ path: FILE, kind: ChangeKind.Present }], false);
      const args = stepsArgs(scope, true).filter((a, i) => i < 4 || a.startsWith("test:related"));
      const run = await execa("npm", args, {
        all: true,
        reject: false,
        env: { VITEST: undefined, VITEST_WORKER_ID: undefined, VITEST_POOL_ID: undefined },
      });
      expect(run.exitCode, run.all).toBe(0);
      expect(run.all).toMatch(/Test Files\s+[1-9]\d* passed/);
    },
    PROCESS_START_TIMEOUT_MS,
  );
});
