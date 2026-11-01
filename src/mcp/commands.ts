// The `serve` command (technical/deployment.md, "Install and run"). Stdio by default, `--http PORT` for shared use (loopback unless the wiki is
// deployed and `--host` says otherwise, technical/deployment.md, "Local mode"), `--wikis <dir>` for service mode (technical/deployment.md, "Service mode").
// `--with-worker` starts the worker as a child process (technical/deployment.md, "Local mode").
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { refuse, type Command, type CommandArgs } from "../cli/command.js";
import { LOCAL_CONDITION, loadConfig } from "../config/index.js";
import { LogEvent, LogLevel, Mode, ServeTarget } from "../domain/enums.js";
import { embed } from "../embed/index.js";
import { stderrLogger, type Logger } from "../log/index.js";
import { consoleRoute, singleWikiDeps } from "../console/index.js";
import { serviceBaseUrl } from "../service/routes.js";
import { runService } from "../service/run.js";
import { closeStore, endOpenSessions, openStoreFor, pruneToolCalls } from "../store/index.js";
import { DEFAULT_HOST, hostRefusal } from "./host.js";
import { firstRoute, singleRoute, startHttpServer } from "./http.js";
import { createServer, type ServerDeps } from "./server.js";
import { McpSessions, stdioSession } from "./sessions.js";
import { startWorkerChild, type WorkerChild } from "./worker-child.js";

// Connects the MCP server to stdio and ends the process when the client goes away or a signal arrives. A stdio
// process is 1 session (technical/deployment.md, "MCP sessions").
async function serveStdio(deps: ServerDeps, shutdown: () => void, log: Logger): Promise<void> {
  const session = stdioSession({ store: deps.writeStore, log });
  const server = createServer(deps, undefined, session.handle);
  await server.connect(new StdioServerTransport());
  const stop = (): void => {
    session.end();
    shutdown();
    process.exit(0);
  };
  process.stdin.on("close", stop);
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

/**
 * What `serveHttp` needs besides the deps: the address, the shutdown, the warm-up that runs after the bind, and what
 * the console's service row shows (technical/console.md, "Mount in the service").
 */
interface HttpServe {
  host: string;
  port: number;
  shutdown: () => void;
  warm: () => Promise<unknown>;
  /** The worker child, read at each console request because it starts after the bind. */
  worker: () => WorkerChild | undefined;
  logDir?: string;
}

// Listens on a port, warms the embedder, and ends the process on a signal. The bind comes first, so a client that
// connects during the warm-up is answered; its `search` waits for the warm-up. The console (technical/console.md, "Mount in the service") is mounted next to
// `/mcp`.
async function serveHttp(deps: ServerDeps, opts: HttpServe, log: Logger): Promise<void> {
  const { host, port, shutdown, warm } = opts;
  let bound = port;
  const consolePages = consoleRoute(
    singleWikiDeps({ deps, worker: opts.worker, baseUrl: () => serviceBaseUrl(host, bound), logDir: opts.logDir, log }),
  );
  // A server that stopped without ending its sessions left rows open; none of them can still be live.
  endOpenSessions(deps.writeStore, Date.now());
  pruneToolCalls(deps.writeStore, Date.now());
  const sessions = new McpSessions({ store: deps.writeStore, log });
  const handle = await startHttpServer(firstRoute([singleRoute(deps, sessions), consolePages]), { host, port, log });
  const { server: httpServer } = handle;
  bound = handle.port;
  // `close` writes the end of each session before it first waits, so the store can close right after.
  const stop = (): void => {
    httpServer.close();
    void sessions.close();
    shutdown();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    await warm();
  } catch (e) {
    httpServer.close();
    void sessions.close();
    shutdown();
    throw e;
  }
}

/**
 * Runs the MCP server over stdio, or over HTTP with `--http`, and the worker child with `--with-worker`. With
 * `--wikis` it runs service mode (`runService`) instead.
 *
 * @param args - the database path, the HTTP port (`undefined` means stdio), the `--host` (default `127.0.0.1`), the
 *   `--with-worker` flag and the `--wikis` folder
 * @returns when stdio is connected or the HTTP port is bound; the process then lives until a signal or the end of
 *   stdin. Also returns at once, after setting exit code 1, when the wiki is in local mode and `--host` is not the
 *   loopback
 * @throws {Error} when `wikifact.json` or the presets file is invalid, or the database cannot be opened
 * @sideEffects reads `wikifact.json`; opens the write connection to the database; loads the embedding model (one
 *   `embed` call); spawns the worker child with `--with-worker`; installs `SIGINT`, `SIGTERM`, `exit` and stdin
 *   `close` handlers that stop the child, close the store and call `process.exit(0)`; logs one `LogEvent.Serve` line
 *   and the transport lines to stderr; writes a refusal to stderr and sets `process.exitCode`
 */
export async function serve(args: CommandArgs): Promise<void> {
  if (args.wikis !== undefined) return runService(args);
  const { db, http, withWorker } = args;
  const logErr = args.log ?? stderrLogger();
  const host = args.host ?? DEFAULT_HOST;
  const config = loadConfig(db);
  const refusal = http === undefined ? undefined : hostRefusal(config.mode, host);
  if (refusal !== undefined) {
    refuse(args, refusal, logErr);
    return;
  }
  // The first line names the mode, the transport and, in local mode, the condition.
  logErr({
    event: LogEvent.Serve,
    level: LogLevel.Info,
    mode: config.mode,
    transport: http === undefined ? "stdio" : "http",
    ...(config.mode === Mode.Local ? { condition: LOCAL_CONDITION } : {}),
    withWorker: withWorker === true,
    target: ServeTarget.Db,
    path: db,
    ...(http === undefined ? {} : { host }),
  });

  const writeStore = openStoreFor(config, db);
  // The first embedding call loads the model. Do it before the first search, not in it. Over HTTP it runs after the
  // bind, and a `search` that arrives meanwhile waits on `warming`.
  let warming: Promise<unknown> = Promise.resolve();
  const warm = (): Promise<unknown> => (warming = embed(["warm up"]));
  const deps: ServerDeps = {
    dbPath: db,
    config,
    writeStore,
    log: logErr,
    ready: () => warming,
  };
  // Stdio has no bind to put first, so it warms before anything else, as it always did.
  if (http === undefined) await warm();

  let workerChild: WorkerChild | undefined;
  let stopped = false;
  const shutdown = (): void => {
    if (stopped) return;
    stopped = true;
    workerChild?.stop();
    try {
      closeStore(writeStore);
    } catch {
      // already closed
    }
  };
  process.on("exit", () => workerChild?.stop());
  if (withWorker) workerChild = startWorkerChild({ db, log: logErr, logDir: args.logDir });

  if (http === undefined) await serveStdio(deps, shutdown, logErr);
  else {
    await serveHttp(deps, { host, port: http, shutdown, warm, worker: () => workerChild, logDir: args.logDir }, logErr);
  }
}

/** The commands of the MCP module. */
export const commands: Command[] = [
  {
    name: "serve",
    description:
      "Run the MCP server (stdio, or --http PORT [--host ADDR]; --wikis DIR --http PORT for every wiki of a folder). --with-worker starts the worker as a child.",
    run: serve,
  },
];
