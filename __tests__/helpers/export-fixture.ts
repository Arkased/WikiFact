// A fixture for the tests of the public export: a small git repo on the branch `build` with fake files, a small live
// store made with the code of `src/store/`, an empty clone as the target, and a terms file of fake terms only.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execaSync } from "execa";
import { McpToolName, RetrievalKind, SearchHitKind } from "../../src/domain/index.js";
import {
  applyChangeSync,
  closeStore,
  enqueueRequest,
  newId,
  openSession,
  openStore,
  recordModelCall,
  recordRetrieval,
  recordSearch,
  recordToolCall,
  setQueuePause,
  type Store,
} from "../../src/store/index.js";
import { accepted, draft } from "./store.js";

/** The embedding model name of the fixture store. */
export const FIXTURE_MODEL = "test-model";

/** A fake private name, as 1 word that no real text holds. */
export const BLOCK_TERM = "Zorblax Industries";
/** A fake home folder, built at run time so that no source line holds an absolute local path. */
export const FAKE_HOME = ["C:", "Users", "Fakeperson"].join("\\");
/** The folder name that Claude Code makes of the fake home folder. */
export const FAKE_HOME_DASHED = "C--Users-Fakeperson";
/** What takes the place of the fake home folder. */
export const REPLACEMENT = "/home/user";
/** The terms file of the fixture: 1 block term and 1 pair. */
export const TERMS_TEXT = `# fake terms\n${BLOCK_TERM}\n${FAKE_HOME} => ${REPLACEMENT}\n`;

/** An anchor of a link to a fake file; kept apart from the link, so that the check of the doc anchors does not read it. */
const ANCHOR = "#top";

/** The stamps of the result files in the fixture, oldest first. */
export const STAMPS = ["2026-01-01T00-00-00.000Z", "2026-02-01T00-00-00.000Z", "2026-03-01T00-00-00.000Z"];

/** The places of the fixture. */
export interface Fixture {
  /** The source repo, on `build`. */
  root: string;
  /** The empty clone of the public repo. */
  target: string;
  /** The live store. */
  dbPath: string;
}

/**
 * Runs git in a folder.
 *
 * @param cwd - the folder
 * @param args - the git arguments
 * @returns the stdout without the trailing newline
 * @throws {Error} when git exits with a code other than 0
 * @sideEffects runs git
 */
export function git(cwd: string, args: string[]): string {
  return execaSync("git", args, { cwd, stdin: "ignore" }).stdout;
}

/**
 * Writes files under a folder.
 *
 * @param dir - the folder
 * @param files - the content by relative path
 * @sideEffects creates the folders and the files
 */
export function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

/**
 * Stages everything of the source repo and commits it.
 *
 * @param root - the source repo
 * @param message - the commit message
 * @sideEffects runs git
 */
export function commitAll(root: string, message: string): void {
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", message]);
}

/**
 * Makes a git repo with an author that is not private.
 *
 * @param dir - an empty folder
 * @param branch - the branch of the first commit
 * @sideEffects runs git; sets the author in the config of the repo
 */
