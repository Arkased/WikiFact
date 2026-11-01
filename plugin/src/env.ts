// The one reader of the environment in the plugin (docs/code-standard.md, section 2).

/**
 * Finds the project folder.
 *
 * @returns `$CLAUDE_PROJECT_DIR`, or the current folder when the variable is not set or is empty
 * @sideEffects reads the environment and the current folder
 */
export function projectDir(): string {
  const dir = process.env.CLAUDE_PROJECT_DIR;
  return dir === undefined || dir === "" ? process.cwd() : dir;
}
