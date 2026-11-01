// `npm run ship -- patch|minor|major`: one command for a release and its deploy (technical/release.md, "Ship a release"). It refuses a dirty tree or
// a branch other than `build`; runs `npm run check -- --full` once; bumps, tags and fast-forwards `main`; backs up the wikis whose
// schema the new code will migrate; runs the deploy steps; proves the result; and commits the deploy log entry.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { deployPaths, SERVICE_PORT } from "./lib/deploy-paths.js";
import { dirname, join } from "node:path";
import { isMain, lowerPriority } from "../eval/lib/main.js";
import { SCHEMA_VERSION, backupDatabase, readSchemaVersion } from "../src/store/index.js";
import { WIKI_DB_FILE } from "../src/paths.js";
import { deployMachine, waitForPort } from "./deploy.js";
import { cutRelease, parseReleaseKind } from "./lib/release.js";
import { must, requireCleanTree, run, runAsyncScript } from "./lib/shell.js";
import { backupOlderWikis, commitSubjects, insertEntry, runProof, ship } from "./lib/ship.js";
import type { BackupDeps, ProofDeps, ShipIo } from "./lib/ship.js";

/** The deploy log, relative to the checkout. */
const DEPLOY_LOG = "reports/deploys.md";
/** The page that names the running version. */
const CONSOLE_URL = `http://127.0.0.1:${SERVICE_PORT}/console/`;
/** How long the console request may take, in milliseconds. */
const CONSOLE_TIMEOUT_MS = 5_000;
/** How long the proof waits for the port, in milliseconds. */
const PORT_WAIT_MS = 30_000;

// The wiki folders: a folder with a database, no folder that starts with a dot (`.logs`, `.backups`, `.archive`).
function wikiNames(wikis: string): string[] {
  if (!existsSync(wikis)) return [];
  return readdirSync(wikis, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith(".") && existsSync(join(wikis, d.name, WIKI_DB_FILE)))
    .map((d) => d.name);
}

// The stored schema of a wiki, from a read-only open; null when the file cannot be read as a wiki.
function storedSchema(wikis: string, wiki: string): number | null {
  try {
    return readSchemaVersion(join(wikis, wiki, WIKI_DB_FILE));
  } catch {
    return null;
  }
}

// The text of the newest `service.<n>.log` of the log folder; null when there is none.
function newestServiceLog(logs: string): string | null {
  if (!existsSync(logs)) return null;
  const files = readdirSync(logs)
    .filter((f) => /^service\.[^-]*\.log$/.test(f))
    .map((f) => ({ path: join(logs, f), mtime: statSync(join(logs, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return files[0] === undefined ? null : readFileSync(files[0].path, "utf8");
}

function realIo(): ShipIo {
  const paths = deployPaths(homedir());
  const backupDeps: BackupDeps = {
    list: () => wikiNames(paths.wikis),
    stored: (wiki) => storedSchema(paths.wikis, wiki),
    copy: async (wiki, to) => {
      const target = join(paths.wikis, to);
      mkdirSync(dirname(target), { recursive: true });
      await backupDatabase(join(paths.wikis, wiki, WIKI_DB_FILE), target);
    },
  };
  const proofDeps: ProofDeps = {
    portAnswers: () => waitForPort(SERVICE_PORT, PORT_WAIT_MS),
    consolePage: async () => {
      try {
        const r = await fetch(CONSOLE_URL, { signal: AbortSignal.timeout(CONSOLE_TIMEOUT_MS) });
        return r.ok ? await r.text() : null;
      } catch {
        return null;
      }
    },
    schemas: () =>
      wikiNames(paths.wikis).map((wiki) => ({ wiki, stored: storedSchema(paths.wikis, wiki), code: SCHEMA_VERSION })),
    serviceLog: () => newestServiceLog(paths.logs),
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
  return {
    requireCleanTree,
    branch: () => must("git", ["branch", "--show-current"]).trim(),
    check: () => void must("npm", ["run", "check", "--", "--full"], true),
    release: (kind) =>
      cutRelease(
        kind,
        (file, args) => void must(file, args, true),
        (file, args) => must(file, args),
      ),
    backups: (version) => backupOlderWikis(backupDeps, SCHEMA_VERSION, version),
    deploy: (log) => deployMachine({ task: true }, log),
    proof: (version, since) => runProof(proofDeps, version, since),
    changes: (tag) => commitSubjects(tag, (args) => run("git", args)),
    now: () => new Date(),
    commitEntry: (version, entry) => {
      writeFileSync(DEPLOY_LOG, insertEntry(readFileSync(DEPLOY_LOG, "utf8"), entry));
      must("git", ["add", DEPLOY_LOG]);
      must("git", ["commit", "-m", `Deploy log: v${version}`], true);
    },
    log: (line) => console.log(line),
  };
}

if (isMain(import.meta.url)) {
  lowerPriority();
  void runAsyncScript(async () => void (await ship(parseReleaseKind(process.argv[2]), realIo())));
}
