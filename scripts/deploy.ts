// `npm run deploy [-- --no-task]`: a redeploy of a release tag. It re-creates the scheduled task `WikiFact`
// when its action is stale (before anything is stopped), stops the service on port 7777, packs (the `prepack` script builds,
// once) and installs this checkout globally, prepares `~/wikifact/`, and starts the task (technical/deployment.md,
// "Service mode"). The plugin `wikifact` of `Arkased/claude-setup` holds the Claude Code entry of the management endpoint.
// `ship.ts` runs the same steps through `deployMachine`. Windows first; elsewhere the task steps are skipped.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import fkill from "fkill";
import { portBindings } from "pid-port";
import psList from "ps-list";
import { waitUntilFreeOnHost, waitUntilUsedOnHost } from "tcp-port-used";
import { z } from "zod";
import { DeployStep } from "../eval/lib/enums.js";
import { isMain } from "../eval/lib/main.js";
import { ARGV_USER_OFFSET } from "../src/constants.js";
import { must, requireCleanTree, run, runAsyncScript, runCaptured, ScriptError } from "./lib/shell.js";
import { deployPaths, SERVICE_PORT, type DeployPaths } from "./lib/deploy-paths.js";

/** The name of the scheduled task. */
export const TASK_NAME = "WikiFact";
// The part of `npm ls -g --json` that names the installed version.
const INSTALLED = z.object({ dependencies: z.object({ wikifact: z.object({ version: z.string() }) }) });
/** How long the stop waits for the port to be free, in milliseconds. */
const STOP_TIMEOUT_MS = 10_000;
/** The pause between probes of the port while the stop waits for it to be free, in milliseconds. */
const STOP_POLL_INTERVAL_MS = 250;
/** The word that the command line of a wikifact service contains (the installed `cli.js` path holds it). */
const SERVICE_COMMAND_MARK = "wikifact";
/** The URL of the management endpoint. */
export const MCP_URL = `http://127.0.0.1:${SERVICE_PORT}/mcp`;

/** The outcome of the stop of the service. */
export interface StopOutcome {
  /** The line to print, or the error text when `failed`. */
  message: string;
  /** True when the port is still held after the stop, so that the deploy must end with exit 1. */
  failed: boolean;
}

/** A process that holds the service port. */
export interface ListenerProcess {
  /** The executable name, such as `node.exe`. */
  name: string;
  /** The full command line; empty when it could not be read. */
  cmd: string;
}

/** What `stopService` needs from the outside: the process calls. */
export interface StopIo {
  /** Lists the pids that listen on the service port. */
  listening(): Promise<number[]>;
  /** Reads the name and the command line of a process. */
  describe(pid: number): Promise<ListenerProcess>;
  /** Stops a process and its children. */
  kill(pid: number): Promise<void>;
  /** Waits until the service port is free; false at the timeout. */
  waitFree(): Promise<boolean>;
  /** Prints a line. */
  log(line: string): void;
}

/** What a deploy does. */
export interface DeployOptions {
  /** False with `--no-task`: no stop, create or run of the scheduled task. */
  task: boolean;
}

/**
 * Reads the flags of the deploy script.
 *
 * @param argv - the arguments after the script name
 * @returns the options; the task steps are on unless `--no-task` turns them off
 * @throws {ScriptError} for an unknown flag
 * @sideEffects none
 */
export function parseDeployArgs(argv: string[]): DeployOptions {
  try {
    const { values } = parseArgs({
      args: argv,
      options: { "no-task": { type: "boolean" } },
      allowPositionals: false,
    });
    return { task: values["no-task"] !== true };
  } catch {
    throw new ScriptError("usage: npm run deploy -- [--no-task]");
  }
}

/**
 * Lists the steps of a deploy, in order.
 *
 * @param opts - which optional steps run
 * @returns the step names: read the task, create the task, stop it, pack, install, prepare the folder, run the
 *   task; the task steps are left out with `task: false`
 * @sideEffects none
 */
export function deploySteps(opts: DeployOptions): DeployStep[] {
  return [
    ...(opts.task ? [DeployStep.ReadTask, DeployStep.CreateTask, DeployStep.StopService] : []),
    DeployStep.Pack,
    DeployStep.Install,
    DeployStep.PrepareFolder,
    ...(opts.task ? [DeployStep.RunTask] : []),
  ];
}

/**
 * Decides what the deploy says and does after the stop of the service.
 *
 * @param pids - the pids that listened on the port before the stop
 * @param freed - whether the port was free afterwards (ignored without a pid)
 * @returns the message to print; `failed` when a pid was stopped but the port is still held
 * @sideEffects none
 */
