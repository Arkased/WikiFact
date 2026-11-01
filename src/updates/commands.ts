// The commands `worker`, `requeue`, `check` and `reindex` (technical/deployment.md, "Install and run"). This is the CLI layer: it prints.
import { refuse, type Command, type CommandArgs } from "../cli/command.js";
import { LOCAL_CONDITION, loadConfig } from "../config/index.js";
import { CallerKind, LogEvent, LogLevel, Mode, RequestKind } from "../domain/enums.js";
import { readEnv } from "../env.js";
import { stderrLogger } from "../log/index.js";
import { selectTransport, TransportError } from "./questions/index.js";
import {
  checkIndex,
  closeStore,
  getSearchQuery,
  listFailed,
  openStoreFor,
  reindex,
  requeue,
  type ChangeRequestRow,
  type Store,
} from "../store/index.js";
import { createQuestions } from "./factory.js";
import { LockError } from "./lock.js";
import { runWorker } from "./worker.js";

/** The longest change text in the list of failed requests, in characters. */
const CHANGE_TEXT_CHARS = 60;
/** The longest error text in the list of failed requests, in characters. */
const ERROR_TEXT_CHARS = 200;
/** The exit code of a command that found a problem (a failed `check`, an unknown request id). */
const EXIT_PROBLEM = 1;

const printLine = (s: string): void => void process.stdout.write(`${s}\n`);
const printError = (s: string): void => void process.stderr.write(`${s}\n`);

function truncate(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
}

// One line per failed request, for `wikifact requeue` without an id.
function formatFailed(store: Store, row: ChangeRequestRow): string {
  const what =
    row.kind === RequestKind.LookupRepair
      ? `lookupRepair of ${row.targets.join(",")} for "${(row.searchId === null ? undefined : getSearchQuery(store, row.searchId)) ?? ""}"`
      : `"${truncate(row.change ?? "", CHANGE_TEXT_CHARS)}"`;
  return `${row.id}  attempts=${row.attempts}  ${what}  error: ${truncate(row.error ?? "", ERROR_TEXT_CHARS)}`;
}

async function worker(args: CommandArgs): Promise<void> {
  const { db } = args;
  const log = args.log ?? stderrLogger();
  const config = loadConfig(db);
  let sel;
  try {
    sel = selectTransport(CallerKind.Worker, readEnv(), { mode: config.mode, log });
  } catch (e) {
    if (!(e instanceof TransportError)) throw e;
    // Without a key, a deployed worker exits with a message.
    log({
      event: LogEvent.Worker,
      level: LogLevel.Error,
      mode: config.mode,
      transport: "none",
      ...(config.mode === Mode.Local ? { condition: LOCAL_CONDITION } : {}),
      db,
    });
    refuse(args, e.message, log);
    return;
  }
  // The first line names the mode, the transport and, in local mode, the condition (the same style as `serve`).
  log({
    event: LogEvent.Worker,
    level: LogLevel.Info,
    mode: config.mode,
    transport: sel.name,
    ...(config.mode === Mode.Local ? { condition: LOCAL_CONDITION } : {}),
    db,
  });
  // The questions write the `model_calls` rows on their own connection; `runWorker` opens its own for the queue.
  const callStore = openStoreFor(config, db);
  const questions = createQuestions(config, sel.transport, { kind: CallerKind.Worker, log, store: callStore });
  const abort = new AbortController();
  const stop = (): void => abort.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await runWorker({ dbPath: db, config, questions, signal: abort.signal, log });
  } catch (e) {
    if (e instanceof LockError) {
      refuse(args, e.message, log);
      return;
    }
    throw e;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    closeStore(callStore);
  }
}

// Runs a synchronous command as an async one: a throw becomes a rejection.
const asAsync =
  (fn: (args: CommandArgs) => void) =>
  (args: CommandArgs): Promise<void> =>
    new Promise((resolve) => {
      fn(args);
      resolve();
    });

function requeueCommand({ db, rest }: CommandArgs): void {
  const store = openStoreFor(loadConfig(db), db);
  try {
    const id = rest[0];
    if (!id) {
      const rows = listFailed(store);
      if (rows.length === 0) printLine("no failed requests");
      for (const r of rows) printLine(formatFailed(store, r));
      return;
    }
    if (requeue(store, id)) printLine(`requeued ${id}`);
    else {
      printError(`${id} is not a failed request`);
      process.exitCode = EXIT_PROBLEM;
    }
  } finally {
    closeStore(store);
  }
}

function check({ db }: CommandArgs): void {
  const store = openStoreFor(loadConfig(db), db);
  try {
    const diffs = checkIndex(store);
    if (diffs.length === 0) {
      printLine("index agrees with fact_versions");
      return;
    }
    for (const d of diffs) printLine(`${d.table}: expected ${d.expected}, found ${d.actual}`);
    printLine("run `wikifact reindex` to rebuild the index");
    process.exitCode = EXIT_PROBLEM;
  } finally {
    closeStore(store);
  }
}

async function reindexCommand({ db }: CommandArgs): Promise<void> {
  const store = openStoreFor(loadConfig(db), db);
  try {
    const r = await reindex(store);
    printLine(`reindexed ${r.versions} fact versions`);
  } finally {
    closeStore(store);
  }
}

/** The commands of the update module. Each prints to stdout or stderr and sets the exit code on a problem. */
export const commands: Command[] = [
  { name: "worker", description: "run the update worker (one per database)", run: worker },
  {
    name: "requeue",
    description: "list failed requests, or put one back in the queue: requeue [id]",
    run: asAsync(requeueCommand),
  },
  { name: "check", description: "compare the index tables with fact_versions (exit 1 on drift)", run: asAsync(check) },
  { name: "reindex", description: "rebuild the index tables and embed everything again", run: reindexCommand },
];
