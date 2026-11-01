// `npm run clean-temp [--dry-run]`: deletes the leftovers of tests, evals, the worker, Vitest and `claude -p` in the
// real temp folder of the OS and the run folders of `.cache/test-runs/` (docs/code-standard.md, section 8). The global
// setup of each test run calls `cleanRealTemp` too.
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LeftoverGroup } from "../eval/lib/enums.js";
import { isMain } from "../eval/lib/main.js";
import { ARGV_USER_OFFSET } from "../src/constants.js";
import { readEnv } from "../src/env.js";
import { errorMessage } from "../src/must.js";
import { projectRoot } from "../src/paths.js";

/** The prefix of the temp folder of one test run (`__tests__/global-setup.ts`). */
export const RUN_FOLDER_PREFIX = "wikifact-run-";

/**
 * The folder that holds the run folder of each test run, inside the repo (ignored by git).
 *
 * @returns the absolute path of `.cache/test-runs`
 * @sideEffects none
 */
export function testRunsRoot(): string {
  return join(projectRoot(), ".cache", "test-runs");
}

/** The prefix of the browser profile that playwright-core makes in Temp for each browser launch. */
const PLAYWRIGHT_PROFILE_PREFIX = "playwright_chromiumdev_profile-";

/** Each folder in Temp whose name starts with this is a leftover of the project, whatever the rest of the name is (#77). */
export const WIKIFACT_PREFIX = "wikifact-";

/**
 * The prefixes of the other folders that the repo passes to `mkdtempSync` under `tmpdir()`, each with its trailing `-`.
 * The `wikifact-` folders are not listed: `WIKIFACT_PREFIX` covers them all.
 */
export const TEMP_PREFIXES: readonly string[] = [
  "backup-",
  "benefit-arms-",
  "benefit-file-",
  "benefit-run-",
  "benefit-verify-",
  "clean-temp-test-",
  "evals-",
  "fakeclaude-",
  "fc-",
  "open-for-",
  // Made by playwright-core in the browser test (`__tests__/console-ui.test.ts`), not by a `mkdtempSync` call of the repo.
  "playwright-artifacts-",
  // Made by playwright-core for the browser profile of the browser test.
  PLAYWRIGHT_PROFILE_PREFIX,
  "pool-",
  "qgrp-",
  "qharv-",
  "qhash-",
  "qold-",
  "qres-",
  "qrun-",
  "qsum-",
  "rres-",
  "wf-benefit-req-",
  "wf-corr-test-",
  "wkr-",
];

/** Random characters that `mkdtempSync` appends to a prefix. */
const RANDOM_SUFFIX_LENGTH = 6;

/** A name is a prefix plus these characters, and no others. */
const RANDOM_SUFFIX = /^[A-Za-z0-9]+$/;

/** A folder not older than this, by its modification time, is kept: a run may still use it. One hour in milliseconds. */
export const DEFAULT_MIN_AGE_MS = 60 * 60 * 1000;

/** Retries of a delete that fails on a busy or locked folder. */
const RM_MAX_RETRIES = 3;

/** Pause between the retries of a delete, in milliseconds. */
const RM_RETRY_DELAY_MS = 100;

/** The counts of one prefix. */
export interface PrefixCount {
  found: number;
  deleted: number;
  failed: number;
}

/** The options of `cleanTemp`. */
export interface CleanTempOptions {
  /** The folder to clean; its direct subfolders are the candidates. */
  root: string;
  /** The current time in milliseconds since the epoch. */
  now: number;
  /** A folder is handled only when its age is above this, in milliseconds. */
  minAgeMs: number;
  /** True to count only. */
  dryRun: boolean;
  /** The prefixes to match; the default is `TEMP_PREFIXES`. */
  prefixes?: readonly string[];
  /** Replaces the prefix rule: returns the group of a folder (its path is given), or undefined to skip the folder. */
  match?: (name: string, path: string) => string | undefined;
  /** Called for each folder whose delete failed, with the folder and the error; a failed delete never throws. */
  onFailure?: (path: string, error: unknown) => void;
}

/**
 * Finds the prefix of a folder name: the prefix followed by exactly the random characters of `mkdtempSync`.
 *
 * @param name - the name of a folder
 * @param prefixes - the prefixes to try
 * @returns the matching prefix, or undefined when the name matches none
 * @sideEffects none
 */
function matchPrefix(name: string, prefixes: readonly string[]): string | undefined {
  return prefixes.find(
    (p) =>
      name.length === p.length + RANDOM_SUFFIX_LENGTH && name.startsWith(p) && RANDOM_SUFFIX.test(name.slice(p.length)),
  );
}

/**
 * Deletes the folders directly in a root that match a prefix and are older than the age limit.
 *
 * @param options - the root, the clock, the age limit, the dry-run flag and the prefixes
 * @returns the counts by prefix, only for the prefixes with a folder found
 * @sideEffects reads the root; deletes the matching folders recursively unless `dryRun`; calls `onFailure`; a file or a symlink is never touched
 */
