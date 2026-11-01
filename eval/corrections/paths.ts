import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { projectRoot } from "../../src/paths.js";

/** The folder `eval/corrections/`: the data files and the stop hook live in it. */
export const CORRECTIONS_DIR = dirname(fileURLToPath(import.meta.url));

/** The command and arguments that start a process. */
export interface SpawnCommand {
  command: string;
  args: string[];
}

/**
 * The command that starts the MCP server on stdio from the source through tsx, so that no build is needed
 * and a stale `dist/` cannot break a run. The paths are absolute, because a consumer's cwd is a temporary folder.
 *
 * @param dbPath - the database the server opens
 * @returns the command and arguments for a child process or an MCP config
 * @sideEffects none
 */
export function serverSpawnCommand(dbPath: string): SpawnCommand {
  const root = projectRoot();
  return {
    command: "node",
    args: [join(root, "node_modules", "tsx", "dist", "cli.mjs"), join(root, "src", "cli.ts"), "serve", "--db", dbPath],
  };
}

/** The folder of the result files, relative to the working directory (the repo root). */
export const RESULTS_DIR = join("eval", "corrections", "results");