function initRepo(dir: string, branch: string): void {
  git(dir, ["init", "-b", branch]);
  git(dir, ["config", "user.name", "Fixture Dev"]);
  git(dir, ["config", "user.email", "dev@example.invalid"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  git(dir, ["config", "core.autocrlf", "false"]);
}

/**
 * Makes the live store: 2 facts, a change request that cites a session and a search, and a row in each use table.
 * The text holds the fake home folder in both forms.
 *
 * @param dbPath - the file to create
 * @sideEffects creates the store file and its `wikifact.json`
 */
function makeLiveStore(dbPath: string): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  writeFileSync(
    join(dirname(dbPath), "wikifact.json"),
    JSON.stringify({ mode: "local", subject: "A fake subject", embeddingModel: FIXTURE_MODEL }),
  );
  const store: Store = openStore(dbPath, { embeddingModel: FIXTURE_MODEL });
  try {
    openSession(store, { id: "session-1", startedAt: 1, clientName: "fake-client" });
    recordSearch(store, {
      id: "search-1",
      sessionId: "session-1",
      query: "creeper",
      at: 2,
      durationMs: 3,
      results: [{ kind: SearchHitKind.Fact, targetId: "none", rank: 1, ref: "ref-1" }],
    });
    const requestId = enqueueRequest(
      store,
      {
        change: `Creepers do 10 damage; seen in ${FAKE_HOME}\\notes`,
        justification: `I read ${FAKE_HOME_DASHED}-proj`,
        sessionId: "session-1",
        searchId: "search-1",
      },
      4,
    );
    applyChangeSync(
      store,
      requestId,
      accepted([
        draft({
          header: "Creeper damage",
          content: `Creepers do 10 damage to a player. Noted in ${FAKE_HOME}\\notes.`,
          justification: `Measured twice in ${FAKE_HOME_DASHED}-proj.`,
        }),
        draft({ header: "Creeper fuse", content: "A creeper fuse lasts 1.5 seconds.", justification: "Timed it." }),
      ]),
      { now: 5 },
    );
    const factId = (store.db.prepare("SELECT id FROM facts ORDER BY created_at, id").get() as { id: string }).id;
    recordRetrieval(store, factId, { now: 6, kind: RetrievalKind.Read, ref: "ref-1" });
    recordToolCall(store, { at: 7, tool: McpToolName.Search, ok: true, durationMs: 8 });
    recordModelCall(store, {
      requestId,
      question: "Q1",
      model: "m",
      effort: "low",
      tokensIn: 1,
      tokensOut: 1,
      tokensCacheRead: 0,
      tokensCacheWrite: 0,
      durationMs: 1,
      at: 9,
    });
    setQueuePause(store, `paused by ${newId()}`, 10);
    // State of the live service that is no knowledge: it holds a private term, which must not reach the copy.
    store.db
      .prepare("INSERT INTO meta(key, value) VALUES ('worker_status', ?)")
      .run(JSON.stringify({ lastBatchError: { message: `${BLOCK_TERM} failed`, at: 1 } }));
    const staged = store.db.pragma("table_info(stg_fact_versions)") as { name: string; type: string }[];
    const values = staged.map((c) => (c.type.toUpperCase() === "TEXT" ? BLOCK_TERM : 1));
    store.db
      .prepare(
        `INSERT INTO stg_fact_versions(${staged.map((c) => c.name).join(", ")}) VALUES (${staged.map(() => "?").join(", ")})`,
      )
      .run(...values);
  } finally {
    closeStore(store);
  }
}

/**
 * Makes the fixture: the source repo with its first commit on `build`, the empty target with a first commit on
 * `main`, and the live store.
 *
 * @param termsText - the content of the terms file; default `TERMS_TEXT`
 * @returns the places
 * @sideEffects makes a temp folder under the run folder (`__tests__/global-setup.ts` deletes it); runs git; creates files
 */
export function makeFixture(termsText: string = TERMS_TEXT): Fixture {
  const base = mkdtempSync(join(tmpdir(), "wikifact-export-test-"));
  const root = join(base, "source");
  const target = join(base, "target");
  const dbPath = join(base, "live", "wikis", "wikifact", "game.sqlite");
  mkdirSync(root);
  mkdirSync(target);
  makeLiveStore(dbPath);

  initRepo(target, "main");
  git(target, ["commit", "--allow-empty", "-m", "init"]);

  initRepo(root, "build");
  const results = "eval/results";
  writeFiles(root, {
    ".gitignore": "*.sqlite\npublication/private-terms.txt\n",
    "package.json": `${JSON.stringify({ name: "fake", version: "1.2.3", private: true }, null, 2)}\n`,
    "CLAUDE.md": "private instructions\n",
    ".claude/settings.json": "{}\n",
    ".github/ISSUE_TEMPLATE/item.md": "template\n",
    ".worktreeinclude": ".env\n",
    "reports/deploys.md": "deploy log\n",
    "README.md": "the private readme\n",
    "publication/README.md": "The fake public README.\n",
    "publication/export.json": JSON.stringify({
      exclude: [
        "CLAUDE.md",
        ".claude/",
        ".github/ISSUE_TEMPLATE/",
        ".worktreeinclude",
        "reports/",
        "publication/",
        "README.md",
        "docs/decisions/",
      ],
      binaryAllow: ["assets/*.bin"],
      resultFolders: [results],
      demo: { source: dbPath, config: { mode: "deployed" } },
    }),
    "src/code.ts": "export const answer = 42;\n",
    "docs/decisions/0001-product.md": "# 0001. Product\n",
    "docs/decisions/0002-process.md": "# 0002. Process\n",
    "docs/guide.md": [
      "# Guide",
      "",
      `See [the rules](../CLAUDE.md) and [the deploys](../reports/deploys.md${ANCHOR}).`,
      "The cache is kept ([decision 1](decisions/0001-product.md)).",
      "The cache is bounded ([decision 1](decisions/0001-product.md), #60).",
      "The queue is fair ([Tests](code-standard.md), [decision 2](decisions/0002-process.md)).",
      "The decision [0002](decisions/0002-process.md) stands alone.",
      `The older run ${STAMPS[0]}.json is named here.`,
      "",
    ].join("\n"),
    "config/presets.json": "{}\n",
    "assets/blob.bin": "",
    [`${results}/${STAMPS[0]}.json`]: "{}\n",
    [`${results}/${STAMPS[1]}.json`]: "{}\n",
    [`${results}/${STAMPS[2]}.json`]: "{}\n",
    [`${results}/summary-${STAMPS[0]}.json`]: "{}\n",
    [`${results}/summary-${STAMPS[2]}.json`]: "{}\n",
    [`${results}/.gitkeep`]: "",
  });
  writeFileSync(join(root, "assets/blob.bin"), Buffer.from([0xff, 0xfe, 0x00, 0x80]));
  commitAll(root, "first");
  writeFileSync(join(root, "publication/private-terms.txt"), termsText);
  return { root, target, dbPath };
}
