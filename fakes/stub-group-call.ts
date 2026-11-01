import type { GroupCall, GroupInput, GroupOutput } from "../src/updates/index.js";

/**
 * A group call with no model: it answers every claim as a supported new fact, with the change as the text of the draft. For
 * `--stub` runs of the bulk test, which check the harness and not the judgments.
 *
 * @returns the group call, with a retry counter that stays 0
 * @sideEffects none
 */
export function stubGroupCall(): GroupCall {
  const answer = (input: GroupInput): GroupOutput => ({
    answers: input.claims.map((c) => ({
      position: c.position,
      verdict: { supported: true, wrongRelated: [], reason: "stub" },
      draft: { header: c.change, content: c.change, references: [] },
    })),
  });
  return { retries: 0, ask: (input) => Promise.resolve({ output: answer(input), usage: { input: 0, output: 0 } }) };
}