export function cleanTemp(options: CleanTempOptions): Map<string, PrefixCount> {
  const prefixes = options.prefixes ?? TEMP_PREFIXES;
  const counts = new Map<string, PrefixCount>();
  for (const entry of readdirSync(options.root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(options.root, entry.name);
    const prefix = options.match ? options.match(entry.name, path) : matchPrefix(entry.name, prefixes);
    if (prefix === undefined) continue;
    let modified: number;
    try {
      modified = statSync(path).mtimeMs;
    } catch {
      continue;
    }
    if (options.now - modified <= options.minAgeMs) continue;
    const count = counts.get(prefix) ?? { found: 0, deleted: 0, failed: 0 };
    counts.set(prefix, count);
    count.found += 1;
    if (options.dryRun) continue;
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: RM_MAX_RETRIES, retryDelay: RM_RETRY_DELAY_MS });
      count.deleted += 1;
    } catch (e) {
      count.failed += 1;
      options.onFailure?.(path, e);
    }
  }
  return counts;
}

/**
 * Deletes the run folders of stopped test runs that are older than the age limit (docs/code-standard.md, section 8).
 *
 * @param root - the folder that holds the run folders (`testRunsRoot()` in the global setup)
 * @param now - the current time in milliseconds since the epoch
 * @sideEffects reads and deletes folders in `root`; a delete that fails writes 1 warning line to stderr with the
 *   folder and the error, and does not throw
 */
export function cleanStaleRuns(root: string, now: number): void {
  if (!existsSync(root)) return;
  cleanTemp({
    root,
    now,
    minAgeMs: DEFAULT_MIN_AGE_MS,
    dryRun: false,
    prefixes: [RUN_FOLDER_PREFIX],
    onFailure: (path, e) => console.warn(`the stale run folder ${path} is not deleted: ${errorMessage(e)}`),
  });
}

/** The variable that names the real Temp folder to clean; `scripts/run-vitest.ts` sets it before it redirects `TEMP`. */
export const REAL_TEMP_ENV = "WIKIFACT_REAL_TEMP";

/**
 * The real Temp folder of the user: `WIKIFACT_REAL_TEMP` when set, else `tmpdir()`.
 *
 * @returns the absolute path
 * @sideEffects reads `WIKIFACT_REAL_TEMP` from the environment, and `TEMP`, `TMP` or `TMPDIR` through `tmpdir()`
 */
export function realTempDir(): string {
  const given = readEnv().raw[REAL_TEMP_ENV];
  return given === undefined || given === "" ? tmpdir() : given;
}

/** A Vitest folder: 21 characters of nanoid. */
const VITEST_NAME = /^[A-Za-z0-9_-]{21}$/;

/** The subfolders that a Vitest folder holds, and nothing else. */
const VITEST_SUBFOLDERS = new Set(["client", "ssr"]);

/** The folder of Claude Code for a working folder `wikifact-*` in the Temp folder of a user. */
const CLAUDE_WIKIFACT_FOLDER = /^C--Users-.+-AppData-Local-Temp-wikifact-.+$/;

/**
 * Tells a Vitest folder: a 21-character name that holds only the subfolders `client` and `ssr`.
 *
 * @param name - the name of a folder in Temp
 * @param path - the path of the folder
 * @returns true for a Vitest folder; false for any other folder, and for a folder that cannot be read
 * @sideEffects reads the folder; a read that fails writes 1 warning line to stderr
 */
function isVitestFolder(name: string, path: string): boolean {
  if (!VITEST_NAME.test(name)) return false;
  try {
    const entries = readdirSync(path, { withFileTypes: true });
    return entries.length > 0 && entries.every((e) => e.isDirectory() && VITEST_SUBFOLDERS.has(e.name));
  } catch (e) {
    console.warn(`the folder ${path} is not read: ${errorMessage(e)}`);
    return false;
  }
}

/**
 * Tells a folder of the group `LeftoverGroup.Prefixes`: any name that starts with `WIKIFACT_PREFIX`, or a prefix of
 * `TEMP_PREFIXES` followed by the random characters of `mkdtempSync`.
 *
 * @param name - the name of a folder in Temp
 * @returns the group, or undefined for any other folder
 * @sideEffects none
 */
function matchPrefixGroup(name: string): LeftoverGroup | undefined {
  if (name.startsWith(WIKIFACT_PREFIX)) return LeftoverGroup.Prefixes;
  const others = TEMP_PREFIXES.filter((p) => p !== PLAYWRIGHT_PROFILE_PREFIX);
  return matchPrefix(name, others) === undefined ? undefined : LeftoverGroup.Prefixes;
}

