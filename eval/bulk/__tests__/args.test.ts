import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { deployPaths } from "../../../scripts/lib/deploy-paths.js";
import { parseBulkArgs } from "../args.js";

// The home folder is one of this test file only (__tests__/setup.ts), so this is a fake environment.
const home = homedir();
const WIKI = "bulk-args-wiki";
const wikiDir = join(deployPaths(home).wikis, WIKI);
mkdirSync(wikiDir, { recursive: true });
writeFileSync(join(wikiDir, "game.sqlite"), "");

describe("parseBulkArgs", () => {
  it("takes a wiki file of the test data with --db and works next to it by default", () => {
    const a = parseBulkArgs(["--requests", "1", "--db", "x.sqlite"]);
    expect(a.db).toBe("x.sqlite");
    expect(a.workDir).toBe(dirname("x.sqlite"));
    expect(a.wiki).toBeUndefined();
  });

  it("puts the default work folder of --wiki outside the environment, and keeps an explicit --work-dir", () => {
    const a = parseBulkArgs(["--requests", "1", "--wiki", WIKI], { home });
    expect(a.db).toBe(join(wikiDir, "game.sqlite"));
    expect(a.wiki).toEqual({ env: "local", name: WIKI });
    const rel = relative(deployPaths(home).root, a.workDir);
    expect(rel.startsWith("..") || isAbsolute(rel)).toBe(true);
    expect(parseBulkArgs(["--requests", "1", "--wiki", WIKI, "--work-dir", "w"], { home }).workDir).toBe("w");
  });

  it("gives the same default work folder to a resume, so that it finds the kept copies", () => {
    const run = parseBulkArgs(["--requests", "1", "--wiki", WIKI], { home });
    const resume = parseBulkArgs(["--resume", "r.json", "--wiki", WIKI], { home });
    expect(resume.workDir).toBe(run.workDir);
  });

  it("takes --batch-size, --concurrency and --group-cut", () => {
    const a = parseBulkArgs([
      "--requests",
      "1",
      "--db",
      "x.sqlite",
      "--batch-size",
      "4",
      "--concurrency",
      "2",
      "--group-cut",
      "0.3",
    ]);
    expect(a).toMatchObject({ batchSize: 4, concurrency: 2, groupCut: 0.3 });
  });

  it("refuses a group cut that is not a positive number", () => {
    expect(() => parseBulkArgs(["--requests", "1", "--db", "x.sqlite", "--group-cut", "0"])).toThrow(/positive number/);
  });

  it("refuses the removed options", () => {
    for (const flag of ["--arch", "--group-only", "--group-shared-candidate"]) {
      expect(() => parseBulkArgs(["--requests", "1", "--db", "x.sqlite", flag, "groups"])).toThrow();
    }
  });

  it("gives 2 wikis and 2 envs 2 different default work folders", () => {
    const other = "bulk-args-wiki-2";
    mkdirSync(join(deployPaths(home).wikis, other), { recursive: true });
    writeFileSync(join(deployPaths(home).wikis, other, "game.sqlite"), "");
    const file = join(mkdtempSync(join(tmpdir(), "wikifact-envs-")), "envs.json");
    writeFileSync(file, JSON.stringify({ local: { local: true }, staging: { local: true } }));
    const folder = (argv: string[]): string => parseBulkArgs(["--requests", "1", ...argv], { file, home }).workDir;
    const folders = [folder(["--wiki", WIKI]), folder(["--wiki", other]), folder(["--wiki", WIKI, "--env", "staging"])];
    expect(new Set(folders).size).toBe(folders.length);
  });
});
