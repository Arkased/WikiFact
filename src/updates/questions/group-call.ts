// The group call QG of the batch (technical/updates.md, "High volume mode", "Run", stage 3).
import { QuestionId } from "../../domain/enums.js";
import type { GroupCall } from "../types.js";
import type { QuestionsOptions } from "./build.js";
import { Caller } from "./call.js";
import { groupSpec } from "./specs/group.js";

/**
 * Builds the group call on the settings of Q4: the same model and effort, the same transport and timeout.
 *
 * @param o - the options of `buildQuestions`; only the Q4 settings, the timeout, the transport and the store are read
 * @returns the group call, with a retry counter at 0; it returns the tokens of each call with the answer, so that the
 *   batch adds their shares to the usage account of the other questions
 * @sideEffects none at build; each call uses the transport
 */
export function buildGroupCall(o: QuestionsOptions): GroupCall {
  const counter = { retries: 0 };
  const caller = new Caller({
    transport: o.transport,
    timeoutSeconds: o.timeoutSeconds,
    store: o.store,
    onRetry: () => {
      counter.retries++;
    },
  });
  return {
    get retries(): number {
      return counter.retries;
    },
    ask: async (input, ctx) => {
      const { value, usage } = await caller.askMeasured(groupSpec, o.settings[QuestionId.Q4], input, ctx);
      return { output: value, usage };
    },
  };
}
