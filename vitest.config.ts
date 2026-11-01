import { defineConfig } from "vitest/config";

export default defineConfig({
  // `.cache/` holds the run folder of the tests (`.cache/test-runs/`): the watch mode must not rerun on its files.
  server: { watch: { ignored: ["**/.cache/**"] } },
  test: {
    include: ["**/__tests__/**/*.test.ts"],
    // The browser test has its own config (vitest.ui.config.ts). `.claude/worktrees/` holds the Claude worktrees, each a
    // full copy of the repo with its own tests.
    exclude: ["**/node_modules/**", "**/dist/**", ".claude/worktrees/**", ".cache/**", "__tests__/console-ui.test.ts"],
    // The run gets a temp folder of its own and deletes it at the end (docs/code-standard.md, section 8).
    // At most half the threads of the PC (docs/code-standard.md#6-tools): 3 agents running a check at once load the machine less.
    maxWorkers: "50%",
    globalSetup: ["__tests__/global-setup.ts"],
    setupFiles: ["__tests__/setup.ts"],
  },
});
