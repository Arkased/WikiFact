import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { deployPaths } from "../../../scripts/lib/deploy-paths.js";
import { loadEnvironment, resolveWikiDb } from "../envs.js";

// A fake list and a fake home inside the run folder: no test opens a real deployment.
const dir = mkdtempSync(join(tmpdir(), "wikifact-envs-"));
const file = join(dir, "envs.json");
const home = join(dir, "home");
const wikis = deployPaths(home).wikis;
mkdirSync(join(wikis, "w"), { recursive: true });
writeFileSync(join(wikis, "w", "game.sqlite"), "");
writeFileSync(file, JSON.stringify({ local: { local: true }, other: { local: true } }));
const source = { file, home };

describe("loadEnvironment", () => {
  it("finds local from the deployment code and the home folder it is given", () => {
    expect(loadEnvironment(undefined, source)).toEqual({ name: "local", wikis });
  });

  it("finds another environment of the list by its name", () => {
    expect(loadEnvironment("other", source)).toEqual({ name: "other", wikis });
  });

  it("names the known environments when the name is not in the list", () => {
    expect(() => loadEnvironment("nope", source)).toThrow(/nope.*local, other/);
  });

  it("does not find a name that only the prototype of the list holds", () => {
    expect(() => loadEnvironment("constructor", source)).toThrow(/not in the list/);
    expect(() => loadEnvironment("__proto__", source)).toThrow(/not in the list/);
  });

  it("is a list in which the committed file holds local", () => {
    expect(loadEnvironment("local", { home }).name).toBe("local");
  });
});

describe("resolveWikiDb", () => {
  it("returns the game file of a wiki of the environment", () => {
    expect(resolveWikiDb({ env: "other", wiki: "w" }, source)).toBe(join(wikis, "w", "game.sqlite"));
  });

  it("returns the --db file as given, and nothing when neither is given", () => {
    expect(resolveWikiDb({ db: "x.sqlite" }, source)).toBe("x.sqlite");
    expect(resolveWikiDb({}, source)).toBeUndefined();
  });

  it("refuses an unknown environment, a wiki that the environment does not hold, --wiki with --db, and --env alone", () => {
    expect(() => resolveWikiDb({ env: "no-such-env", wiki: "w" }, source)).toThrow(/no-such-env/);
    expect(() => resolveWikiDb({ env: "other", wiki: "missing" }, source)).toThrow(
      /not a wiki of the environment other/,
    );
    expect(() => resolveWikiDb({ wiki: "w", db: "x" }, source)).toThrow(/exclude/);
    expect(() => resolveWikiDb({ env: "other" }, source)).toThrow(/--env needs --wiki/);
  });

  it("refuses a wiki name that is not a plain folder name", () => {
    for (const wiki of ["..", ".", "", "../w", "a/w", "a\\w", "C:w"]) {
      expect(() => resolveWikiDb({ wiki }, source)).toThrow(/not a plain folder name/);
    }
  });

  it("looks for the local wiki under the home folder of the test run, not the real one", () => {
    // The home folder of a test file is a folder in the run folder (__tests__/setup.ts).
    expect(relative(tmpdir(), homedir()).startsWith("..")).toBe(false);
    expect(() => resolveWikiDb({ wiki: "demo" })).toThrow(/not a wiki of the environment local/);
  });
});
