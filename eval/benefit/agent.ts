// The agent of the benefit test: one `claude -p` process per run (technical/evaluation.md, "One agent run").
import { mkdirSync } from "node:fs";
import { execa } from "execa";
import { withTempFolder, type Env } from "../../src/env.js";
import type { Arm } from "../lib/enums.js";
import { parseStream, zeroUsage, type StreamResult } from "./stream.js";
import { MS_PER_SECOND } from "../../src/time.js";

/** The most characters of a failed process's output kept in the error text. */
const ERROR_TEXT_CHARS = 500;

/** Everything one agent run needs. */
export interface AgentJob {
  arm: Arm;
  /** The prompt: the question with its sentence, or the issue. */
  prompt: string;
  /** The checkout the agent works in. */
  cwd: string;
  /** The `--mcp-config` file of the arm. */
  mcpConfigPath: string;
  /** The `--allowedTools` list. */
  allowedTools: string[];
  /** The `--tools` list: the built-in tools the agent sees. */
  builtinTools: string[];
  model: string;
  maxTurns: number;
  timeoutMs: number;
  /** A folder for `CLAUDE_CONFIG_DIR`, so that the user's own memory, skills and agents are not loaded; absent leaves the default. */
  configDir?: string;
  /** The `TEMP`, `TMP` and `TMPDIR` of the child, so that the folder of Claude Code for `cwd` is not made in the Temp folder of the user (#75); under the run folder. */
  tempDir: string;
}

/** Runs one agent job. It never throws for a failed run: the failure is in `error` of the result. */
export type AgentRunner = (job: AgentJob) => Promise<StreamResult>;

/**
 * Builds the agent that runs Claude Code headless in the worktree of a job.
 *
 * @param bin - the path of the `claude` binary
 * @param env - the parsed environment: the child gets `env.raw` and nothing else
 * @returns the runner; the prompt goes on stdin because `--mcp-config` and `--allowedTools` take several values
 * @sideEffects per run: makes `job.tempDir` (and `job.configDir` when given); reads the clock; starts a `claude` child
 *   process, which starts the wiki server of the arm "with" and reads and writes files in `job.cwd`
 */
export function claudeAgent(bin: string, env: Env): AgentRunner {
  return async (job) => {
    if (job.configDir) mkdirSync(job.configDir, { recursive: true });
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--strict-mcp-config",
      "--mcp-config",
      job.mcpConfigPath,
      "--setting-sources",
      "project",
      "--disable-slash-commands",
      "--no-session-persistence",
      "--model",
      job.model,
      "--max-turns",
      String(job.maxTurns),
      "--tools",
      job.builtinTools.join(","),
      "--allowedTools",
      ...job.allowedTools,
    ];
    mkdirSync(job.tempDir, { recursive: true });
    const childEnv = withTempFolder(
      { ...env.raw, ...(job.configDir ? { CLAUDE_CONFIG_DIR: job.configDir } : {}) },
      job.tempDir,
    );
    const startedAt = Date.now();
    const r = await execa(bin, args, {
      cwd: job.cwd,
      env: childEnv,
      extendEnv: false,
      input: job.prompt,
      timeout: job.timeoutMs,
      reject: false,
      windowsHide: true,
      stripFinalNewline: false,
    });
    const wallMs = Date.now() - startedAt;
    if (r.timedOut) {
      const partial = parseStream(r.stdout);
      return { ...partial, error: `timed out after ${Math.round(wallMs / MS_PER_SECOND)} s` };
    }
    if (r.exitCode === undefined) {
      return {
        answer: "",
        costUsd: 0,
        turns: 0,
        usage: zeroUsage(),
        toolCalls: [],
        error: r.shortMessage ?? "the process did not start",
      };
    }
    const parsed = parseStream(r.stdout);
    if (parsed.error !== undefined && r.exitCode !== 0) {
      return {
        ...parsed,
        error: `claude exited ${r.exitCode}: ${(r.stderr !== "" ? r.stderr : parsed.error).slice(0, ERROR_TEXT_CHARS)}`,
      };
    }
    return parsed;
  };
}
