// technical/deployment.md, "Service mode": `serve --wikis <dir> --http PORT [--host] [--with-worker]`.
import { EXIT_USAGE, refuse, type CommandArgs } from "../cli/command.js";
import { LOCAL_CONDITION } from "../config/index.js";
import { LogEvent, LogLevel, Mode, ServeTarget } from "../domain/enums.js";
import { embed } from "../embed/index.js";
import { stderrLogger } from "../log/index.js";
import { DEFAULT_HOST, hostRefusal } from "../mcp/host.js";
import { startHttpServer } from "../mcp/http.js";
import { createWikiRegistry, discoverWikis, serviceMode } from "./registry.js";
import { serviceBaseUrl, serviceRoute } from "./routes.js";

/**
 * Serves every wiki of a folder over HTTP, with a management endpoint, and a worker child per wiki with
 * `--with-worker`.
 *
 * @param args - `wikis` (the folder), `http` (the port; 0 picks a free one), `host` (default `127.0.0.1`) and
 *   `withWorker`, and `maxWikis` (the cap of `createWiki`, default 10)
 * @returns when the port is bound, every wiki is mounted and the embedder is warm; the process then lives until a
 *   signal. The port is bound first: a `search` call during the warm-up waits for it. Also returns at
 *   once, after setting exit code 2 when `--http` is missing, or exit code 1 when a local-mode wiki meets a host
 *   other than the loopback
 * @throws {Error} when the folder is missing, a `wikifact.json` or the presets file is invalid, the port cannot be
 *   bound, a database cannot be opened, or the embedding model fails to load
 * @sideEffects reads the folder and every `wikifact.json`; logs one `LogEvent.Serve` line, one `LogEvent.Listening`
 *   line and one `LogEvent.WikiMounted` line per wiki to stderr; loads the embedding model (one `embed` call); opens
 *   a write connection per wiki; binds a TCP port; spawns a worker child per wiki with `--with-worker`; installs
 *   `SIGINT`, `SIGTERM` and `exit` handlers that stop the children, close the stores and call `process.exit(0)`;
 *   writes a refusal to stderr
 */
export async function runService(args: CommandArgs): Promise<void> {
  const { wikis, http, withWorker } = args;
  const logErr = args.log ?? stderrLogger();
  if (wikis === undefined || http === undefined) {
    process.stderr.write("serve --wikis needs --http PORT\n");
    process.exitCode = EXIT_USAGE;
    return;
  }
  const host = args.host ?? DEFAULT_HOST;
  const found = discoverWikis(wikis);
  for (const w of found) {
    const refusal = hostRefusal(w.config.mode, host);
    if (refusal !== undefined) {
      refuse(args, `wiki "${w.name}": ${refusal}`, logErr);
      return;
    }
  }
  const mode = serviceMode(found[0]?.config.mode, host);
  logErr({
    event: LogEvent.Serve,
    level: LogLevel.Info,
    mode,
    transport: "http",
    ...(mode === Mode.Local ? { condition: LOCAL_CONDITION } : {}),
    withWorker: withWorker === true,
    target: ServeTarget.Wikis,
    path: wikis,
    wikis: found.map((w) => w.name),
    host,
  });

  let base = "";
  // The port is bound before the model loads, so a client that connects right after logon is answered; a `search`
  // that arrives during the warm-up waits on this promise.
  let warming: Promise<unknown> = Promise.resolve();
  const registry = createWikiRegistry({
    wikisDir: wikis,
    host,
    withWorker: withWorker === true,
    maxWikis: args.maxWikis,
    log: logErr,
    logDir: args.logDir,
    baseUrl: () => base,
    ready: () => warming,
  });
  process.on("exit", () => registry.stop());
  const handle = await startHttpServer(serviceRoute(registry, logErr), { host, port: http, log: logErr });
  base = serviceBaseUrl(handle.host, handle.port);
  const stop = (): void => {
    handle.server.close();
    registry.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    for (const w of found) registry.mount(w);
    // The first embedding call loads the model. Do it once, for every wiki of the process.
    warming = embed(["warm up"]);
    await warming;
  } catch (e) {
    handle.server.close();
    registry.stop();
    throw e;
  }
}
