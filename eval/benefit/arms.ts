// The two arms of the benefit test (technical/evaluation.md, "The benefit test", Inputs): the files and the tool lists
// that a run gets. The arms differ in the wiki tools alone.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Arm, ArmChoice, BenefitKind } from "../lib/enums.js";
import { serverSpawnCommand } from "../corrections/paths.js";
import { JSON_INDENT } from "../../src/constants.js";

/** The name of the wiki server in the MCP config; the tools of the arm "with" are `mcp__wikifact__*`. */
export const WIKI_SERVER = "wikifact";
/** The prefix of the tool names of the wiki server in Claude Code. */
export const WIKI_TOOL_PREFIX = `mcp__${WIKI_SERVER}__`;
/** The allowed-tools pattern that lets the agent call every tool of the wiki server. */
export const WIKI_TOOLS = `${WIKI_TOOL_PREFIX}*`;
/** The sentence that ends the prompt of a question. */
const QUESTION_SUFFIX = "Answer in 3 sentences at most.";
/** The most turns of a question run. */
export const QUESTION_MAX_TURNS = 12;
/** The most turns of a task run. */
export const TASK_MAX_TURNS = 40;
/** The time limit of a question run, in ms (5 minutes). */
export const QUESTION_TIMEOUT_MS = 5 * 60 * 1000;
/** The time limit of a task run, in ms (20 minutes). */
export const TASK_TIMEOUT_MS = 20 * 60 * 1000;

/** The file tools that every run has. */
export const FILE_TOOLS: readonly string[] = ["Read", "Grep", "Glob"];
/** The tools that a task run adds: it edits files and runs the type check and the tests. */
const TASK_TOOLS = ["Edit", "Write", "Bash(npm run typecheck)", "Bash(npx vitest run *)"];

/**
 * The arms that a `--arm` choice runs.
 *
 * @param choice - the value of `--arm`
 * @returns the arms, "with" first
 * @sideEffects none
 */
export function armsOf(choice: ArmChoice): Arm[] {
  switch (choice) {
    case ArmChoice.With:
      return [Arm.With];
    case ArmChoice.Without:
      return [Arm.Without];
    case ArmChoice.Both:
      return [Arm.With, Arm.Without];
  }
}

/**
 * The tools that a run may use without a prompt: the file tools, and for a task the edit tools and the two commands.
 * The arm "with" adds the wiki server's tools; nothing else differs.
 *
 * @param arm - the arm
 * @param kind - question or task
 * @returns the `--allowedTools` list
 * @sideEffects none
 */
export function allowedTools(arm: Arm, kind: BenefitKind): string[] {
  const own = kind === BenefitKind.Task ? [...FILE_TOOLS, ...TASK_TOOLS] : FILE_TOOLS;
  return arm === Arm.With ? [...own, WIKI_TOOLS] : [...own];
}

/**
 * The built-in tools that a run sees (`--tools`): the same list in both arms.
 *
 * @param kind - question or task
 * @returns the tool names, without the permission patterns
 * @sideEffects none
 */
export function builtinTools(kind: BenefitKind): string[] {
  return kind === BenefitKind.Task ? [...FILE_TOOLS, "Edit", "Write", "Bash"] : [...FILE_TOOLS];
}

/**
 * The content of the `.claude/settings.json` in the worktree: the permissions of the tools that both arms have, and
 * nothing else. A `CLAUDE.md` is not written, and the one of the repo stays as it is at the commit.
 *
 * @param kind - question or task
 * @returns the object to write as JSON
 * @sideEffects none
 */
export function settingsJson(kind: BenefitKind): { permissions: { allow: string[] } } {
  return { permissions: { allow: kind === BenefitKind.Task ? [...FILE_TOOLS, ...TASK_TOOLS] : [...FILE_TOOLS] } };
}

/**
 * The content of the `--mcp-config` file: the server of the copy on stdio for the arm "with", no server for the arm
 * "without".
 *
 * @param arm - the arm
 * @param dbPath - the database the server of the arm "with" opens; unused by the arm "without"
 * @returns the object to write as JSON
 * @sideEffects none
 */
export function mcpConfig(arm: Arm, dbPath: string): { mcpServers: Record<string, unknown> } {
  return { mcpServers: arm === Arm.With ? { [WIKI_SERVER]: serverSpawnCommand(dbPath) } : {} };
}

/**
 * The prompt of a case: the question and the sentence that limits its length, or the text of the issue. It holds no
 * word about the wiki.
 *
 * @param text - the question or the issue
 * @param kind - question or task
 * @returns the prompt
 * @sideEffects none
 */
export function promptOf(text: string, kind: BenefitKind): string {
  return kind === BenefitKind.Question ? `${text}\n\n${QUESTION_SUFFIX}` : text;
}

/** The files that `writeArmFiles` made. */
export interface ArmFiles {
  /** The path of the `--mcp-config` file. */
  mcpConfigPath: string;
}

/** What `writeArmFiles` needs. */
export interface ArmFilesInput {
  /** The checkout the agent works in. */
  worktree: string;
  /** A folder outside the worktree for the MCP config. */
  runFolder: string;
  arm: Arm;
  kind: BenefitKind;
  /** The database for the arm "with". */
  dbPath: string;
}

/**
 * Writes the files of an arm: `.claude/settings.json` in the worktree and the MCP config in the run folder.
 *
 * @param input - the worktree, the run folder, the arm, the kind and the database
 * @returns the path of the MCP config
 * @sideEffects creates `<worktree>/.claude/settings.json` and `<runFolder>/mcp.json`
 */
export function writeArmFiles(input: ArmFilesInput): ArmFiles {
  const { worktree, runFolder, arm, kind, dbPath } = input;
  mkdirSync(join(worktree, ".claude"), { recursive: true });
  writeFileSync(join(worktree, ".claude", "settings.json"), JSON.stringify(settingsJson(kind), null, JSON_INDENT));
  mkdirSync(runFolder, { recursive: true });
  const mcpConfigPath = join(runFolder, "mcp.json");
  writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig(arm, dbPath), null, JSON_INDENT));
  return { mcpConfigPath };
}