export function stopOutcome(pids: number[], freed: boolean): StopOutcome {
  if (pids.length === 0) return { message: `no service was listening on 127.0.0.1:${SERVICE_PORT}`, failed: false };
  if (freed) {
    return {
      message: `stopped the service on 127.0.0.1:${SERVICE_PORT} (pid ${pids.join(", ")} and its children)`,
      failed: false,
    };
  }
  return {
    message: `port ${SERVICE_PORT} is still in use by pid ${pids.join(", ")} after the stop: nothing was installed`,
    failed: true,
  };
}

/**
 * Tells whether a process is a wikifact service: its command line names `wikifact`.
 *
 * @param proc - the process that holds the port
 * @returns true when the command line contains `wikifact` (case-insensitive); false for an empty command line
 * @sideEffects none
 */
export function isOurService(proc: ListenerProcess): boolean {
  return proc.cmd.toLowerCase().includes(SERVICE_COMMAND_MARK);
}

/**
 * Stops the service that listens on the service port, with its children, and waits for the port to be free.
 *
 * @param io - the process calls
 * @throws {ScriptError} when a listener is not a wikifact service (nothing is stopped), or the port is still held after the stop
 * @sideEffects whatever `io` does
 */
export async function stopService(io: StopIo): Promise<void> {
  const pids = await io.listening();
  for (const pid of pids) {
    const proc = await io.describe(pid);
    if (!isOurService(proc)) {
      throw new ScriptError(
        `port ${SERVICE_PORT} is held by pid ${pid} (${proc.name}), which is not a wikifact service; stop it yourself`,
      );
    }
  }
  for (const pid of pids) await io.kill(pid);
  const outcome = stopOutcome(pids, pids.length === 0 ? true : await io.waitFree());
  if (outcome.failed) throw new ScriptError(outcome.message);
  io.log(outcome.message);
}

/**
 * Builds the text of `start-service.cmd`: it starts the service from the deployment folder, logging to files.
 *
 * @returns the lines of the batch file
 * @sideEffects none
 */
export function startScriptText(): string {
  return [
    "@echo off",
    'cd /d "%USERPROFILE%\\wikifact"',
    `call wikifact serve --wikis ./wikis --http ${SERVICE_PORT} --with-worker`,
    "",
  ].join("\r\n");
}

/**
 * Builds the text of `start-service.ps1`: it starts `start-service.cmd` hidden. A script file holds the quoting, so
 * the task action needs one quoted path only (a path with a space breaks `-Command` once the task strips quotes).
 *
 * @returns the line of the PowerShell file
 * @sideEffects none
 */
export function taskScriptText(): string {
  return 'Start-Process -WindowStyle Hidden -FilePath "$env:USERPROFILE\\wikifact\\start-service.cmd"\r\n';
}

/**
 * Builds the action of the task: hidden PowerShell runs `start-service.ps1`, which starts the batch file hidden. A
 * task that runs `cmd /c` opens a console in the interactive session, and closing it kills the service.
 *
 * @param taskScript - the absolute path of `start-service.ps1`
 * @returns the action, with the path in double quotes
 * @sideEffects none
 */
export function taskAction(taskScript: string): string {
  return `powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${taskScript}"`;
}

/**
 * Builds the arguments of `schtasks /create` for the logon task. `/f` replaces a task that exists.
 *
 * @param taskScript - the absolute path of `start-service.ps1`
 * @returns the arguments, with the action as one value
 * @sideEffects none
 */
export function createTaskArgs(taskScript: string): string[] {
  return ["/create", "/tn", TASK_NAME, "/sc", "onlogon", "/rl", "limited", "/tr", taskAction(taskScript), "/f"];
}

// Creates the deployment folders (no wiki: the owner creates wikis through the management tools) and the launchers.
function prepareFolder(paths: DeployPaths): void {
  mkdirSync(paths.wikis, { recursive: true });
  mkdirSync(paths.logs, { recursive: true });
  writeFileSync(paths.startScript, startScriptText());
  writeFileSync(paths.taskScript, taskScriptText());
}

/** The line printed before the elevated create runs. */
export const ELEVATION_NOTICE = "creating the scheduled task needs elevation: a UAC prompt follows";
/** The message of the deploy when the UAC prompt is refused. */
export const UAC_REFUSED_MESSAGE = "the UAC prompt was refused; the task was not created";
/** The message of the deploy when the task has a wrong action after the elevated create. */
export const ELEVATED_VERIFY_MESSAGE = `the elevated create ran, but the scheduled task ${TASK_NAME} does not have the expected action; nothing was stopped or installed`;

