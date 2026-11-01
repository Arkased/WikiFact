// The Claude Code consumer: `claude -p`, one process per task, in its own temporary directory.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";
import { z } from "zod";
import { EnvVar } from "../../../src/domain/index.js";
import { readEnv, withTempFolder } from "../../../src/env.js";
import { CORRECTIONS_DIR, serverSpawnCommand } from "../paths.js";
import { taskPrompt } from "../prompt.js";
import type { Consumer, ConsumerOut } from "./types.js";
import { JSON_INDENT } from "../../../src/constants.js";

/** The time one `claude -p` process may run before it is killed, in ms. */
const CLAUDE_TASK_TIMEOUT_MS = 5 * 60 * 1000;
/** The most characters of a failed process's output kept in the error text. */
const ERROR_TEXT_CHARS = 500;

/** The fields of `claude -p --output-format json` that the harness reads. */
const claudeResult = z.object({
  result: z.unknown().optional(),
  total_cost_usd: z.number().optional(),
  num_turns: z.number().optional(),
  is_error: z.boolean().optional(),
});

function textOf(value: unknown, fallback: string): string {
  if (value === undefined || value === null) return fallback;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function parseOutput(out: string, err: string, code: number | null): ConsumerOut {
  let json: unknown;
  try {
    json = JSON.parse(out);
  } catch {
    return { answer: "", error: `claude exited ${code}: ${(err || out).slice(0, ERROR_TEXT_CHARS)}` };
  }
  const parsed = claudeResult.safeParse(json);
  if (!parsed.success) {
    return { answer: "", error: `claude exited ${code}: ${(err || out).slice(0, ERROR_TEXT_CHARS)}` };
  }
  const j = parsed.data;
  return {
    answer: textOf(j.result, ""),
    costUsd: j.total_cost_usd,
    turns: j.num_turns,
    error: j.is_error ? textOf(j.result, "error") : undefined,
  };
}

/**
 * Builds the consumer that runs Claude Code headless against the real MCP server on stdio.
 *
 * @param bin - the path of the `claude` binary
 * @returns a consumer for `runCorrections`; the server runs from `src/cli.ts` through tsx, so no build is needed
 * @sideEffects per task: creates a folder with `mcp.json` (and `.claude/settings.json` with the hook) and the temp folder `tmp-<task id>` of the child in the run folder, starts a `claude` child process that starts the server, and the tools write to the seeded database
 */
export function claudeConsumer(bin: string): Consumer {
  return async (task, ctx) => {
    const cwd = join(ctx.runDir, `cwd-${task.id}`);
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    const mcpPath = join(cwd, "mcp.json");
    writeFileSync(
      mcpPath,
      JSON.stringify({ mcpServers: { wikifact: serverSpawnCommand(ctx.seeded.dbPath) } }, null, JSON_INDENT),
    );
    const hookLog = join(cwd, "hook.log");
    const tempDir = join(ctx.runDir, `tmp-${task.id}`);
    mkdirSync(tempDir, { recursive: true });
    if (ctx.hook) {
      const hook = join(CORRECTIONS_DIR, "stop-hook.mjs");
      writeFileSync(
        join(cwd, ".claude", "settings.json"),
        JSON.stringify(
          { hooks: { Stop: [{ hooks: [{ type: "command", command: `node "${hook}"` }] }] } },
          null,
          JSON_INDENT,
        ),
      );
    }
    const args = [
      "-p",
      "--mcp-config",
      mcpPath,
      "--strict-mcp-config",
      "--allowedTools",
      "mcp__wikifact__*",
      "--tools",
      "",
      "--setting-sources",
      "project",
      "--disable-slash-commands",
      "--no-session-persistence",
      "--output-format",
      "json",
      ...(ctx.model ? ["--model", ctx.model] : []),
    ];
    // The prompt goes on stdin, because --mcp-config and --allowedTools take several values.
    const r = await execa(bin, args, {
      cwd,
      // TEMP, TMP and TMPDIR inside the run folder: Claude Code makes its folder for `cwd` there, not in Temp (#75).
      env: withTempFolder({ ...readEnv().raw, [EnvVar.WikifactHookLog]: hookLog }, tempDir),
      extendEnv: false, // the child gets the parsed environment and nothing else
      input: taskPrompt(task),
      timeout: CLAUDE_TASK_TIMEOUT_MS,
      reject: false,
      windowsHide: true,
      stripFinalNewline: false,
    });
    // No exit code: the process did not start. A timeout ends the process with a signal and reads as a failed run.
    if (r.exitCode === undefined && !r.timedOut)
      return { answer: "", error: r.originalMessage ?? r.shortMessage ?? "" };
    return parseOutput(r.stdout, r.stderr, r.exitCode ?? null);
  };
}
