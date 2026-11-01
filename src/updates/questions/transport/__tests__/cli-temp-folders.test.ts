// The temp folders of one CLI call (docs/technical/deployment.md#cli-transport-temp-folders): both are deleted when the
// call ends, also when it fails. The fake CLI logs its working folder and its config folder, so each test checks only
// the folders of its own call.
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CallerKind, Effort, LogEvent, MessageRole, QuestionKind } from "../../../../domain/enums.js";
import type { LogLine } from "../../../../log/index.js";
import { readEnv } from "../../../../env.js";
import { CliTransport } from "../cli.js";
import { selectTransport } from "../select.js";
import type { CallRequest } from "../types.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rm: vi.fn(actual.rm) };
});

const fake = join(import.meta.dirname, "..", "..", "..", "..", "..", "__tests__", "helpers", "fake-claude.mjs");
const request: CallRequest = {
  model: "claude-sonnet-5-5",
  kind: QuestionKind.Judgment,
  effort: Effort.High,
  system: "SYSTEM",
  messages: [{ role: MessageRole.User, content: "MATERIAL" }],
  schema: { type: "object" },
  maxTokens: 16000,
  stream: true,
  thinking: true,
  fallback: true,
};
const success = {
  out: {
    type: "result",
    subtype: "success",
    is_error: false,
    structured_output: { ok: true },
    usage: { input_tokens: 1, output_tokens: 1 },
  },
};

interface Call {
  transport: CliTransport;
  lines: LogLine[];
  /** The 2 folders that the fake CLI saw: its working folder and its config folder. */
  folders: () => string[];
  /** The `TEMP`, `TMP` and `TMPDIR` that the fake CLI saw, and its config folder. */
  seen: () => { configDir: string; tempVars: Record<string, string> };
}

function call(script: unknown[]): Call {
  const log = join(mkdtempSync(join(tmpdir(), "fakeclaude-")), "calls.jsonl");
  const lines: LogLine[] = [];
  const transport = new CliTransport({
    claudeBin: process.execPath,
    prefixArgs: [fake],
    childEnv: { ...process.env, FAKE_LOG: log, FAKE_SCRIPT: JSON.stringify(script) },
    log: (line) => lines.push(line),
  });
  const folders = (): string[] => {
    const seen = JSON.parse(readFileSync(log, "utf8").trim()) as { cwd: string; configDir: string };
    return [seen.cwd, seen.configDir];
  };
  const seen = () => JSON.parse(readFileSync(log, "utf8").trim()) as ReturnType<Call["seen"]>;
  return { transport, lines, folders, seen };
}

describe("CLI transport temp folders", () => {
  it("gives the child TEMP, TMP and TMPDIR inside its config folder, not the Temp folder of the caller", async () => {
    const c = call([success]);
    await c.transport.send(request, new AbortController().signal);
    const { configDir, tempVars } = c.seen();
    expect(new Set(Object.values(tempVars)).size).toBe(1);
    const [tempDir] = Object.values(tempVars);
    expect(tempDir).not.toBe(process.env.TEMP);
    expect(relative(configDir, tempDir).startsWith("..")).toBe(false);
  });

  it("deletes both folders after a successful call", async () => {
    const c = call([success]);
    await c.transport.send(request, new AbortController().signal);
    expect(c.folders().map((f) => existsSync(f))).toEqual([false, false]);
  });

  it("deletes both folders after a call whose CLI fails", async () => {
    const c = call([{ exit: 1 }]);
    await expect(c.transport.send(request, new AbortController().signal)).rejects.toThrow();
    expect(c.folders().map((f) => existsSync(f))).toEqual([false, false]);
  });

  it("logs the path and the error of a folder that cannot be deleted, and returns the answer", async () => {
    vi.mocked(rm).mockRejectedValueOnce(new Error("EBUSY: locked"));
    const c = call([success]);
    await expect(c.transport.send(request, new AbortController().signal)).resolves.toMatchObject({
      text: '{"ok":true}',
    });
    const [cwd] = c.folders();
    expect(c.lines).toHaveLength(1);
    expect(c.lines[0]).toMatchObject({
      event: LogEvent.TempFolderNotDeleted,
      dir: cwd,
      error: "EBUSY: locked",
    });
  });

  it("logs through the logger given to selectTransport", async () => {
    vi.mocked(rm).mockRejectedValueOnce(new Error("EBUSY: locked"));
    const lines: LogLine[] = [];
    // `node` rejects the CLI options of the transport (`--system-prompt-file`: "bad option", exit 9): the call fails.
    const env = readEnv({ WIKIFACT_CLAUDE_BIN: process.execPath });
    const { transport } = selectTransport(CallerKind.Eval, env, { log: (line) => lines.push(line) });
    await expect(transport.send(request, new AbortController().signal)).rejects.toThrow();
    expect(lines.map((l) => l.event)).toEqual([LogEvent.TempFolderNotDeleted]);
  });
});