/**
 * Builds the PowerShell command that runs `schtasks` with the given arguments in an elevated child (UAC prompt).
 *
 * @param args - the arguments of `schtasks`
 * @returns the text for `powershell -NoProfile -Command`: `Start-Process` with one single-quoted `-ArgumentList`
 *   string; an argument with a space or a double quote is wrapped in double quotes with its inner double quotes
 *   escaped as `\"` (read by `schtasks`), and a single quote is doubled for PowerShell
 * @sideEffects none
 */
export function elevatedCreateCommand(args: string[]): string {
  const line = args
    .map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))
    .join(" ")
    .replace(/'/g, "''");
  return `Start-Process -FilePath schtasks -ArgumentList '${line}' -Verb RunAs -Wait -WindowStyle Hidden`;
}

/** What `ensureTask` needs from the outside: the process calls. */
export interface TaskIo {
  /** Runs the plain create; returns the exit code and the combined output. */
  create(args: string[]): { code: number; output: string };
  /** Runs the create through the elevated child; false when it failed (UAC refused). */
  createElevated(args: string[]): boolean;
  /** Reads the action of the task; null when absent. */
  read(): string | null;
  /** Prints a line. */
  log(line: string): void;
}

/**
 * Makes the task have the wanted action: skips when current, else creates it, elevating when access is denied.
 *
 * @param taskScript - the absolute path of `start-service.ps1`
 * @param current - the action of the existing task, or null
 * @param io - the process calls
 * @throws {ScriptError} when the create fails for another reason, the UAC prompt is refused, or the action is wrong afterwards
 * @sideEffects whatever `io` does
 */
export function ensureTask(taskScript: string, current: string | null, io: TaskIo): void {
  const wanted = taskAction(taskScript);
  if (!needsCreateTask(current, wanted)) {
    io.log(`the action of the scheduled task ${TASK_NAME} is current: not re-created`);
    return;
  }
  const args = createTaskArgs(taskScript);
  const r = io.create(args);
  if (r.code === 0) return;
  if (!isAccessDenied(r.output)) {
    throw new ScriptError(`schtasks ${args.join(" ")} failed with exit code ${r.code}\n${r.output}`);
  }
  io.log(ELEVATION_NOTICE);
  if (!io.createElevated(args)) throw new ScriptError(UAC_REFUSED_MESSAGE);
  const after = io.read();
  if (after === null || normalizeAction(after) !== normalizeAction(wanted)) {
    throw new ScriptError(ELEVATED_VERIFY_MESSAGE);
  }
}

/**
 * Reads the action of a task from the output of `schtasks /query /tn <name> /xml`.
 *
 * @param xml - the task XML
 * @returns the command and its arguments joined by a space, with the XML entities decoded and the white space
 *   collapsed; null when the XML has no `<Command>`
 * @sideEffects none
 */
export function parseTaskAction(xml: string): string | null {
  const command = /<Command>([\s\S]*?)<\/Command>/.exec(xml)?.[1];
  if (command === undefined) return null;
  const args = /<Arguments>([\s\S]*?)<\/Arguments>/.exec(xml)?.[1] ?? "";
  return normalizeAction(`${decodeXml(command)} ${decodeXml(args)}`);
}

