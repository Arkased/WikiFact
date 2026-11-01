// technical/deployment.md, "MCP sessions": the open sessions of an MCP endpoint, their `sessions` rows and their end.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ulid } from "ulid";
import { LogEvent, LogLevel, SessionEndReason } from "../domain/enums.js";
import type { Logger } from "../log/index.js";
import { endSession, openSession, touchSession, type Store } from "../store/index.js";

/** A session that makes no call for this long ends, in ms: 30 minutes. */
export const SESSION_IDLE_MS = 1_800_000;

/** How often the idle check runs, in ms: 1 minute. */
export const SESSION_SWEEP_MS = 60_000;

/** What a tool call needs of its session. */
export interface SessionHandle {
  /** The MCP session id: the `Mcp-Session-Id` header, or a ULID on stdio. */
  readonly id: string;
  /** The id of the `sessions` row for the store functions: the session id, the same in every wiki it touches. */
  readonly rowId: string;
  /** Counts 1 tool call: in memory, and in the `sessions` row when the endpoint has a wiki store. */
  touch(): void;
  /**
   * Management endpoint only: the call names a wiki. The call counts on the `sessions` row that the session opened in
   * that wiki at connect.
   *
   * @returns the row id, or `null` when the session has no row in that wiki (the wiki was mounted after the session
   *   opened, or made again), so a record that links to a session must not name it
   */
  enterWiki?(wiki: string, store: Store): string | null;
}

/** The client that opened a session, from `clientInfo` of the `initialize` request. */
export interface ClientInfo {
  name?: string;
  version?: string;
}

/** The options of `McpSessions` and `stdioSession`. */
export interface SessionsOptions {
  /** The write connection of the wiki; absent on the management endpoint, which writes its rows in `wikiStores`. */
  store?: Store;
  /** The management endpoint: the mounted wikis with their write connections, read at each `initialize`. */
  wikiStores?: () => Iterable<[string, Store]>;
  /** The wiki name for the log lines; absent on the management endpoint and on a single-database server. */
  wiki?: string;
  log: Logger;
  /** The clock in ms since the epoch. Default `Date.now`. */
  now?: () => number;
}

// The `sessions` rows and the log lines of a session. A failed row write is logged and never fails a call.
class SessionLedger {
  constructor(private readonly o: SessionsOptions) {}

  private guard(what: string, write: (store: Store) => void, store: Store | undefined = this.o.store): void {
    if (store === undefined) return;
    try {
      write(store);
    } catch (e) {
      this.o.log({ event: LogEvent.HttpError, level: LogLevel.Error, error: `${what}: ${String(e)}` });
    }
  }

  // The rows of a management session, in the store of each wiki that it touches.
  openRowIn(store: Store | undefined, id: string, at: number, client: ClientInfo): void {
    this.guard(
      "open session",
      (s) => openSession(s, { id, startedAt: at, clientName: client.name, clientVersion: client.version }),
      store,
    );
  }

  touchIn(store: Store | undefined, id: string, at: number): void {
    this.guard("touch session", (s) => touchSession(s, id, at), store);
  }

  endRowIn(store: Store | undefined, id: string, endedAt: number): void {
    this.guard("end session", (s) => endSession(s, id, endedAt), store);
  }

  open(id: string, at: number, client: ClientInfo): void {
    this.openRowIn(this.o.store, id, at, client);
    this.o.log({
      event: LogEvent.SessionStart,
      level: LogLevel.Info,
      ...(this.o.wiki === undefined ? {} : { wiki: this.o.wiki }),
      sessionId: id,
      ...(client.name === undefined ? {} : { clientName: client.name }),
      ...(client.version === undefined ? {} : { clientVersion: client.version }),
    });
  }

  touch(id: string, at: number): void {
    this.touchIn(this.o.store, id, at);
  }

  end(id: string, calls: number, endedAt: number, reason: SessionEndReason): void {
    this.endRowIn(this.o.store, id, endedAt);
    this.o.log({
      event: LogEvent.SessionEnd,
      level: LogLevel.Info,
      ...(this.o.wiki === undefined ? {} : { wiki: this.o.wiki }),
      sessionId: id,
      calls,
      reason,
    });
  }
}

interface OpenRecord {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastCallAt: number;
  calls: number;
  client: ClientInfo;
  /** Management endpoint: the wikis the session touched, with the store that holds its row. */
  wikis: Map<string, Store>;
}

/**
 * The open sessions of 1 MCP endpoint. A wiki endpoint has a store and writes its `sessions` row at `initialize`; the
 * management endpoint has none and writes a row in every wiki mounted at `initialize`.
 */
export class McpSessions {
  private readonly open = new Map<string, OpenRecord>();
  private readonly ledger: SessionLedger;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | undefined;

  /**
   * Makes an empty session set.
   *
   * @param opts - the store of the wiki (absent: no rows), the wiki name for the log, the logger and the clock
   * @sideEffects none; the idle timer starts with the first session
   */
  constructor(private readonly opts: SessionsOptions) {
    this.ledger = new SessionLedger(opts);
    this.now = opts.now ?? Date.now;
  }

  /**
   * Makes the id of a new session and the handle that its tools use.
   *
   * @returns the ULID and the handle; the session is not open until `register`
   * @sideEffects reads the clock (for the ULID)
   */
  create(): SessionHandle {
    const id = ulid();
    return {
      id,
      rowId: id,
      touch: () => {
        const record = this.open.get(id);
        if (record === undefined) return;
        const at = this.now();
        record.lastCallAt = at;
        record.calls += 1;
        this.ledger.touch(id, at);
      },
      ...(this.opts.store === undefined ? { enterWiki: (wiki, store) => this.enterWiki(id, wiki, store) } : {}),
    };
  }

