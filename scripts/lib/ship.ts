// The logic of `npm run ship` (technical/release.md, "Ship a release"), with every outside call injected: the order of the steps, the schema
// backup decision, the proof, and the deploy log entry. `scripts/ship.ts` wires the real calls.
import { z } from "zod";
import { LogEvent } from "../../src/domain/index.js";
import type { Log } from "../deploy.js";
import { ScriptError } from "./shell.js";
import type { RunResult } from "./shell.js";
import { requireBuildBranch } from "./release.js";
import type { ReleaseKind } from "../../eval/lib/enums.js";

// The two fields of a service log line that the proof reads.
const LOG_ENTRY = z.object({ event: z.enum(LogEvent), ts: z.string() });

/** A copy of a wiki made before the deploy. */
export interface BackupRecord {
  wiki: string;
  /** The schema the wiki had when it was copied. */
  schema: number;
  /** The file of the copy. */
  path: string;
}

/** What the backup step needs from the outside. */
export interface BackupDeps {
  /** The names of the wiki folders. */
  list(): string[];
  /** The stored `schema_version` of a wiki, read-only; null when it has none. */
  stored(wiki: string): number | null;
  /** Copies the database of a wiki with the SQLite backup API to a path relative to the wikis folder. */
  copy(wiki: string, to: string): Promise<void>;
}

/** The folder of the backups inside the wikis folder. */
const BACKUPS_DIR = ".backups";

/**
 * Names the backup of a wiki for a version, relative to the wikis folder, so that no local path reaches the deploy log.
 *
 * @param wiki - the wiki name
 * @param version - the version being shipped
 * @returns the path with forward slashes, such as `.backups/wikifact-0.1.20.sqlite`
 * @sideEffects none
 */
function backupTarget(wiki: string, version: string): string {
  return `${BACKUPS_DIR}/${wiki}-${version}.sqlite`;
}

/**
 * Backs up each wiki whose stored schema is older than the schema of the code: the service migrates a wiki when it
 * opens it, and a migration cannot be undone without the copy. A wiki at the schema of the code, newer, or without a
 * stored version is not copied.
 *
 * @param deps - the wiki reads and the copy
 * @param codeSchema - the schema version of the code
 * @param version - the version being shipped, which names the copies
 * @returns the copies made, in the order of the wikis
 * @sideEffects whatever `deps.copy` does
 */
export async function backupOlderWikis(deps: BackupDeps, codeSchema: number, version: string): Promise<BackupRecord[]> {
  const made: BackupRecord[] = [];
  for (const wiki of deps.list()) {
    const schema = deps.stored(wiki);
    if (schema === null || schema >= codeSchema) continue;
    const path = backupTarget(wiki, version);
    await deps.copy(wiki, path);
    made.push({ wiki, schema, path });
  }
  return made;
}

/** The stored schema of a wiki next to the schema of the code. */
interface SchemaCheck {
  wiki: string;
  stored: number | null;
  code: number;
}

/** The result of the proof after the start. */
export interface Proof {
  /** True when the service port accepts a connection. */
  portAnswers: boolean;
  /** True when `/console/` names the new version. */
  consoleHasVersion: boolean;
  schemas: SchemaCheck[];
  /** The first `listening` line the new service logged, or null. */
  listening: string | null;
}

/** What the proof needs from the outside. */
export interface ProofDeps {
  portAnswers(): Promise<boolean>;
  /** The text of the console start page; null when it did not answer. */
  consolePage(): Promise<string | null>;
  /** The stored schema of each wiki, read-only. */
  schemas(): SchemaCheck[];
  /** The text of the newest service log file; null when there is none. */
  serviceLog(): string | null;
  /** Waits for the given time in ms between two reads of the console page. */
  wait(ms: number): Promise<void>;
}

/** How many times the proof reads the console page for the new version: the first read and 5 retries. */
export const CONSOLE_ATTEMPTS = 6;

/** The pause between two reads of the console page, in ms: 5 pauses make the 10 s that the proof waits in all. */
const CONSOLE_RETRY_MS = 2_000;