/**
 * Deletes every WikiFact leftover in the Temp folder of the user that is older than the age limit: each folder whose
 * name starts with `wikifact-`, the folders with a prefix of `TEMP_PREFIXES`, the browser profiles of playwright, the Vitest folders (21-character name, only `client`
 * and `ssr` inside), and the folders of Claude Code in `<temp>/claude` for the working folders `wikifact-*`.
 *
 * @param options - the Temp folder, the clock, the dry-run flag and the failure callback
 * @param options.temp - the Temp folder to clean
 * @param options.now - the current time in milliseconds since the epoch
 * @param options.dryRun - true to count only
 * @param options.onFailure - called for each folder whose delete failed
 * @returns the counts of the 4 groups of `LeftoverGroup` that this function cleans, in the order of their log lines
 * @sideEffects reads the Temp folder and `<temp>/claude`; deletes the matching folders unless `dryRun`; writes 1 warning
 *   line to stderr for each Vitest-named folder that cannot be read
 */
export function cleanLeftovers(options: {
  temp: string;
  now: number;
  dryRun: boolean;
  onFailure?: (path: string, error: unknown) => void;
}): Map<LeftoverGroup, PrefixCount> {
  const base = { now: options.now, minAgeMs: DEFAULT_MIN_AGE_MS, dryRun: options.dryRun, onFailure: options.onFailure };
  const total = (root: string, rest: Partial<CleanTempOptions>): PrefixCount => {
    const sum = { found: 0, deleted: 0, failed: 0 };
    if (!existsSync(root)) return sum;
    for (const c of cleanTemp({ ...base, root, ...rest }).values()) {
      sum.found += c.found;
      sum.deleted += c.deleted;
      sum.failed += c.failed;
    }
    return sum;
  };
  const vitest = LeftoverGroup.VitestFolders;
  const claude = LeftoverGroup.ClaudeFolders;
  return new Map([
    [LeftoverGroup.Prefixes, total(options.temp, { match: matchPrefixGroup })],
    [LeftoverGroup.PlaywrightProfiles, total(options.temp, { prefixes: [PLAYWRIGHT_PROFILE_PREFIX] })],
    [vitest, total(options.temp, { match: (n, p) => (isVitestFolder(n, p) ? vitest : undefined) })],
    [
      claude,
      total(join(options.temp, "claude"), { match: (n) => (CLAUDE_WIKIFACT_FOLDER.test(n) ? claude : undefined) }),
    ],
  ]);
}

/**
 * The automatic cleanup of the real Temp folder at the start of a test run: deletes the leftovers older than 1 hour and
 * logs 1 line with the counts of each group. It never throws.
 *
 * @param temp - the real Temp folder (`realTempDir()`, read before `TEMP` is redirected)
 * @param now - the current time in milliseconds since the epoch
 * @sideEffects deletes folders in `temp` and `temp/claude`; writes 1 line to stdout, and 1 warning line to stderr for each folder that fails to delete and for each
 *   Vitest-named folder that cannot be read
 */
export function cleanRealTemp(temp: string, now: number): void {
  try {
    const counts = cleanLeftovers({
      temp,
      now,
      dryRun: false,
      onFailure: (path, e) => console.warn(`the leftover ${path} is not deleted: ${errorMessage(e)}`),
    });
    const parts = [...counts].map(([g, c]) => `${g} ${c.deleted} of ${c.found}`);
    console.log(`clean-temp: deleted ${parts.join(", ")}`);
  } catch (e) {
    console.warn(`clean-temp of ${temp} failed: ${errorMessage(e)}`);
  }
}

/**
 * Cleans the leftovers of the real Temp folder and the run folders of stopped test runs, and prints the counts by group.
 *
 * @param dryRun - true to count and print only
 * @returns the exit code, always 0
 * @sideEffects reads the clock and the environment (`WIKIFACT_REAL_TEMP`, `TEMP`); deletes folders in the Temp folder
 *   and in `.cache/test-runs/` unless `dryRun`; prints to stdout, and a warning line to stderr for a folder it cannot read
 */
function main(dryRun: boolean): number {
  const counts = cleanLeftovers({ temp: realTempDir(), now: Date.now(), dryRun });
  if (existsSync(testRunsRoot())) {
    const runs = cleanTemp({
      root: testRunsRoot(),
      now: Date.now(),
      minAgeMs: DEFAULT_MIN_AGE_MS,
      dryRun,
      prefixes: [RUN_FOLDER_PREFIX],
    });
    counts.set(LeftoverGroup.TestRunFolders, runs.get(RUN_FOLDER_PREFIX) ?? { found: 0, deleted: 0, failed: 0 });
  }
  let found = 0;
  let deleted = 0;
  let failed = 0;
  for (const [prefix, c] of counts) {
    console.log(`${prefix} found ${c.found}, deleted ${c.deleted}, failed ${c.failed}`);
    found += c.found;
    deleted += c.deleted;
    failed += c.failed;
  }
  console.log(`${dryRun ? "dry run: " : ""}found ${found}, deleted ${deleted}, failed ${failed}`);
  return 0;
}

if (isMain(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(ARGV_USER_OFFSET).includes("--dry-run"));
  } catch (e) {
    console.error(errorMessage(e));
  }
}
