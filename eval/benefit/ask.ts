// One agent run on a question, in a worktree and on a wiki copy that the caller made (technical/evaluation.md, "One agent
// run"): the measured runs and the rounds of the preload make it the same way.
import { join } from "node:path";
import type { Arm } from "../lib/enums.js";
import type { AgentRunner } from "./agent.js";
import {
  allowedTools,
  builtinTools,
  promptOf,
  QUESTION_MAX_TURNS,
  QUESTION_TIMEOUT_MS,
  writeArmFiles,
} from "./arms.js";
import type { QuestionCase } from "./cases.js";
import type { StreamResult } from "./stream.js";

/** What a question run needs besides the case. */
export interface AskInput {
  agent: AgentRunner;
  arm: Arm;
  c: QuestionCase;
  /** The name of the run, for its folders under the run folder. */
  key: string;
  runDir: string;
  model: string;
  /** Give the agent its own empty Claude config folder, so that the user's memory and skills are not loaded. */
  isolateConfig: boolean;
  /** The worktree of the fill commit. */
  worktree: string;
  /** The wiki database that the server of the arm "with" serves. */
  dbPath: string;
}

/**
 * Runs the agent on the question.
 *
 * @param i - the agent, the arm, the case, the folders and the wiki copy
 * @returns what the agent run read from its stream
 * @sideEffects writes the arm files in the worktree and the run folder; starts the agent process
 */
export function askQuestion(i: AskInput): Promise<StreamResult> {
  const { mcpConfigPath } = writeArmFiles({
    worktree: i.worktree,
    runFolder: join(i.runDir, "run", i.key),
    arm: i.arm,
    kind: i.c.kind,
    dbPath: i.dbPath,
  });
  return i.agent({
    arm: i.arm,
    prompt: promptOf(i.c.question, i.c.kind),
    cwd: i.worktree,
    mcpConfigPath,
    allowedTools: allowedTools(i.arm, i.c.kind),
    builtinTools: builtinTools(i.c.kind),
    model: i.model,
    maxTurns: QUESTION_MAX_TURNS,
    timeoutMs: QUESTION_TIMEOUT_MS,
    tempDir: join(i.runDir, "tmp", i.key),
    ...(i.isolateConfig ? { configDir: join(i.runDir, "cfg", i.key) } : {}),
  });
}
