import { constants, getPriority, setPriority } from "node:os";
import { pathToFileURL } from "node:url";
import { errorMessage } from "../../src/must.js";

/** The os calls of `lowerPriorityOrThrow`, injected so that a test changes no real process. */
export interface PriorityOs {
  set: (pid: number, priority: number) => void;
  get: (pid: number) => number;
}

/**
 * Sets a process to the priority class below normal and reads the priority back; it throws on a fault, and `lowerPriority` catches and logs it.
 *
 * @param pid - the process to lower
 * @param os - the os calls; those of `node:os` by default
 * @returns the priority of the process after the change
 * @throws {Error} when the OS refuses the change or the pid does not exist
 * @sideEffects changes the priority of the process
 */
export function lowerPriorityOrThrow(pid: number, os: PriorityOs = { set: setPriority, get: getPriority }): number {
  os.set(pid, constants.priority.PRIORITY_BELOW_NORMAL);
  return os.get(pid);
}

/**
 * Sets a process to the priority class below normal, so that its work leaves the machine usable (docs/code-standard.md#6-tools). Windows
 * gives the class to every child that the process starts later. A fault is logged and never thrown.
 *
 * @param pid - the process to lower; this process by default
 * @sideEffects changes the priority of the process; prints 1 line to stderr on a fault
 */
export function lowerPriority(pid: number = process.pid): void {
  try {
    lowerPriorityOrThrow(pid);
  } catch (error) {
    console.error(`could not lower the priority of pid ${pid}: ${errorMessage(error)}`);
  }
}

/**
 * Tells whether a module is the entry point of the process, so that it runs `main()` only when started directly.
 *
 * @param importMetaUrl - the `import.meta.url` of the calling module
 * @returns true when `process.argv[1]` is that module's file
 * @sideEffects reads `process.argv`
 */
export function isMain(importMetaUrl: string): boolean {
  const entry = process.argv[1];
  return entry !== undefined && importMetaUrl === pathToFileURL(entry).href;
}
