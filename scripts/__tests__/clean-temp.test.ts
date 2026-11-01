import { existsSync, mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
  cleanLeftovers,
  cleanTemp,
  DEFAULT_MIN_AGE_MS,
  RUN_FOLDER_PREFIX,
  TEMP_PREFIXES,
  testRunsRoot,
} from "../clean-temp.js";
import { LeftoverGroup } from "../../eval/lib/enums.js";

const NOW = Date.parse("2026-01-01T12:00:00Z");
const OLD = NOW - DEFAULT_MIN_AGE_MS - 1;
const YOUNG = NOW - DEFAULT_MIN_AGE_MS + 1;

const makeRoot = (): string => mkdtempSync(join(tmpdir(), "clean-temp-test-"));

function folder(root: string, name: string, mtimeMs: number): string {
  const path = join(root, name);
  mkdirSync(join(path, "sub"), { recursive: true });
  writeFileSync(join(path, "sub", "f.txt"), "x");
  utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
  return path;
}

const run = (root: string, extra: { dryRun?: boolean; prefixes?: readonly string[] } = {}) =>
  cleanTemp({
    root,
    now: NOW,
    minAgeMs: DEFAULT_MIN_AGE_MS,
    dryRun: extra.dryRun ?? false,
    prefixes: extra.prefixes ?? ["pool-"],
  });

describe("cleanTemp", () => {
  it("deletes an old folder with a prefix and 6 random characters, with its content", () => {
    const root = makeRoot();
    const path = folder(root, "pool-aB3dE9", OLD);
    const counts = run(root);
    expect(existsSync(path)).toBe(false);
    expect(counts.get("pool-")).toEqual({ found: 1, deleted: 1, failed: 0 });
  });

  it("keeps a folder that is not older than the age limit", () => {
    const root = makeRoot();
    const path = folder(root, "pool-aB3dE9", YOUNG);
    const counts = run(root);
    expect(existsSync(path)).toBe(true);
    expect(counts.size).toBe(0);
  });

  it("only counts in a dry run", () => {
    const root = makeRoot();
    const path = folder(root, "pool-aB3dE9", OLD);
    const counts = run(root, { dryRun: true });
    expect(existsSync(path)).toBe(true);
    expect(counts.get("pool-")).toEqual({ found: 1, deleted: 0, failed: 0 });
  });

  it("does not match the folders of a longer prefix with a shorter one", () => {
    const root = makeRoot();
    const longer = folder(root, "rebuild-log-aB3dE9", OLD);
    const own = folder(root, "rebuild-aB3dE9", OLD);
    const counts = run(root, { prefixes: ["rebuild-"] });
    expect(existsSync(own)).toBe(false);
    expect(existsSync(longer)).toBe(true);
    expect(counts.get("rebuild-")).toEqual({ found: 1, deleted: 1, failed: 0 });
  });

  it("counts each of two prefixes where one starts the other", () => {
    const root = makeRoot();
    folder(root, "rebuild-log-aB3dE9", OLD);
    folder(root, "rebuild-aB3dE9", OLD);
    const counts = run(root, { prefixes: ["rebuild-", "rebuild-log-"] });
    expect(counts.get("rebuild-")?.deleted).toBe(1);
    expect(counts.get("rebuild-log-")?.deleted).toBe(1);
  });

  it("keeps folders whose name does not match, by length, case or characters", () => {
    const root = makeRoot();
    const names = ["pool-aB3dE", "pool-aB3dE9x", "Pool-aB3dE9", "pool-aB3d-9", "other-aB3dE9", "xpool-aB3dE9"];
    const paths = names.map((n) => folder(root, n, OLD));
    const counts = run(root);
    expect(paths.every((p) => existsSync(p))).toBe(true);
    expect(counts.size).toBe(0);
  });

  it("keeps a file whose name matches", () => {
    const root = makeRoot();
    const file = join(root, "pool-aB3dE9");
    writeFileSync(file, "x");
    utimesSync(file, OLD / 1000, OLD / 1000);
    const counts = run(root);
    expect(existsSync(file)).toBe(true);
    expect(counts.size).toBe(0);
  });

  it("does not follow a link out of the root", () => {
    const root = makeRoot();
    const outside = folder(makeRoot(), "keep", OLD);
    try {
      symlinkSync(outside, join(root, "pool-aB3dE9"), "junction");
    } catch {
      return;
    }
    run(root);
    expect(existsSync(join(outside, "sub", "f.txt"))).toBe(true);
  });
});

