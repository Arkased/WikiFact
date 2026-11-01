import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deployPaths } from "../../scripts/lib/deploy-paths.js";
import { FAKE_EMBEDDING_MODEL } from "../../fakes/fake-embedder.js";
import { Mode } from "../../src/domain/index.js";
import { projectRoot } from "../../src/paths.js";
import { closeStore, openStore } from "../../src/store/index.js";
import { PROCESS_START_TIMEOUT_MS } from "../helpers/timeouts.js";

// Runs the bulk test from source with the arguments given.
function bulk(args: string[]): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, ["--import", "tsx", "eval/bulk.ts", ...args], {
    cwd: projectRoot(),
    encoding: "utf8",
    windowsHide: true,
  });
}

// Makes an empty wiki built with the fake embedder (its database and its config), the source that `--stub` accepts.
function emptyStubWiki(dir: string): string {
  const db = join(dir, "game.sqlite");
  writeFileSync(
    join(dir, "wikifact.json"),
    JSON.stringify({ mode: Mode.Local, subject: "x", embeddingModel: FAKE_EMBEDDING_MODEL }),
  );
  closeStore(openStore(db, { embeddingModel: FAKE_EMBEDDING_MODEL }));
  return db;
}

// Lists every file and folder under `dir`, as relative paths, without the `-wal` and `-shm` files that SQLite makes next
// to a WAL database when it is read (documented at `backupDatabase`).
const listing = (dir: string): string[] =>
  readdirSync(dir, { recursive: true })
    .map(String)
    .filter((p) => !/\.sqlite-(wal|shm)$/.test(p))
    .sort();

describe("eval entry points", () => {
  it(
    "eval:bulk exits with a code other than 0 when the source holds fewer queued submissions than --requests",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "wikifact-entry-"));
      const db = emptyStubWiki(dir);
      const r = bulk([
        "--db",
        db,
        "--requests",
        "1",
        "--stub",
        "--work-dir",
        join(dir, "work"),
        "--out",
        join(dir, "r.json"),
      ]);
      expect(r.stderr).toContain("fewer than --requests 1");
      expect(r.status).toBe(1);
    },
    PROCESS_START_TIMEOUT_MS,
  );

  it(
    "eval:bulk with --wiki leaves the folder of the environment as it was and records the environment and the wiki",
    () => {
      // The home folder is one of this test file only (__tests__/setup.ts), and the child inherits it: a fake environment.
      const home = homedir();
      const wikiDir = join(deployPaths(home).wikis, "entry-wiki");
      mkdirSync(wikiDir, { recursive: true });
      emptyStubWiki(wikiDir);
      const before = listing(deployPaths(home).root);
      const run = mkdtempSync(join(tmpdir(), "wikifact-entry-"));
      const out = join(run, "r.json");
      const r = bulk([
        "--wiki",
        "entry-wiki",
        "--requests",
        "1",
        "--stub",
        "--work-dir",
        join(run, "work"),
        "--out",
        out,
      ]);
      expect(r.stderr).toContain("fewer than --requests 1");
      expect(listing(deployPaths(home).root)).toEqual(before);
      expect(JSON.parse(readFileSync(out, "utf8"))).toMatchObject({ env: "local", wiki: "entry-wiki" });
    },
    PROCESS_START_TIMEOUT_MS,
  );
});
