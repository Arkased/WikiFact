// The plugin runs in the session of the consumer, apart from the service (docs/design/publication.md#consumer-plugin):
// plugin/src/ imports nothing from src/, eval/ or scripts/ (the lint rule PLUGIN_ISOLATION), and they import nothing
// from plugin/ (this test).
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");
const IMPORT = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;

// The TypeScript files under a folder of the repo, as paths from the root with forward slashes.
function sourceFiles(folder: string): string[] {
  return readdirSync(join(ROOT, folder), { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts"))
    .map((e) => relative(ROOT, join(e.parentPath, e.name)).replaceAll("\\", "/"))
    .filter((p) => !p.includes("__tests__/"));
}

// The relative imports of a file, resolved to paths from the root.
function localImports(path: string): string[] {
  const text = readFileSync(join(ROOT, path), "utf8");
  return [...text.matchAll(IMPORT)]
    .map((m) => m[1] ?? "")
    .filter((s) => s.startsWith("."))
    .map((s) => relative(ROOT, join(ROOT, path, "..", s)).replaceAll("\\", "/"));
}

describe("the plugin is apart from the service", () => {
  it.each(["src", "eval", "scripts"])("%s/ imports nothing from plugin/", (folder) => {
    for (const file of sourceFiles(folder)) {
      for (const target of localImports(file)) {
        // scripts/ builds the plugin with esbuild and reads no file of it by import.
        expect(target.startsWith("plugin/"), `${file} -> ${target}`).toBe(false);
      }
    }
  });
});
