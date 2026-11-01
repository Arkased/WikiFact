import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { TransportName } from "../domain/enums.js";
import { loadEnvFile, readEnv, withTempFolder } from "../env.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wikifact-env-"));
});

describe("withTempFolder", () => {
  it("sets TEMP, TMP and TMPDIR to the folder and leaves the base unchanged", () => {
    const base = { PATH: "/bin", TEMP: "/real" };
    const env = withTempFolder(base, "/run");
    expect(env).toMatchObject({ PATH: "/bin", TEMP: "/run", TMP: "/run", TMPDIR: "/run" });
    expect(base).toEqual({ PATH: "/bin", TEMP: "/real" });
  });
});

describe("readEnv", () => {
  it("parses every variable once into a typed object", () => {
    const env = readEnv({
      WIKIFACT_TRANSPORT: "cli",
      ANTHROPIC_API_KEY: "k",
      WIKIFACT_CLAUDE_BIN: "/bin/claude",
      WIKIFACT_CLI_BARE: "1",
      WIKIFACT_LOG_CALLS: "0",
      WIKIFACT_PRESETS: "/p.json",
    });
    expect(env).toMatchObject({
      transport: TransportName.Cli,
      apiKey: "k",
      claudeBin: "/bin/claude",
      cliBare: true,
      logCalls: false,
      presetsPath: "/p.json",
    });
  });

  it("treats an absent or empty variable as absent and an unknown transport as none", () => {
    const env = readEnv({ ANTHROPIC_API_KEY: "", WIKIFACT_TRANSPORT: "carrier-pigeon" });
    expect(env.apiKey).toBeUndefined();
    expect(env.transport).toBeUndefined();
    expect(env.cliBare).toBe(false);
  });
});

describe("loadEnvFile", () => {
  // Makes `root`, `wikis` and `wikis/demo` under the temp folder, each with a .env when its entry is given.
  function layout(files: { root?: string; wikis?: string; db?: string }): { root: string; wikis: string; db: string } {
    const root = join(dir, "root");
    const wikis = join(dir, "wikis");
    const dbDir = join(wikis, "demo");
    mkdirSync(dbDir, { recursive: true });
    mkdirSync(root);
    if (files.root !== undefined) writeFileSync(join(root, ".env"), files.root);
    if (files.wikis !== undefined) writeFileSync(join(wikis, ".env"), files.wikis);
    if (files.db !== undefined) writeFileSync(join(dbDir, ".env"), files.db);
    return { root, wikis, db: join(dbDir, "g.sqlite") };
  }

  it("sets absent keys only, returns key names, and reads the database .env alone when it exists", () => {
    const { root, wikis, db } = layout({
      root: "TOK=root\nONLY_ROOT=r\n",
      wikis: "ONLY_WIKIS=w\n",
      db: "TOK=db\nONLY_DB=d\nPRESET=db\n",
    });
    const env: NodeJS.ProcessEnv = { PRESET: "kept" };
    const set = loadEnvFile({ root, wikisDir: wikis, dbPath: db, env });
    expect(env).toEqual({ PRESET: "kept", TOK: "db", ONLY_DB: "d" });
    expect(set.sort()).toEqual(["ONLY_DB", "TOK"]);
  });

  it("looks next to the database, then at the wikis root, then at the project root, and the first file found wins", () => {
    const a = layout({ root: "WHO=root\n", wikis: "WHO=wikis\n" });
    const envA: NodeJS.ProcessEnv = {};
    loadEnvFile({ root: a.root, wikisDir: a.wikis, dbPath: a.db, env: envA });
    expect(envA).toEqual({ WHO: "wikis" });

    rmSync(join(a.wikis, ".env"));
    const envB: NodeJS.ProcessEnv = {};
    loadEnvFile({ root: a.root, wikisDir: a.wikis, dbPath: a.db, env: envB });
    expect(envB).toEqual({ WHO: "root" });

    const envC: NodeJS.ProcessEnv = {};
    loadEnvFile({ root: a.root, wikisDir: a.wikis, env: envC });
    expect(envC).toEqual({ WHO: "root" });
  });

  it("does nothing when no file exists", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(loadEnvFile({ root: dir, dbPath: join(dir, "g.sqlite"), env })).toEqual([]);
    expect(env).toEqual({});
  });
});