/**
 * Tells whether the proof passed: the port answers, the console names the version, every wiki is at the code schema.
 *
 * @param proof - the results
 * @returns true when all of them hold; a missing listening line does not fail it
 * @sideEffects none
 */
export function proofPassed(proof: Proof): boolean {
  return proof.portAnswers && proof.consoleHasVersion && proof.schemas.every((s) => s.stored === s.code);
}

/**
 * Finds the first `listening` line that a service logged at or after a time.
 *
 * @param logText - the lines of a service log, as JSON
 * @param since - the time the deploy started the service
 * @returns the line as written, or null; a line that is not JSON is skipped
 * @sideEffects none
 */
export function findListeningLine(logText: string, since: Date): string | null {
  for (const line of logText.split(/\r?\n/)) {
    try {
      const entry = LOG_ENTRY.safeParse(JSON.parse(line));
      if (entry.success && entry.data.event === LogEvent.Listening && new Date(entry.data.ts) >= since) return line;
    } catch {
      continue;
    }
  }
  return null;
}

// `v<version>` with no digit after it, so that `v0.1.1` does not match inside `v0.1.19`.
function versionPattern(version: string): RegExp {
  return new RegExp(`v${version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![0-9])`);
}

/**
 * Runs the checks after the start. The console page is read again, `CONSOLE_RETRY_MS` apart and `CONSOLE_ATTEMPTS`
 * times at most (10 s of waiting), until it names the version, because the first read can reach the old process during
 * the swap.
 *
 * @param deps - the reads
 * @param version - the shipped version, such as `0.1.19`
 * @param since - the time the deploy started the service
 * @returns the results
 * @sideEffects whatever `deps` do
 */
export async function runProof(deps: ProofDeps, version: string, since: Date): Promise<Proof> {
  const portAnswers = await deps.portAnswers();
  const pattern = versionPattern(version);
  let consoleHasVersion = false;
  for (let attempt = 1; portAnswers && !consoleHasVersion && attempt <= CONSOLE_ATTEMPTS; attempt++) {
    if (attempt > 1) await deps.wait(CONSOLE_RETRY_MS);
    const page = await deps.consolePage();
    consoleHasVersion = page !== null && pattern.test(page);
  }
  const log = deps.serviceLog();
  return {
    portAnswers,
    consoleHasVersion,
    schemas: deps.schemas(),
    listening: log === null ? null : findListeningLine(log, since),
  };
}

/** The facts of one deploy log entry. */
export interface DeployEntry {
  /** The version without the `v`. */
  version: string;
  time: Date;
  /** The subjects of the commits since the previous release. */
  changes: string[];
  /** The stop, start and port lines of the deploy. */
  lines: string[];
  proof: Proof;
  backups: BackupRecord[];
}

/** The length of the ISO time up to the minute (`2026-10-14T02:40`). */
const ISO_MINUTE_CHARS = 16;

// "2026-10-14 02:40 UTC"
function utcStamp(time: Date): string {
  return `${time.toISOString().slice(0, ISO_MINUTE_CHARS).replace("T", " ")} UTC`;
}

/**
 * Writes one entry of `reports/deploys.md`: the heading with the version and the UTC time, the changes, the lines in a
 * block, the proof results and the backup paths.
 *
 * @param entry - the facts
 * @returns the Markdown text, ending with a blank line
 * @sideEffects none
 */
export function formatEntry(entry: DeployEntry): string {
  const { proof } = entry;
  const block = [...entry.lines, ...(proof.listening === null ? [] : [proof.listening])];
  const schemas = proof.schemas.map((s) => `${s.wiki} stored ${s.stored ?? "none"}, code ${s.code}`).join("; ");
  const passed = proofPassed(proof);
  const results = [
    `the port ${proof.portAnswers ? "answers" : "did NOT answer"}`,
    `\`/console/\` ${proof.consoleHasVersion ? "shows" : "does NOT show"} v${entry.version}`,
    `schema: ${schemas === "" ? "no wiki" : schemas}`,
    proof.listening === null ? "no listening line was found in the service log" : "the listening line is above",
  ].join("; ");
  return [
    `## v${entry.version}, ${utcStamp(entry.time)}`,
    "",
    entry.changes.length === 0 ? "No commit subjects were found." : entry.changes.map((c) => `- ${c}`).join("\n"),
    "",
    "```",
    ...block,
    "```",
    "",
    `Proof${passed ? "" : " (FAILED)"}: ${results}.`,
    "",
    entry.backups.length === 0
      ? "No backup: every wiki was at the schema of the code."
      : `Backups before the deploy: ${entry.backups.map((b) => `${b.wiki} at schema ${b.schema} in \`${b.path}\``).join("; ")}.`,
    "",
    "",
  ].join("\n");
}

/**
 * Puts an entry at the top of the entries of the deploy log (newest first).
 *
 * @param text - the current file
 * @param entry - the formatted entry
 * @returns the new file text; the entry goes before the first `## ` heading, or at the end without one
 * @sideEffects none
 */
