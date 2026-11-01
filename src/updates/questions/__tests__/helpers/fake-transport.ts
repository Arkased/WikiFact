// A scripted transport and canned replies for the tests of the question layer.
import { StopReason } from "../../../../domain/enums.js";
import type { CallRequest, CallResponse, Transport } from "../../index.js";

/** The context of a question call in the tests. */
export const ctx = { subject: "Minecraft" };

/**
 * Builds a token usage.
 *
 * @param input - the input tokens
 * @param output - the output tokens
 * @returns the usage with no cache tokens
 * @sideEffects none
 */
export const usage = (input = 10, output = 5): CallResponse["usage"] => ({
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
});

/**
 * Builds a finished reply.
 *
 * @param obj - the answer: a string is sent as is, anything else as JSON
 * @param extra - fields that replace the defaults
 * @returns the reply
 * @sideEffects none
 */
export const reply = (obj: unknown, extra: Partial<CallResponse> = {}): CallResponse => ({
  stopReason: StopReason.EndTurn,
  text: typeof obj === "string" ? obj : JSON.stringify(obj),
  usage: usage(),
  ...extra,
});

/** A transport that answers from a script and records every request. */
export class Fake implements Transport {
  readonly requests: CallRequest[] = [];

  /**
   * Makes a transport that answers from a script.
   *
   * @param script - the answers in call order: a reply, or a function that makes the reply from the request; the last
   *   entry answers every call after the script ends
   * @sideEffects none
   */
  constructor(private script: (CallResponse | ((req: CallRequest, signal: AbortSignal) => Promise<CallResponse>))[]) {}

  /**
   * Records the request and answers with the next entry of the script.
   *
   * @param req - the request; a copy is kept in `requests`
   * @param signal - the abort signal, passed to a scripted function
   * @returns the next scripted reply
   * @sideEffects appends a copy of the request to `requests`
   */
  async send(req: CallRequest, signal: AbortSignal): Promise<CallResponse> {
    this.requests.push(structuredClone(req));
    const next = this.script[Math.min(this.requests.length - 1, this.script.length - 1)];
    return typeof next === "function" ? next(req, signal) : next;
  }
}
