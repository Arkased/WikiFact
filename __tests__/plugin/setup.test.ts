import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONFIG_FILE } from "../../plugin/src/config.js";
import { SetupOutcome } from "../../plugin/src/enums.js";
import {
  addWikiName,
  addWikiPermission,
  SETTINGS_FILE,
  MAX_NAME_LENGTH,
  WIKI_PERMISSION,
  wikiNameOf,
} from "../../plugin/src/setup.js";

/**
 * Makes a project folder, with a settings file when a text is given.
 *
 * @param text - the content of the settings file; undefined makes no file
 * @returns the project folder
 */
function projectWith(text: string | undefined): string {
  const dir = mkdtempSync(join(tmpdir(), "wiki-setup-"));
  if (text !== undefined) {
    mkdirSync(join(dir, ".claude"));
    writeFileSync(join(dir, SETTINGS_FILE), text);
  }
  return dir;
}

/**
 * Reads the settings file of a project.
 *
 * @param dir - the project folder
 * @returns the text of the file
 */
function settingsOf(dir: string): string {
  return readFileSync(join(dir, SETTINGS_FILE), "utf8");
}

describe("addWikiPermission", () => {
  it("makes the file with the permission when there is none", () => {
    const dir = projectWith(undefined);
    expect(addWikiPermission(dir).outcome).toBe(SetupOutcome.Written);
    expect(JSON.parse(settingsOf(dir))).toEqual({ permissions: { allow: [WIKI_PERMISSION] } });
  });

  it("merges: every other key and rule stays", () => {
    const before = { autoMemoryEnabled: false, permissions: { allow: ["Bash(ls)"], deny: ["Bash(rm)"] }, hooks: {} };
    const dir = projectWith(JSON.stringify(before));
    expect(addWikiPermission(dir).outcome).toBe(SetupOutcome.Written);
    expect(JSON.parse(settingsOf(dir))).toEqual({
      ...before,
      permissions: { allow: ["Bash(ls)", WIKI_PERMISSION], deny: ["Bash(rm)"] },
    });
  });

  it("writes nothing on a second run", () => {
    const dir = projectWith(JSON.stringify({ other: 1 }));
    addWikiPermission(dir);
    const first = settingsOf(dir);
    expect(addWikiPermission(dir).outcome).toBe(SetupOutcome.Unchanged);
    expect(settingsOf(dir)).toBe(first);
  });

  it("skips a file that does not parse and leaves it as it is", () => {
    const dir = projectWith("{ not json");
    expect(addWikiPermission(dir).outcome).toBe(SetupOutcome.Skipped);
    expect(settingsOf(dir)).toBe("{ not json");
  });

  it("skips the file when permissions.allow is not a list", () => {
    const text = JSON.stringify({ permissions: { allow: "x" } });
    const dir = projectWith(text);
    expect(addWikiPermission(dir).outcome).toBe(SetupOutcome.Skipped);
    expect(settingsOf(dir)).toBe(text);
  });
});

/**
 * Makes a project folder with a given name, with a config file when a text is given.
 *
 * @param name - the name of the folder
 * @param text - the content of the config file; undefined makes no file
 * @returns the project folder
 */
function namedProject(name: string, text: string | undefined): string {
  const dir = join(mkdtempSync(join(tmpdir(), "wiki-name-")), name);
  mkdirSync(join(dir, ".claude"), { recursive: true });
  if (text !== undefined) writeFileSync(join(dir, CONFIG_FILE), text);
  return dir;
}

describe("wikiNameOf", () => {
  it.each([
    { folder: "WikiFact", name: "wikifact" },
    { folder: "My Project  (2)", name: "my-project-2" },
    { folder: "--x--", name: "x" },
    { folder: "...", name: "wiki" },
    { folder: "a_b.c", name: "a-b-c" },
    { folder: "keep-this-1", name: "keep-this-1" },
  ])("turns the folder $folder into $name", ({ folder, name }) => {
    expect(wikiNameOf(join(tmpdir(), folder))).toBe(name);
  });
});

describe("wikiNameOf length", () => {
  it("keeps a name of the maximum length", () => {
    const folder = "a".repeat(MAX_NAME_LENGTH);
    expect(wikiNameOf(join(tmpdir(), folder))).toBe(folder);
  });

  it("cuts a name over the maximum length", () => {
    expect(wikiNameOf(join(tmpdir(), "a".repeat(MAX_NAME_LENGTH + 1)))).toBe("a".repeat(MAX_NAME_LENGTH));
  });

  it("removes a hyphen that the cut leaves at the end", () => {
    const folder = `${"a".repeat(MAX_NAME_LENGTH - 1)} b`;
    expect(wikiNameOf(join(tmpdir(), folder))).toBe("a".repeat(MAX_NAME_LENGTH - 1));
  });
});

describe("addWikiName", () => {
  it("makes the config file with wiki.name when there is none", () => {
    const dir = namedProject("My App", undefined);
    expect(addWikiName(dir).outcome).toBe(SetupOutcome.Written);
    expect(JSON.parse(readFileSync(join(dir, CONFIG_FILE), "utf8"))).toEqual({ wiki: { name: "my-app" } });
  });

  it("keeps every other key when it adds wiki.name", () => {
    const before = { projectName: "X", backlog: { backend: "local" }, wiki: { other: true } };
    const dir = namedProject("proj", JSON.stringify(before));
    expect(addWikiName(dir).outcome).toBe(SetupOutcome.Written);
    expect(JSON.parse(readFileSync(join(dir, CONFIG_FILE), "utf8"))).toEqual({
      ...before,
      wiki: { other: true, name: "proj" },
    });
  });

  it.each([{ name: "chosen" }, { name: null }])("leaves a file whose wiki.name is $name", ({ name }) => {
    const text = JSON.stringify({ wiki: { name } });
    const dir = namedProject("proj", text);
    expect(addWikiName(dir).outcome).toBe(SetupOutcome.Unchanged);
    expect(readFileSync(join(dir, CONFIG_FILE), "utf8")).toBe(text);
  });

  it("writes nothing on a second run", () => {
    const dir = namedProject("proj", undefined);
    addWikiName(dir);
    const first = readFileSync(join(dir, CONFIG_FILE), "utf8");
    expect(addWikiName(dir).outcome).toBe(SetupOutcome.Unchanged);
    expect(readFileSync(join(dir, CONFIG_FILE), "utf8")).toBe(first);
  });

  it.each(["{ not json", JSON.stringify({ wiki: "x" }), "[]"])("skips the file %s and leaves it as it is", (text) => {
    const dir = namedProject("proj", text);
    expect(addWikiName(dir).outcome).toBe(SetupOutcome.Skipped);
    expect(readFileSync(join(dir, CONFIG_FILE), "utf8")).toBe(text);
  });
});
