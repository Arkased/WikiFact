import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CallerKind, LogEvent, Mode, TransportName } from "../../src/domain/enums.js";
import { readEnv } from "../../src/env.js";
import { commands } from "../../src/updates/commands.js";
import { selectTransport, TransportError } from "../../src/updates/questions/index.js";

const bin = process.execPath;
function must<T>(x: T | undefined | null): T {
  if (x === undefined || x === null) throw new Error("expected a value");
  return x;
}

const saved = { ...process.env };
beforeEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.WIKIFACT_TRANSPORT;
  process.env.WIKIFACT_CLAUDE_BIN = bin;
});
afterEach(() => {
  process.env = { ...saved };
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe('selectTransport for a worker, by mode (technical/deployment.md, "Local mode")', () => {
  it("local mode follows the eval rule: a key means the sdk, else the cli", () => {
    const cli = selectTransport(CallerKind.Worker, readEnv({ WIKIFACT_CLAUDE_BIN: bin }), { mode: Mode.Local });
    expect(cli.name).toBe(TransportName.Cli);
    expect(
      selectTransport(CallerKind.Worker, readEnv({ ANTHROPIC_API_KEY: "k", WIKIFACT_CLAUDE_BIN: bin }), {
        mode: Mode.Local,
      }).name,
    ).toBe(TransportName.Sdk);
    expect(selectTransport(CallerKind.Worker, readEnv({ WIKIFACT_TRANSPORT: "sdk" }), { mode: Mode.Local }).name).toBe(
      TransportName.Sdk,
    );
  });

  it("local mode with no binary and no key is still an error", () => {
    expect(() =>
      selectTransport(CallerKind.Worker, readEnv({ PATH: "", HOME: "/nonexistent", USERPROFILE: "/nonexistent" }), {
        mode: Mode.Local,
      }),
    ).toThrow(TransportError);
  });
});

describe("the worker command logs its mode first", () => {
  function setup(mode: Mode) {
    const dir = mkdtempSync(join(tmpdir(), "wkr-"));
    writeFileSync(join(dir, "wikifact.json"), JSON.stringify({ mode }));
    return join(dir, "game.sqlite");
  }
  const cmd = () => must(commands.find((c) => c.name === "worker"));
  function capture() {
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((s: unknown) => void lines.push(String(s)));
    // The log lines go to stderr through `stderrLogger`; capture them in order with the console messages.
    vi.spyOn(process.stderr, "write").mockImplementation((s: unknown) => {
      lines.push(String(s).trimEnd());
      return true;
    });
    return lines;
  }

  it("deployed mode without a key: one worker line without a condition, then the message, exit code 1", async () => {
    const lines = capture();
    await cmd().run({ db: setup(Mode.Deployed), rest: [] });
    const first: unknown = JSON.parse(lines[0]);
    expect(first).toMatchObject({ event: LogEvent.Worker, mode: Mode.Deployed, transport: "none" });
    expect(first).not.toHaveProperty("condition");
    expect(lines[1]).toContain("ANTHROPIC_API_KEY");
    expect(process.exitCode).toBe(1);
  });

  it("deployed mode with a key: the sdk, no condition", async () => {
    process.env.ANTHROPIC_API_KEY = "k";
    const lines = capture();
    const db = setup(Mode.Deployed);
    const p = cmd().run({ db, rest: [] });
    await vi.waitFor(() => expect(existsSync(`${db}.lock`)).toBe(true)); // the worker is running
    process.emit("SIGINT");
    await p;
    const first: unknown = JSON.parse(lines[0]);
    expect(first).toMatchObject({
      event: LogEvent.Worker,
      mode: Mode.Deployed,
      transport: TransportName.Sdk,
    });
    expect(first).not.toHaveProperty("condition");
  });

  it("local mode without a key: the cli, with the condition, and the worker keeps running", async () => {
    const lines = capture();
    const db = setup(Mode.Local);
    const p = cmd().run({ db, rest: [] });
    await vi.waitFor(() => expect(existsSync(`${db}.lock`)).toBe(true)); // the worker is running
    process.emit("SIGINT");
    await p;
    const first: unknown = JSON.parse(lines[0]);
    expect(first).toMatchObject({
      event: LogEvent.Worker,
      mode: Mode.Local,
      transport: TransportName.Cli,
      condition: expect.any(String) as string,
    });
    expect(process.exitCode).toBeUndefined();
  });
});
