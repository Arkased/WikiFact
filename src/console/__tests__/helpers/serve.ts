// The console route on a real HTTP port for the POST tests, and a recording `ConsoleWrites`.
import { parseConfig } from "../../../config/index.js";
import { LogEvent, Mode, type Quality } from "../../../domain/enums.js";
import type { LogLine } from "../../../log/index.js";
import { startHttpServer } from "../../../mcp/http.js";
import { WikiError } from "../../../service/errors.js";
import type { ConfigUpdate, RenamedWiki } from "../../../service/edit.js";
import type { ConsoleDeps, ConsoleWrites } from "../../deps.js";
import { consoleRoute } from "../../routes.js";

/** A console on an ephemeral loopback port. */
export interface RunningConsole {
  base: string;
  close(): Promise<void>;
}

/**
 * Serves the console route of the deps.
 *
 * @param deps - the deps
 * @returns the base URL and a close function
 */
export async function serveConsole(deps: ConsoleDeps): Promise<RunningConsole> {
  const handle = await startHttpServer(consoleRoute(deps), { host: "127.0.0.1", port: 0, log: () => undefined });
  return {
    base: `http://127.0.0.1:${handle.port}`,
    close: () => new Promise((resolve) => void handle.server.close(() => resolve())),
  };
}

/**
 * Posts a form without following the redirect.
 *
 * @param base - the base URL
 * @param path - the path
 * @param fields - the form fields
 * @returns the response
 */
export function post(base: string, path: string, fields: Record<string, string>): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
}

/** A `ConsoleWrites` that records its calls. */
export interface FakeWrites {
  writes: ConsoleWrites;
  /** One string per call: the method and its arguments as JSON. */
  calls: string[];
  /** When set, every call throws a `WikiError` with this message. */
  refuse?: string;
  /** What `readRawConfig` returns: the keys of `wikifact.json` as the file holds them. */
  raw: Record<string, unknown>;
}

/**
 * Builds a recording `ConsoleWrites`.
 *
 * @returns the writes and the call list; set `refuse` to make every call throw a `WikiError`
 */
export function fakeWrites(): FakeWrites {
  const calls: string[] = [];
  const record = (method: string, ...args: unknown[]): void => {
    calls.push(`${method} ${JSON.stringify(args)}`);
    if (fake.refuse !== undefined) throw new WikiError(fake.refuse);
  };
  const writes: ConsoleWrites = {
    addWiki: (name: string, subject: string, quality?: Quality) => {
      record("addWiki", name, subject, quality);
      return { name, url: `http://x/wikis/${name}/mcp`, created: true };
    },
    archiveWiki: (name: string) => {
      record("archiveWiki", name);
      return Promise.resolve({ name, archivedTo: `.archive/${name}-1` });
    },
    unarchiveWiki: (name: string) => {
      record("unarchiveWiki", name);
      return Promise.resolve({ name: "restored", url: "http://x/wikis/restored/mcp", restoredFrom: name });
    },
    setDescription: (name: string, text: string) => record("setDescription", name, text),
    // A read, so it is not recorded among the calls.
    readRawConfig: () => fake.raw,
    updateConfig: (name: string, patch: Readonly<Record<string, unknown>>): Promise<ConfigUpdate> => {
      record("updateConfig", name, patch);
      const config = parseConfig({ mode: Mode.Local, subject: "The test wiki." });
      return Promise.resolve({ config, changed: Object.keys(patch), restarted: false });
    },
    renameWiki: (from: string, to: string): Promise<RenamedWiki> => {
      record("renameWiki", from, to);
      return Promise.resolve({ from, name: to, url: `http://x/wikis/${to}/mcp` });
    },
  };
  const fake: FakeWrites = { writes, calls, raw: { mode: Mode.Local, subject: "The test wiki." } };
  return fake;
}

/**
 * Collects the lines of one event.
 *
 * @param lines - every logged line
 * @param event - the event to keep
 * @returns the matching lines
 */
export function linesOf(lines: LogLine[], event: LogEvent): LogLine[] {
  return lines.filter((l) => l.event === event);
}
