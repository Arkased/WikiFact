import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { TransportName } from "../../src/domain/index.js";
import type { Env } from "../../src/env.js";
import { findClaudeBinary } from "../../src/updates/index.js";

/**
 * Tells whether a real model run can authenticate: an API key or token, the Claude Code CLI, or an Anthropic config folder.
 *
 * @param env - the parsed environment
 * @returns true when at least one credential source is present
 * @sideEffects reads the file system (the `claude` binary, the Anthropic config folder)
 */
export function hasCredentials(env: Env): boolean {
  if (env.apiKey || env.authToken) return true;
  // No key: the questions run through the Claude Code CLI, which needs the binary (and `claude auth login`).
  if (env.transport !== TransportName.Sdk && findClaudeBinary(env)) return true;
  const dir = env.anthropicConfigDir ?? join(homedir(), ".config", "anthropic");
  return existsSync(dir);
}
