// Runs the entry scripts of `plugin/src/` as the hooks run them, with `$CLAUDE_PROJECT_DIR` set to a temp project: no
// config file, `wiki.name` null, and a wiki name. The scripts run through tsx, so these tests need no build.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { CONFIG_FILE } from "../../plugin/src/config.js";
import { ContextEvent, SetupOutcome } from "../../plugin/src/enums.js";
import { SETTINGS_FILE } from "../../plugin/src/setup.js";

const WIKIFACT = join(import.meta.dirname, "..", "..", "plugin", "src");
const CONFIG = { other: 1, wiki: { name: "fixture-wiki" } };
const SPAWN_TIMEOUT_MS = 60_000;

interface Run {
  stdout: string;
  stderr: string;
  status: number | null;
}

/**
 * Makes a project folder, with a config file when a text is given.
 *
 * @param text - the content of the config file; undefined makes no file
 * @returns the project folder
 */
function projectWith(text: string | undefined): string {
  const dir = mkdtempSync(join(tmpdir(), "wiki-entry-"));
  if (text !== undefined) {
    mkdirSync(join(dir, ".claude"));
    writeFileSync(join(dir, CONFIG_FILE), text);
  }
  return dir;
}

/**
 * Runs an entry script with tsx.
 *
 * @param script - the file name in `plugin/src/`
 * @param project - the project folder
 * @param input - the stdin of the script
 * @returns the output and the exit code
 */
function run(script: string, project: string, input: string): Run {
  const file = join(WIKIFACT, script);
  const code = `process.argv = [process.execPath, ${JSON.stringify(file)}]; await import(${JSON.stringify(pathToFileURL(file).href)});`;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
    input,
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: project },
    timeout: SPAWN_TIMEOUT_MS,
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

const CONTEXT_INPUT = JSON.stringify({ hook_event_name: ContextEvent.SessionStart });
const STOP_INPUT = JSON.stringify({ agent_transcript_path: join(tmpdir(), "no-such-transcript.jsonl") });
const SCRIPTS = [
  { script: "wiki-context.ts", input: CONTEXT_INPUT },
  { script: "wiki-submit.ts", input: STOP_INPUT },
];

describe.each(SCRIPTS)("$script", { timeout: SPAWN_TIMEOUT_MS }, ({ script, input }) => {
  it("prints nothing and exits 0 when the project has no config file", () => {
    expect(run(script, projectWith(undefined), input)).toEqual({ stdout: "", stderr: "", status: 0 });
  });

  it("prints nothing and exits 0 when wiki.name is null", () => {
    const config = JSON.stringify({ ...CONFIG, wiki: { name: null } });
    expect(run(script, projectWith(config), input)).toEqual({ stdout: "", stderr: "", status: 0 });
  });

  it("exits 0 and names the file on stderr when the config file does not parse", () => {
    const out = run(script, projectWith("{ not json"), input);
    expect(out.status).toBe(0);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain(CONFIG_FILE);
  });
});

describe.each([
  { case: "does not parse", text: "{ not json" },
  { case: "has a permissions.allow that is not a list", text: JSON.stringify({ permissions: { allow: "x" } }) },
])("setup when settings.json $case", { timeout: SPAWN_TIMEOUT_MS }, ({ text }) => {
  it("prints the skipped outcome with the file, leaves the file and exits 1", () => {
    const dir = mkdtempSync(join(tmpdir(), "wiki-setup-entry-"));
    mkdirSync(join(dir, ".claude"));
    writeFileSync(join(dir, SETTINGS_FILE), text);
    const out = run("setup.ts", dir, "");
    expect(out.stdout).toContain(SETTINGS_FILE);
    expect(out.stdout).toContain(SetupOutcome.Skipped);
    expect(out.status).toBe(1);
    expect(readFileSync(join(dir, SETTINGS_FILE), "utf8")).toBe(text);
  });
});

describe("setup in a project with no file", { timeout: SPAWN_TIMEOUT_MS }, () => {
  it("writes the permission and wiki.name, prints written, then unchanged", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "wiki-setup-new-")), "Fresh Project");
    mkdirSync(dir);
    const first = run("setup.ts", dir, "");
    expect(first.status).toBe(0);
    expect(first.stdout).toContain(`${CONFIG_FILE}: ${SetupOutcome.Written}`);
    expect(JSON.parse(readFileSync(join(dir, CONFIG_FILE), "utf8"))).toEqual({ wiki: { name: "fresh-project" } });
    const second = run("setup.ts", dir, "");
    expect(second.stdout).toContain(`${CONFIG_FILE}: ${SetupOutcome.Unchanged}`);
    expect(second.stdout).toContain(`${SETTINGS_FILE}: ${SetupOutcome.Unchanged}`);
  });
});

describe("wiki-context with a wiki name", { timeout: SPAWN_TIMEOUT_MS }, () => {
  it("prints the context with the name of the wiki", () => {
    const out = run("wiki-context.ts", projectWith(JSON.stringify(CONFIG)), CONTEXT_INPUT);
    expect(out.status).toBe(0);
    const context = (JSON.parse(out.stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput
      .additionalContext;
    expect(context).toContain(CONFIG.wiki.name);
  });
});