export function insertEntry(text: string, entry: string): string {
  const at = text.search(/^## /m);
  return at === -1 ? `${text.trimEnd()}\n\n${entry}` : `${text.slice(0, at)}${entry}${text.slice(at)}`;
}

/**
 * Lists the subjects of the commits between the previous tag and a tag.
 *
 * @param tag - the new tag, such as `v0.1.19`
 * @param git - runs git with the arguments and returns the exit code and stdout
 * @returns the subjects, newest first; empty when there is no previous tag or the log fails (the deploy log entry must
 *   not fail after the deploy)
 * @sideEffects whatever `git` does
 */
export function commitSubjects(tag: string, git: (args: string[]) => RunResult): string[] {
  const previous = git(["describe", "--tags", "--abbrev=0", `${tag}^`]);
  const previousTag = previous.stdout.trim();
  if (previous.code !== 0 || previousTag === "") return [];
  const log = git(["log", "--format=%s", `${previousTag}..${tag}`]);
  return log.code === 0 ? log.stdout.split(/\r?\n/).filter(Boolean) : [];
}

/** The outside calls of the ship, one per step. */
export interface ShipIo {
  /** Throws when the working tree is dirty. */
  requireCleanTree(): void;
  /** The current branch. */
  branch(): string;
  /** `npm run check`. */
  check(): void;
  /** Bumps, tags and fast-forwards `main`; returns the tag `vX.Y.Z`, which `cutRelease` has checked. */
  release(kind: ReleaseKind): string;
  /** Backs up the older wikis; runs before the service stops. */
  backups(version: string): Promise<BackupRecord[]>;
  /** The deploy steps; every line goes through `log`. */
  deploy(log: Log): Promise<void>;
  /** The proof after the start. */
  proof(version: string, since: Date): Promise<Proof>;
  /** The subjects of the commits since the previous release. */
  changes(tag: string): string[];
  now(): Date;
  /** Adds the entry to the deploy log file and commits it on `build`. */
  commitEntry(version: string, entry: string): void;
  /** Prints a line. */
  log(line: string): void;
}

/**
 * Releases and deploys: the one command of a round of work.
 *
 * @param kind - the version bump
 * @param io - the outside calls
 * @returns the entry that was committed
 * @throws {ScriptError} when the tree is dirty, the branch is not `build`, a step fails, or the proof failed (the
 *   entry with the failed results is committed first)
 * @sideEffects whatever `io` does, in this order: guards, check, release, backups, deploy, proof, deploy log entry
 */
export async function ship(kind: ReleaseKind, io: ShipIo): Promise<string> {
  io.requireCleanTree();
  requireBuildBranch(io.branch());
  io.check();
  const tag = io.release(kind);
  const version = tag.replace(/^v/, "");
  const backups = await io.backups(version);
  const lines: string[] = [];
  const startedAt = io.now();
  await io.deploy((line) => {
    io.log(line);
    lines.push(line);
  });
  const proof = await io.proof(version, startedAt);
  const entry = formatEntry({ version, time: io.now(), changes: io.changes(tag), lines, proof, backups });
  io.commitEntry(version, entry);
  if (!proofPassed(proof))
    throw new ScriptError(`the proof of v${version} failed: see the entry in reports/deploys.md`);
  io.log(`shipped ${tag}`);
  return entry;
}