// Decodes the five predefined XML entities (`&amp;` last).
function decodeXml(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// Collapses white space, so that two spellings of one action compare equal.
function normalizeAction(action: string): string {
  return action.replace(/\s+/g, " ").trim();
}

/**
 * Decides whether the task must be created: it must unless its current action already equals the wanted one.
 *
 * @param current - the action of the existing task, or null when the task does not exist
 * @param wanted - the action the script would set
 * @returns true to run `create-task`, false to skip it
 * @sideEffects none
 */
export function needsCreateTask(current: string | null, wanted: string): boolean {
  return current === null || normalizeAction(current) !== normalizeAction(wanted);
}

/**
 * Tells whether the output of a failed `schtasks` call is a refusal for lack of rights.
 *
 * @param output - stdout and stderr of the call
 * @returns true for "Access is denied"
 * @sideEffects none
 */
export function isAccessDenied(output: string): boolean {
  return /access is denied/i.test(output);
}

// Reads the action of the task; null when the task does not exist.
function readTaskAction(): string | null {
  const r = runCaptured("schtasks", ["/query", "/tn", TASK_NAME, "/xml"]);
  return r.code === 0 ? parseTaskAction(r.stdout) : null;
}

// Creates the task before anything is stopped; "Access is denied" goes through an elevated child (UAC prompt).
function createTask(taskScript: string, current: string | null, log: Log): void {
  ensureTask(taskScript, current, {
    create: (args) => {
      const r = runCaptured("schtasks", args);
      return { code: r.code, output: `${r.stdout}\n${r.stderr}` };
    },
    createElevated: (args) =>
      runCaptured("powershell", ["-NoProfile", "-Command", elevatedCreateCommand(args)]).code === 0,
    read: readTaskAction,
    log,
  });
}

// Stops the process tree of a pid (`taskkill /T /F` on Windows); a process that is already gone is not an error. The
// stop runs on Windows only, where `fkill` takes the tree.
async function killTree(pid: number): Promise<void> {
  await fkill(pid, { tree: true, force: true, silent: true });
}

// Lists the distinct pids that listen on the service port (loopback, IPv4 and IPv6), in order of appearance.
async function listeningPids(port: number): Promise<number[]> {
  try {
    return [...new Set((await portBindings(port)).map((b) => b.pid))];
  } catch (e) {
    // `pid-port` throws when no process holds the port; a free port is a stopped service, not an error.
    if (e instanceof Error && /could not find any process/i.test(e.message)) return [];
    throw e;
  }
}

// Reads the name and the command line of a pid. `ps-list` gives no command line on Windows, so there the CIM process
// table supplies it.
async function describePid(pid: number): Promise<ListenerProcess> {
  const found = (await psList()).find((p) => p.pid === pid);
  let cmd = found?.cmd ?? "";
  if (cmd === "" && process.platform === "win32") {
    const r = runCaptured("powershell", [
      "-NoProfile",
      "-Command",
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
    ]);
    if (r.code === 0) cmd = r.stdout.trim();
  }
  return { name: found?.name ?? "unknown", cmd };
}

// Ends the task, then stops the service itself: the launcher is detached, so the task end alone leaves it. The create
// step has run before, so the task exists and no second query is needed; the end of a task that does not run just fails.
async function stopServiceStep(log: Log): Promise<void> {
  if (run("schtasks", ["/end", "/tn", TASK_NAME]).code === 0) log(`ended the scheduled task ${TASK_NAME}`);
  await stopService({
    listening: () => listeningPids(SERVICE_PORT),
    describe: describePid,
    kill: killTree,
    waitFree: () => waitForPort(SERVICE_PORT, STOP_TIMEOUT_MS, STOP_POLL_INTERVAL_MS, false),
    log,
  });
}

/** How long `waitForPort` keeps trying by default, in ms. */
const WAIT_TIMEOUT_MS = 20_000;
/** The pause between two tries of `waitForPort` by default, in ms. */
const WAIT_INTERVAL_MS = 500;

/**
 * Waits for a TCP port on the loopback to accept a connection, or with `open: false` to be free.
 *
 * @param port - the port
 * @param timeoutMs - how long to keep trying
 * @param intervalMs - the pause between tries
 * @param open - true to wait for a listener, false to wait until nothing listens
 * @returns true once the port is in the wanted state, false at the timeout
 * @sideEffects probes 127.0.0.1:`port` with `tcp-port-used`, which tries to bind the port
 */
export async function waitForPort(
  port: number,
  timeoutMs = WAIT_TIMEOUT_MS,
  intervalMs = WAIT_INTERVAL_MS,
  open = true,
): Promise<boolean> {
  try {
    await (open ? waitUntilUsedOnHost : waitUntilFreeOnHost)(port, "127.0.0.1", intervalMs, timeoutMs);
    return true;
  } catch {
    return false;
  }
}

/** Prints a line; the ship script passes a function that also keeps the line for the deploy log. */
export type Log = (line: string) => void;

/**
 * Stops with an error unless HEAD is exactly a release tag: a redeploy installs a released state only.
 *
 * @param describe - returns the tag at HEAD, or null; default `git describe --tags --exact-match`
 * @returns the tag
 * @throws {ScriptError} when HEAD has no tag
 * @sideEffects runs git with the default `describe`
 */
export function requireReleaseTag(
  describe: () => string | null = () => {
    const r = runCaptured("git", ["describe", "--tags", "--exact-match"]);
    return r.code === 0 ? r.stdout.trim() : null;
  },
): string {
  const tag = describe();
  if (tag === null || tag === "") {
    throw new ScriptError("HEAD is not a release tag: check out a tag (git checkout v0.1.18), or use npm run ship");
  }
  return tag;
}

/**
 * Names the installed package and version from the output of `npm ls -g wikifact --json`, without the global prefix
 * (a local path that must not reach the deploy log).
 *
 * @param json - the JSON output of `npm ls -g wikifact --depth=0 --json`
 * @returns a line such as `installed wikifact@0.1.20`
 * @throws {ScriptError} when the output is not JSON or lists no wikifact version
 * @sideEffects none
 */
export function installedLine(json: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new ScriptError("npm ls -g wikifact did not print JSON");
  }
  const found = INSTALLED.safeParse(parsed);
  if (!found.success) throw new ScriptError("npm ls -g wikifact lists no installed wikifact version");
  return `installed wikifact@${found.data.dependencies.wikifact.version}`;
}

