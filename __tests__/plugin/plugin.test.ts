import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PLUGIN = join(import.meta.dirname, "..", "..", "plugin");

/**
 * Reads a file of the plugin.
 *
 * @param path - the path inside the plugin folder
 * @returns the text
 */
function text(path: string): string {
  return readFileSync(join(PLUGIN, path), "utf8");
}

describe("the files of the wikifact plugin", () => {
  it("plugin.json has a version", () => {
    const manifest = JSON.parse(text(".claude-plugin/plugin.json")) as { version: string };
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
