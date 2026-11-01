// The browser test of console.md 13.7 has its own config, `npm run test:ui`, because it launches a browser and needs
// the built client script; `npm run check` runs it beside the unit tests.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["__tests__/console-ui.test.ts"],
    globalSetup: ["__tests__/global-setup.ts"],
    setupFiles: ["__tests__/setup.ts"],
  },
});