  /**
   * Counts a call of a management session on its row in one wiki. The row was written at connect.
   *
   * @param id - the session id
   * @param wiki - the wiki name
   * @param store - the write connection of the wiki
   * @returns the row id, or `null` when the session has no row in that store
   * @sideEffects one update on `store` when the session has a row there
   */
  private enterWiki(id: string, wiki: string, store: Store): string | null {
    const record = this.open.get(id);
    // A different store under the same name is a wiki that was archived and made again: the session has no row there.
    if (record?.wikis.get(wiki) !== store) return null;
    this.ledger.touchIn(store, id, this.now());
    return id;
  }

  /**
   * Ends the rows of every management session in one wiki, before the wiki archive or rename closes its store. The
   * sessions stay open and their rows in other wikis stay open.
   *
   * @param wiki - the name of the wiki that goes away
   * @sideEffects one update on the store of that wiki for each session that touched it
   */
  endWiki(wiki: string): void {
    const at = this.now();
    for (const [id, record] of this.open) {
      const store = record.wikis.get(wiki);
      if (store === undefined) continue;
      record.wikis.delete(wiki);
      this.ledger.endRowIn(store, id, at);
    }
  }

  /**
   * Opens a session: keeps its transport and server, writes its row and logs `session_start`. The idle timer starts
   * when this is the first open session.
   *
   * @param id - the id from `create`
   * @param parts - the transport and the server of the client
   * @param parts.transport - the transport; closed when the session ends
   * @param parts.server - the MCP server; closed when the session ends
   * @param client - the name and the version from `clientInfo`
   * @sideEffects one insert on the store (a management session: one in each mounted wiki); one log line; starts a timer that runs every `SESSION_SWEEP_MS`
   */
  register(
    id: string,
    parts: { transport: StreamableHTTPServerTransport; server: McpServer },
    client: ClientInfo,
  ): void {
    const at = this.now();
    const wikis = new Map<string, Store>();
    this.open.set(id, { ...parts, lastCallAt: at, calls: 0, client, wikis });
    this.ledger.open(id, at, client);
    // A management session opens its row in every wiki mounted now, so a session that calls no tool is counted.
    for (const [wiki, store] of this.opts.wikiStores?.() ?? []) {
      this.ledger.openRowIn(store, id, at, client);
      wikis.set(wiki, store);
    }
    this.timer ??= setInterval(() => void this.sweep(), SESSION_SWEEP_MS).unref();
  }

  /**
   * Finds the transport of an open session.
   *
   * @param id - the `Mcp-Session-Id` of the request
   * @returns the transport, or `undefined` for an unknown or ended session
   * @sideEffects none
   */
  transport(id: string): StreamableHTTPServerTransport | undefined {
    return this.open.get(id)?.transport;
  }

  /**
   * Ends a session: removes it, sets `ended_at`, logs `session_end`, and closes its transport and server. A second
   * call for the same id does nothing. The end by idle sets `ended_at` to the time of the last call.
   *
   * @param id - the session id
   * @param reason - why it ends
   * @returns when the transport and the server are closed
   * @sideEffects one update on the store (a management session: one in each wiki it touched); one log line; closes the
   *   transport and the server
   */
  async end(id: string, reason: SessionEndReason): Promise<void> {
    const record = this.open.get(id);
    if (record === undefined) return;
    this.open.delete(id);
    if (this.open.size === 0) this.stopTimer();
    const endedAt = reason === SessionEndReason.Idle ? record.lastCallAt : this.now();
    this.ledger.end(id, record.calls, endedAt, reason);
    for (const store of record.wikis.values()) this.ledger.endRowIn(store, id, endedAt);
    await Promise.allSettled([record.transport.close(), record.server.close()]);
  }

  /**
   * Ends every session that made no call for `SESSION_IDLE_MS`.
   *
   * @param at - the time of the check; default the clock
   * @returns when every idle session is closed
   * @sideEffects as `end` for each idle session
   */
  async sweep(at: number = this.now()): Promise<void> {
    const idle = [...this.open].filter(([, r]) => at - r.lastCallAt >= SESSION_IDLE_MS).map(([id]) => id);
    await Promise.all(idle.map((id) => this.end(id, SessionEndReason.Idle)));
  }

  /**
   * Ends every session with reason `shutdown` and stops the timer.
   *
   * @returns when every session is closed
   * @sideEffects as `end` for each open session
   */
  async close(): Promise<void> {
    this.stopTimer();
    await Promise.all([...this.open.keys()].map((id) => this.end(id, SessionEndReason.Shutdown)));
  }

  private stopTimer(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }
}

/** The one session of a stdio process. */
export interface StdioSession {
  handle: SessionHandle;
  /** Sets `ended_at` and logs `session_end` with reason `shutdown`; a second call does nothing. */
  end(): void;
}

/**
 * Starts the one session of a stdio process: inserts its row and logs `session_start`.
 *
 * @param opts - the store, the wiki name for the log, the logger and the clock
 * @returns the handle for the tools and `end` for the process end
 * @sideEffects one insert on the store; one log line; `end` writes one update and one log line
 */
export function stdioSession(opts: SessionsOptions): StdioSession {
  const ledger = new SessionLedger(opts);
  const now = opts.now ?? Date.now;
  const id = ulid();
  let calls = 0;
  let ended = false;
  ledger.open(id, now(), {});
  return {
    handle: {
      id,
      rowId: id,
      touch: () => {
        if (ended) return;
        calls += 1;
        ledger.touch(id, now());
      },
    },
    end: () => {
      if (ended) return;
      ended = true;
      ledger.end(id, calls, now(), SessionEndReason.Shutdown);
    },
  };
}
