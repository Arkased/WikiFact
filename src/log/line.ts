// The typed log line. Every log line of `src/` goes through a `Logger`.
import type {
  ChangeOutcome,
  CleanupFinder,
  ConsoleAction,
  LogEvent,
  LogLevel,
  Mode,
  ProcessOutcome,
  RunOnceStatus,
  SessionEndReason,
  ServeTarget,
  CleanupRepairResult,
  WorkerChildState,
} from "../domain/enums.js";

/** The fields of a log line that name the request it is about. */
type ForRequest = Record<"request_id", string>;

/** The payload of a log line, keyed on `event`. The fields are those that each event carries. */
type LogPayload =
  /** One line per committed change of the update agent. */
  | ({
      event: LogEvent.Change;
      seq: number;
      outcome: ChangeOutcome;
      /** "merge" or "lookupRepair" when the change is not the claim's own. */
      kind?: string;
      passes?: number;
      rejudged?: number;
      tokens?: { input: number; output: number };
      duration_ms?: number;
    } & ForRequest)
  | ({ event: LogEvent.Gather; droppedTarget: string } & ForRequest)
  | ({ event: LogEvent.Scope; droppedMatch: string } & ForRequest)
  | ({ event: LogEvent.Judge; droppedWrongRelated: string } & ForRequest)
  | ({ event: LogEvent.ScopeOvermatch; existingFactId: string; keptFactId?: string; reason: string } & ForRequest)
  | ({
      event: LogEvent.PriorQuery;
      result: string;
      repairRequestId?: string;
      factId?: string;
      error?: string;
    } & ForRequest)
  | ({ event: LogEvent.LookupRepair; skipped: string } & ForRequest)
  /** A cleanupRepair request that wrote nothing: its finder, why, and the reason. */
  | ({ event: LogEvent.CleanupRepair; finder: CleanupFinder; result: CleanupRepairResult; reason: string } & ForRequest)
  /** One cleanup run: the finders that ran and the number of requests queued per finder. */
  | { event: LogEvent.CleanupRun; finders: CleanupFinder[]; queued: Record<CleanupFinder, number> }
  /** A reindex job of the operator console ran: the fact versions it indexed. */
  | ({ event: LogEvent.OperatorReindex; versions: number } & ForRequest)
  | ({
      event: LogEvent.AttemptFailed;
      attempt: number;
      status: RunOnceStatus.Queued | RunOnceStatus.Failed;
      error: string;
    } & ForRequest)
  /** One line per rate-limit pause: the request put back, and the wait before the worker takes a request again. */
  | ({ event: LogEvent.RateLimitPause; waitMs: number; error: string } & ForRequest)
  /** The worker saw the `queue_pause` key for the first time; `note` is the reason of the operator. */
  | { event: LogEvent.QueuePause; note: string }
  /** The worker saw the operator pause end. */
  | { event: LogEvent.QueueResume }
  /** The write of a request of a batch was refused: another request changed `facts` after its gather; it runs again alone. */
  | ({ event: LogEvent.BatchStale; facts: string[] } & ForRequest)
  /** A batch ended: the requests by outcome, the failed attempts, the stale writes, the merges of the reconciliation and the time. */
  | {
      event: LogEvent.BatchDone;
      size: number;
      outcomes: Partial<Record<ProcessOutcome, number>>;
      failed: number;
      stale: number;
      merged: number;
      /** The changes that the promotion wrote to the live wiki. */
      promoted: number;
      ms: number;
    }
  /** A staging set of a batch was dropped, unpromoted, and its requests go back to the queue: why, and how many changes it held. */
  | { event: LogEvent.BatchDropped; reason: string; staged: number }
  | { event: LogEvent.WorkerStart; db: string; resetRunning: number }
  | { event: LogEvent.WorkerStop }
  /** The first line of the `worker` command: its mode, its transport and, in local mode, the condition. */
  | { event: LogEvent.Worker; mode: Mode; transport: string; condition?: string; db: string }
  | {
      event: LogEvent.WorkerChild;
      state: WorkerChildState;
      pid?: number;
      reason?: string;
      code?: number | null;
      signal?: string | null;
    }
  /** The service started a new worker child after an exit it did not ask for. */
  | {
      event: LogEvent.WorkerRestart;
      wiki: string;
      code: number | null;
      signal: string | null;
      /** The wait before the new child starts, in ms. */
      delayMs: number;
      /** The restarts of this wiki since the service started, this one included. */
      restarts: number;
    }
  /** An MCP session opened. `wiki` is absent on the management endpoint and on a single-database server. */
  | { event: LogEvent.SessionStart; wiki?: string; sessionId: string; clientName?: string; clientVersion?: string }
  /** An MCP session ended, with its count of tool calls and why. */
  | { event: LogEvent.SessionEnd; wiki?: string; sessionId: string; calls: number; reason: SessionEndReason }
  /** The first line of the `serve` command. */
  | {
      event: LogEvent.Serve;
      mode: Mode;
      transport: string;
      condition?: string;
      withWorker: boolean;
      target: ServeTarget;
      /** The database path (`ServeTarget.Db`) or the wikis folder (`ServeTarget.Wikis`). */
      path: string;
      /** The wiki names of service mode. */
      wikis?: string[];
      /** The `--host` of the HTTP transport. */
      host?: string;
    }
  | { event: LogEvent.Listening; transport: string; host: string; port: number }
  | { event: LogEvent.WikiMounted; name: string; mode: Mode; url: string }
  | { event: LogEvent.WikiCreated; name: string; url: string }
  | { event: LogEvent.WikiArchived; name: string; removed: boolean; archivedTo?: string }
  | { event: LogEvent.WikiRestored; name: string; from: string; url: string }
  | { event: LogEvent.HttpError; error: string }
  | { event: LogEvent.RetrievalError; tool: string; id: string; error: string }
  /** One line per MCP tool call, with the arguments of the call spread in. */
  | ({ event: LogEvent.Tool; tool: string; ok: boolean; durationMs: number; error?: string } & Record<string, unknown>)
  | { event: LogEvent.TempFolderNotDeleted; dir: string; error: string }
  | { event: LogEvent.QuestionTransport; transport: string; rule: string }
  /** One question call. `requestId` is absent when the caller has no request (an eval). */
  | {
      event: LogEvent.QuestionCall;
      requestId?: string;
      question: string;
      model: string;
      effort: string;
      input: unknown;
      ctx: unknown;
      output: unknown;
    }
  /** The directory and the files of a process that logs to files. */
  | { event: LogEvent.LogDir; dir: string; files: string[] }
  | { event: LogEvent.Refused; reason: string }
  | { event: LogEvent.Unhandled; error: string }
  | { event: LogEvent.LockTakeover; pid: number }
  /** One console request: the path without the query, the status sent, and the time to answer. */
  | { event: LogEvent.ConsolePage; path: string; status: number; durationMs: number; error?: string }
  /** One operator action of the console that changed something: the action, the wiki and the id it names, if any. */
  | { event: LogEvent.ConsoleAction; action: ConsoleAction; wiki: string; id?: string };

/**
 * One log line: the payload and its severity. The loggers add the timestamp `ts`; a line itself has none.
 */
export type LogLine = LogPayload & { level: LogLevel };

/** A sink for log lines. */
export type Logger = (line: LogLine) => void;

/**
 * Renders a log line as the JSON text of one file or stderr line: `ts` (ISO time), `event` and `level` first, then
 * the other fields.
 *
 * @param line - the line to render
 * @param now - the time of the line
 * @returns the JSON object as text, without a line break
 * @sideEffects none
 */
export function formatLine(line: LogLine, now: Date): string {
  const { event, level, ...rest } = line;
  return JSON.stringify({ ts: now.toISOString(), event, level, ...rest });
}
