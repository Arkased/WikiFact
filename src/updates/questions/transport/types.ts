// The seam to the network: the request, the response and the interface that every transport implements.
import type { QuestionSettings } from "../../../config/index.js";
import type { MessageRole, QuestionKind } from "../../../domain/enums.js";

/** Token counts of one call. */
export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** One model call, with every setting the caller decided. */
export interface CallRequest {
  model: string;
  kind: QuestionKind;
  effort: QuestionSettings["effort"];
  system: string;
  /** The `<wiki>` block, sent after `system` in the cached prefix. Absent when the question has none. */
  wiki?: string;
  messages: { role: MessageRole; content: string }[];
  /** JSON Schema of the output. */
  schema: Record<string, unknown>;
  maxTokens: number;
  /** Streaming for judgment and drafting. */
  stream: boolean;
  thinking: boolean;
  fallback: boolean;
}

/** Wall time of the request or child process, and the API time that the CLI reports (`duration_api_ms`). */
interface CallTiming {
  wallMs: number;
  apiMs?: number;
}

/** What a transport returns for one call. */
export interface CallResponse {
  stopReason: string | null;
  text: string;
  usage: Usage;
  timing?: CallTiming;
}

/** The seam to the network. The tests give a fake. */
export interface Transport {
  /**
   * Sends one request and waits for the answer.
   *
   * @param req - the model, prompt, messages and settings of the call, all decided by the caller
   * @param signal - aborts the call when the caller's timeout fires
   * @returns the answer text, the stop reason (null when none), the token usage and the timing
   * @throws {RateLimitError} when the API or the CLI reports a rate limit
   * @throws {Error} for any other failure of the call, and on abort
   * @sideEffects a network call (SDK transport) or a `claude` child process (CLI transport), by transport
   */
  send(req: CallRequest, signal: AbortSignal): Promise<CallResponse>;
}
