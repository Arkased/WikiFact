import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Arm, ArmChoice, BenefitKind } from "../../lib/enums.js";
import {
  WIKI_SERVER,
  WIKI_TOOLS,
  WIKI_TOOL_PREFIX,
  allowedTools,
  armsOf,
  builtinTools,
  mcpConfig,
  promptOf,
  settingsJson,
  writeArmFiles,
} from "../arms.js";

describe("the two arms", () => {
  it("run the arms that --arm names, the arm with first", () => {
    expect(armsOf(ArmChoice.Both)).toEqual([Arm.With, Arm.Without]);
    expect(armsOf(ArmChoice.With)).toEqual([Arm.With]);
    expect(armsOf(ArmChoice.Without)).toEqual([Arm.Without]);
  });

  it("differ in the wiki tools alone", () => {
    for (const kind of Object.values(BenefitKind)) {
      const withTools = allowedTools(Arm.With, kind);
      const withoutTools = allowedTools(Arm.Without, kind);
      expect(withTools).toContain(WIKI_TOOLS);
      expect(withoutTools).not.toContain(WIKI_TOOLS);
      expect(withTools.filter((t) => t !== WIKI_TOOLS)).toEqual(withoutTools);
    }
    // The built-in tools and the settings file do not depend on the arm.
    expect(builtinTools(BenefitKind.Question)).not.toContain("Edit");
    expect(builtinTools(BenefitKind.Task)).toContain("Edit");
  });

  it("start the server of the copy for the arm with and no server for the arm without", () => {
    const withConfig = mcpConfig(Arm.With, "copy.sqlite");
    expect(Object.keys(withConfig.mcpServers)).toEqual([WIKI_SERVER]);
    expect(JSON.stringify(withConfig)).toContain("copy.sqlite");
    expect(mcpConfig(Arm.Without, "copy.sqlite").mcpServers).toEqual({});
  });

  it("run the server from the source, not from the build output", () => {
    const server = Object.values(mcpConfig(Arm.With, "copy.sqlite").mcpServers)[0] as { args: string[] };
    expect(server.args.some((a) => a.endsWith(join("src", "cli.ts")))).toBe(true);
    expect(server.args.some((a) => a.includes(join("dist", "src")))).toBe(false);
  });

  it("give the same prompt: the question, with no word about the wiki", () => {
    const prompt = promptOf("Where is the lock taken?", BenefitKind.Question);
    expect(prompt).toContain("Where is the lock taken?");
    expect(prompt.toLowerCase()).not.toContain("wiki");
    expect(promptOf("Fix the bug.", BenefitKind.Task)).toBe("Fix the bug.");
  });

  it("write a settings file with the file tools allowed, for either arm, and the MCP config outside the worktree", () => {
    const dir = mkdtempSync(join(tmpdir(), "benefit-arms-"));
    for (const arm of Object.values(Arm)) {
      const worktree = join(dir, `wt-${arm}`);
      const { mcpConfigPath } = writeArmFiles({
        worktree,
        runFolder: join(dir, `run-${arm}`),
        arm,
        kind: BenefitKind.Question,
        dbPath: "copy.sqlite",
      });
      expect(JSON.parse(readFileSync(join(worktree, ".claude", "settings.json"), "utf8"))).toEqual(
        settingsJson(BenefitKind.Question),
      );
      expect(mcpConfigPath.startsWith(worktree)).toBe(false);
      expect(JSON.parse(readFileSync(mcpConfigPath, "utf8"))).toEqual(mcpConfig(arm, "copy.sqlite"));
    }
    // The settings file names no wiki tool: the arms differ in --allowedTools and --mcp-config alone.
    expect(settingsJson(BenefitKind.Question).permissions.allow.some((t) => t.startsWith(WIKI_TOOL_PREFIX))).toBe(
      false,
    );
  });
});
