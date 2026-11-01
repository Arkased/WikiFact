import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig, parseConfig } from "../../src/config/index.js";
import { LogEvent, Mode, WorkerChildState } from "../../src/domain/enums.js";
import { DEFAULT_HOST, hostRefusal } from "../../src/mcp/host.js";
import { startWorkerChild, workerCommand, type WorkerCommand } from "../../src/mcp/worker-child.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wikifact-local-"));
});
describe("mode key", () => {
  it("defaults to deployed and accepts local", () => {
    expect(parseConfig({}).mode).toBe(Mode.Deployed);
    expect(parseConfig({ mode: Mode.Local }).mode).toBe(Mode.Local);
  });
  it("rejects another value", () => {
    expect(() => parseConfig({ mode: "shared" })).toThrow();
  });
  it("loads from wikifact.json", () => {
    writeFileSync(join(dir, "wikifact.json"), JSON.stringify({ mode: "local" }));
    expect(loadConfig(join(dir, "g.sqlite")).mode).toBe(Mode.Local);
  });
});

describe("--host in local mode", () => {
  it("accepts the loopback", () => {
    expect(hostRefusal(Mode.Local, "127.0.0.1")).toBeUndefined();
    expect(hostRefusal(Mode.Local, "localhost")).toBeUndefined();
    expect(hostRefusal(Mode.Local, DEFAULT_HOST)).toBeUndefined();
  });

  it("lets a deployed wiki bind any host", () => {
    expect(hostRefusal(Mode.Deployed, "0.0.0.0")).toBeUndefined();
    expect(hostRefusal(Mode.Local, "192.168.1.5")).toBeDefined();
  });
});

describe("worker child", () => {
  const script = (body: string): WorkerCommand => {
    const p = join(dir, "fake-worker.mjs");
    writeFileSync(p, body);
    return { file: process.execPath, args: [p, "--db", "x.sqlite"] };
  };

  it("builds the default command from the binary", () => {
    const d = workerCommand("x.sqlite");
    expect(d.file).toBe(process.execPath);
    expect(d.args.slice(1)).toEqual(["worker", "--db", "x.sqlite"]);
  });

  it("starts the child and stops it", async () => {
    const command = script("setInterval(() => {}, 1000);");
    const logs: Record<string, unknown>[] = [];
    const w = startWorkerChild({ db: "x.sqlite", log: (l) => logs.push(l), command, windowMs: 400 });
    expect(await w.started).toBe(WorkerChildState.Running);
    expect(w.child.exitCode).toBeNull();
    expect(logs[0]).toMatchObject({ event: LogEvent.WorkerChild, state: WorkerChildState.Running });
    const exited = new Promise((r) => w.child.once("exit", r));
    w.stop();
    await exited;
    expect(w.child.killed || w.child.exitCode !== null || w.child.signalCode !== null).toBe(true);
    expect(logs.at(-1)).toMatchObject({ event: LogEvent.WorkerChild, state: WorkerChildState.Exited });
  });

  it("logs and carries on when the child exits at once", async () => {
    const command = script("console.error('lock held'); process.exit(1);");
    const logs: Record<string, unknown>[] = [];
    const w = startWorkerChild({ db: "x.sqlite", log: (l) => logs.push(l), command, windowMs: 5000 });
    expect(await w.started).toBe(WorkerChildState.Exited);
    expect(logs[0]).toMatchObject({ event: LogEvent.WorkerChild, state: WorkerChildState.NotRunning, code: 1 });
    expect(String(logs[0].reason)).toMatch(/lock/);
    w.stop();
  });
});