/**
 * Redeploys a release: checks that the tree is clean and HEAD is a release tag, then runs the deploy steps.
 *
 * @param opts - which optional steps run; default all
 * @throws {Error} (a `ScriptError`) when the tree is dirty, HEAD is not a release tag, or a step fails
 * @sideEffects see `deployMachine`
 */
export async function deploy(opts: DeployOptions = { task: true }): Promise<void> {
  requireCleanTree();
  requireReleaseTag();
  await deployMachine(opts, (line) => console.log(line));
}

/**
 * Installs the current checkout as the global `wikifact` and restarts the service task. The
 * caller has checked the tree and the tag (`deploy`) or has just made the release (`ship`).
 *
 * @param opts - which optional steps run
 * @param log - prints a line; the lines of the stop, the start and the wait for the port go through it
 * @throws {Error} (a `ScriptError`) when a step fails
 * @sideEffects
 *   - child processes on every OS: `npm` (`pack`, whose `prepack` builds `dist/`; `install -g`; `ls -g`)
 *   - child processes on Windows only: `cmd.exe` (starts `npm.cmd`), `schtasks` (`/query` in the read step, `/create`,
 *     `/end`, `/run`), `netstat -ano` (`pid-port`), `fastlist` (`ps-list`), `taskkill /T /F` (`fkill`), and `powershell`
 *     (1 time per pid that listens on port 7777, to read its command line in `describePid`; 1 time more when
 *     `schtasks /create` is denied, to run it elevated, which shows a UAC prompt)
 *   - files: packs and deletes a tgz in the checkout; creates `~/wikifact/` (folders, `start-service.cmd`,
 *     `start-service.ps1`)
 *   - system: installs globally; may re-create and end the task; stops the process tree on port 7777 (waits up to 10 s
 *     for the port to be free); starts the task; waits up to 20 s for port 7777
 */
export async function deployMachine(opts: DeployOptions, log: Log): Promise<void> {
  const onWindows = process.platform === "win32";
  if (opts.task && !onWindows) {
    log(
      "not Windows: the task steps are skipped; start the service yourself (wikifact serve --wikis ./wikis --http 7777 --with-worker)",
    );
  }
  const paths = deployPaths(homedir());
  let tgz = "";
  let currentAction: string | null = null;
  try {
    for (const step of deploySteps({ ...opts, task: opts.task && onWindows })) {
      switch (step) {
        case DeployStep.ReadTask:
          currentAction = readTaskAction();
          break;
        case DeployStep.CreateTask:
          createTask(paths.taskScript, currentAction, log);
          break;
        case DeployStep.StopService:
          await stopServiceStep(log);
          break;
        case DeployStep.Pack:
          // `prepack` runs `npm run build`; its output is shown, the tgz name is the last stdout line.
          tgz = resolve(must("npm", ["pack"]).trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "");
          break;
        case DeployStep.Install:
          must("npm", ["install", "-g", tgz], true);
          break;
        case DeployStep.PrepareFolder:
          prepareFolder(paths);
          break;
        case DeployStep.RunTask:
          must("schtasks", ["/run", "/tn", TASK_NAME]);
          log(`started the scheduled task ${TASK_NAME}`);
          log(
            (await waitForPort(SERVICE_PORT))
              ? `service listening on 127.0.0.1:${SERVICE_PORT}`
              : `the service did not start listening on 127.0.0.1:${SERVICE_PORT} within 20 s: see the logs in ${paths.logs}`,
          );
          break;
      }
    }
  } finally {
    if (tgz !== "") rmSync(tgz, { force: true });
  }
  log(installedLine(must("npm", ["ls", "-g", "wikifact", "--depth=0", "--json"])));
}

if (isMain(import.meta.url)) void runAsyncScript(() => deploy(parseDeployArgs(process.argv.slice(ARGV_USER_OFFSET))));
