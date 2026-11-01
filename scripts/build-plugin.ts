// `npm run build` calls this after the TypeScript build: bundles `plugin/src/` into `plugin/dist/`.
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "../eval/lib/main.js";
import { buildPlugin, PLUGIN_ENTRIES } from "./lib/plugin-build.js";

// The repo root from the place of this file, so that the build does not depend on the working directory.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

if (isMain(import.meta.url)) {
  await buildPlugin(ROOT, join(ROOT, "plugin", "dist"));
  console.log(`plugin: built ${PLUGIN_ENTRIES.length} files`);
}
