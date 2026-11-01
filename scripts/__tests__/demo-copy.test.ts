import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { copyDemoWiki, requireBuilt } from "../lib/demo-copy.js";

const roots: string[] = [];

// A project root with the tracked demo wiki.
function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "demo-copy-"));
  roots.push(root);
  mkdirSync(join(root, "demo", "wikifact"), { recursive: true });
  writeFileSync(join(root, "demo", "wikifact", "game.sqlite"), "demo store");
  writeFileSync(join(root, "demo", "wikifact", "wikifact.json"), '{"mode":"deployed"}');
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("requireBuilt", () => {
  it("throws 'run npm run build first' when the CLI file is missing", () => {
    const root = makeRoot();

    expect(() => requireBuilt(join(root, "dist", "src", "cli.js"))).toThrow("run npm run build first");
  });

  it("passes when the CLI file exists", () => {
    const root = makeRoot();
    mkdirSync(join(root, "dist", "src"), { recursive: true });
    writeFileSync(join(root, "dist", "src", "cli.js"), "");

    expect(() => requireBuilt(join(root, "dist", "src", "cli.js"))).not.toThrow();
  });
});

describe("copyDemoWiki", () => {
  it("copies the store and the config to wikis/wikifact when no store is there", () => {
    const root = makeRoot();

    expect(copyDemoWiki(root)).toBe(true);

    expect(readFileSync(join(root, "wikis", "wikifact", "game.sqlite"), "utf8")).toBe("demo store");
    expect(readFileSync(join(root, "wikis", "wikifact", "wikifact.json"), "utf8")).toBe('{"mode":"deployed"}');
    expect(readFileSync(join(root, "demo", "wikifact", "game.sqlite"), "utf8")).toBe("demo store");
  });

  it("keeps an existing store and its config", () => {
    const root = makeRoot();
    mkdirSync(join(root, "wikis", "wikifact"), { recursive: true });
    writeFileSync(join(root, "wikis", "wikifact", "game.sqlite"), "searched store");

    expect(copyDemoWiki(root)).toBe(false);

    expect(readFileSync(join(root, "wikis", "wikifact", "game.sqlite"), "utf8")).toBe("searched store");
    expect(existsSync(join(root, "wikis", "wikifact", "wikifact.json"))).toBe(false);
  });
});
