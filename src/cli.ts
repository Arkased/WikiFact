#!/usr/bin/env node
// The command dispatcher. Each module owns its commands: `src/mcp/commands.ts`, `src/updates/commands.ts`.
import { join } from "node:path";
import { parseArgs } from "node:util";
import { EXIT_USAGE, type Command } from "./cli/command.js";
import { LogEvent, LogLevel, LogProcess } from "./domain/enums.js";
import { loadEnvFile } from "./env.js";
import { logBaseName, processLogger, type ProcessLogger } from "./log/index.js";
import { wikiNameOf } from "./mcp/worker-child.js";
import { commands as mcpCommands } from "./mcp/commands.js";
import { errnoCode, errorMessage } from "./must.js";
import { DEFAULT_DB_PATH } from "./paths.js";
import { commands as updateCommands } from "./updates/commands.js";
import { ARGV_USER_OFFSET } from "./constants.js";

/** The highest TCP port. */
const MAX_PORT = 65535;
/** The width of the command name column in the usage text, in characters. */
const COMMAND_COLUMN_WIDTH = 10;

const all: Command[] = [...mcpCommands, ...updateCommands];

const OPTIONS = {
  db: { type: "string" },
  http: { type: "string" },
  host: { type: "string" },
  wikis: { type: "string" },
  "max-wikis": { type: "string" },
  "with-worker": { type: "boolean" },
  "log-dir": { type: "string" },
} as const;

/** The logger of this process once `main` has made it; the top-level error handler writes to it. */
let active: ProcessLogger | undefined;

/** The command line after parsing: the command name, its positional arguments and the shared options. */
type Parsed =
  | {
      name?: string;
      db: string;
      dbGiven: boolean;
      http?: number;
      host?: string;
      wikis?: string;
      maxWikis?: number;
      logDir?: string;
      withWorker: boolean;
      rest: string[];
    }
  | { error: string };

/** The command line when it parsed without an error. */
type ParsedArgs = Exclude<Parsed, { error: string }>;

function usage(): string {
  const lines = all.map((c) => `  ${c.name.padEnd(COMMAND_COLUMN_WIDTH)} ${c.description}`);
  return `usage: wikifact <command> [--db <file>, default ${DEFAULT_DB_PATH} | --wikis <dir>] [--http <port>] [--host <addr>] [--with-worker] [--max-wikis <n>] [--log-dir <dir>, default <wikis>/.logs in service mode] [args]\n${lines.join("\n")}`;
}

function parse(argv: string[]): Parsed {
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: false });
  const [name, ...rest] = positionals;
  const db = values.db ?? DEFAULT_DB_PATH;
  if (typeof db !== "string" || db === "") return { error: "--db needs a path" };
  let http: number | undefined;
  if (values.http !== undefined) {
    const port = typeof values.http === "string" ? Number(values.http) : Number.NaN;
    if (values.http === "" || !Number.isInteger(port) || port < 0 || port > MAX_PORT) {
      return { error: "--http needs a port number" };
    }
    http = port;
  }
  const host = values.host;
  if (host !== undefined && (typeof host !== "string" || host === "")) return { error: "--host needs an address" };
  const wikis = values.wikis;
  if (wikis !== undefined && (typeof wikis !== "string" || wikis === "")) return { error: "--wikis needs a folder" };
  if (wikis !== undefined && values.db !== undefined) return { error: "--wikis and --db exclude each other" };
  let maxWikis: number | undefined;
  if (values["max-wikis"] !== undefined) {
    const n = typeof values["max-wikis"] === "string" ? Number(values["max-wikis"]) : Number.NaN;
    if (values["max-wikis"] === "" || !Number.isInteger(n) || n < 1)
      return { error: "--max-wikis needs a positive integer" };
    maxWikis = n;
  }
  const logDirValue = values["log-dir"];
  if (logDirValue !== undefined && (typeof logDirValue !== "string" || logDirValue === ""))
    return { error: "--log-dir needs a folder" };
  return {
    name,
    maxWikis,
    logDir: logDirValue,
    db,
    dbGiven: values.db !== undefined,
    http,
    host,
    wikis,
    withWorker: values["with-worker"] === true,
    rest,
  };
}

// The log directory: `--log-dir`, else `<wikis>/.logs` in service mode, else none (stderr).
function effectiveLogDir(p: ParsedArgs): string | undefined {
  if (p.logDir !== undefined) return p.logDir;
  return p.name === "serve" && p.wikis !== undefined ? join(p.wikis, ".logs") : undefined;
}

// The process name of the log files: the service, a worker (named for its wiki), or a single-database server.
// Other commands print to the console and have no log.
function logNameFor(p: ParsedArgs): string | undefined {
  if (p.name === "serve") return logBaseName(p.wikis !== undefined ? LogProcess.Service : LogProcess.Serve);
  if (p.name === "worker") return logBaseName(LogProcess.Worker, wikiNameOf(p.db));
  return undefined;
}

// The hint for a listen error on a port that is in use, to append to the cause; empty for any other error.
function portHint(e: unknown): string {
  if (errnoCode(e) !== "EADDRINUSE" || typeof e !== "object" || e === null || !("port" in e)) return "";
  return `; port ${String(e.port)} is in use; pass --http <other port>`;
}

async function main(argv: string[]): Promise<number> {
  const parsed = parse(argv);
  if ("error" in parsed) {
    process.stderr.write(`${parsed.error}\n`);
    return EXIT_USAGE;
  }
  // First thing: load `.env` (next to the database, then the wikis root, then the project root; the first file found
  // wins). Values are never logged.
  loadEnvFile({ dbPath: parsed.dbGiven ? parsed.db : undefined, wikisDir: parsed.wikis });
  const cmd = all.find((c) => c.name === parsed.name);
  if (!cmd) {
    if (parsed.name) {
      process.stderr.write(`${usage()}\n`);
      return EXIT_USAGE;
    }
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  const logDir = effectiveLogDir(parsed);
  const logName = logNameFor(parsed);
  if (logName !== undefined) {
    // Only a worker has a call log.
    const callsName =
      parsed.name === "worker" ? logBaseName(LogProcess.Worker, wikiNameOf(parsed.db), true) : undefined;
    active = await processLogger({ logDir, name: logName, callsName });
  }
  await cmd.run({
    logDir: active?.toFiles ? logDir : undefined,
    log: active?.log,
    db: parsed.db,
    rest: parsed.rest,
    http: parsed.http,
    host: parsed.host,
    wikis: parsed.wikis,
    maxWikis: parsed.maxWikis,
    withWorker: parsed.withWorker,
  });
  return 0;
}

main(process.argv.slice(ARGV_USER_OFFSET)).then(
  (code) => {
    if (code !== 0) process.exitCode = code;
  },
  (e: unknown) => {
    const message = errorMessage(e);
    // The log entry stays; the console also gets the cause, because a process that logs to files prints nothing else (docs/technical/deployment.md#logging).
    if (active?.toFiles) active.log({ event: LogEvent.Unhandled, level: LogLevel.Error, error: message });
    process.stderr.write(`${message}${portHint(e)}\n`);
    process.exit(1);
  },
);