describe("the test run folder", () => {
  it("is where this run's temp folder lives, under .cache/test-runs in the repo, with the run prefix", () => {
    const rel = relative(testRunsRoot(), tmpdir());
    expect(rel.startsWith("..") || isAbsolute(rel)).toBe(false);
    expect(rel.split(/[\\/]/)[0]).toMatch(new RegExp(`^${RUN_FOLDER_PREFIX}`));
  });
});

describe("cleanLeftovers", () => {
  const VITEST_NAME = "7V6RAeMvx6Yr7TXx3bH1G";
  const CLAUDE_NAME = "C--Users-dev-AppData-Local-Temp-wikifact-cli-AbC123";
  const clean = (temp: string, dryRun = false) => cleanLeftovers({ temp, now: NOW, dryRun });

  function fakeTemp(mtimeMs: number): { temp: string; paths: Record<string, string> } {
    const temp = makeRoot();
    const paths = {
      prefix: folder(temp, "pool-aB3dE9", mtimeMs),
      profile: folder(temp, "playwright_chromiumdev_profile-0A3X1u", mtimeMs),
      vitest: join(temp, VITEST_NAME),
      anything: folder(temp, "wikifact-anything-aB3dE9", mtimeMs),
      other: folder(temp, "someone-elses-folder", OLD),
      claude: folder(join(temp, "claude"), CLAUDE_NAME, mtimeMs),
      claudeOther: folder(join(temp, "claude"), "C--Users-dev-Documents-Projects-WikiFact", OLD),
    };
    mkdirSync(join(temp, VITEST_NAME, "client"), { recursive: true });
    mkdirSync(join(temp, VITEST_NAME, "ssr"), { recursive: true });
    utimesSync(paths.vitest, mtimeMs / 1000, mtimeMs / 1000);
    return { temp, paths };
  }

  it("deletes the old folders of every group and keeps the others", () => {
    const { temp, paths } = fakeTemp(OLD);
    const counts = clean(temp);
    expect(existsSync(paths.prefix)).toBe(false);
    expect(existsSync(paths.anything)).toBe(false);
    expect(existsSync(paths.profile)).toBe(false);
    expect(existsSync(paths.vitest)).toBe(false);
    expect(existsSync(paths.claude)).toBe(false);
    expect(existsSync(paths.other)).toBe(true);
    expect(existsSync(paths.claudeOther)).toBe(true);
    const groups = [
      LeftoverGroup.Prefixes,
      LeftoverGroup.PlaywrightProfiles,
      LeftoverGroup.VitestFolders,
      LeftoverGroup.ClaudeFolders,
    ];
    for (const group of groups) {
      const expected =
        group === LeftoverGroup.Prefixes ? { found: 2, deleted: 2, failed: 0 } : { found: 1, deleted: 1, failed: 0 };
      expect(counts.get(group)).toEqual(expected);
    }
  });

  it("keeps a folder of every group that is not older than the age limit", () => {
    const { temp, paths } = fakeTemp(YOUNG);
    clean(temp);
    for (const path of [paths.prefix, paths.anything, paths.profile, paths.vitest, paths.claude]) {
      expect(existsSync(path)).toBe(true);
    }
  });

  it("keeps a 21-character folder that holds anything but client and ssr", () => {
    const temp = makeRoot();
    const path = folder(temp, VITEST_NAME, OLD);
    clean(temp);
    expect(existsSync(path)).toBe(true);
  });

  it("only counts in a dry run, and copes with a Temp folder with no claude folder", () => {
    const temp = makeRoot();
    const path = join(temp, VITEST_NAME);
    mkdirSync(join(path, "ssr"), { recursive: true });
    utimesSync(path, OLD / 1000, OLD / 1000);
    const counts = clean(temp, true);
    expect(existsSync(path)).toBe(true);
    expect(counts.get(LeftoverGroup.VitestFolders)).toEqual({ found: 1, deleted: 0, failed: 0 });
  });
});

describe("TEMP_PREFIXES", () => {
  it("holds each prefix with its trailing dash", () => {
    expect(TEMP_PREFIXES.every((p) => p.endsWith("-"))).toBe(true);
  });
});
