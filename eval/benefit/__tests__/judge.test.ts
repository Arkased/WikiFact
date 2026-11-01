import { describe, expect, it } from "vitest";
import { Effort, StopReason } from "../../../src/domain/index.js";
import type { CallRequest, CallResponse, Transport } from "../../../src/updates/index.js";
import { Verdict } from "../../lib/enums.js";
import { modelJudge } from "../judge.js";

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };

// A transport that answers each request with the next text of the list.
function scripted(texts: string[]): Transport & { requests: CallRequest[] } {
  const requests: CallRequest[] = [];
  return {
    requests,
    send(req): Promise<CallResponse> {
      requests.push(req);
      return Promise.resolve({ stopReason: StopReason.EndTurn, text: texts[requests.length - 1] ?? "", usage });
    },
  };
}

const settings = { model: "claude-sonnet-5-5", effort: Effort.Medium };
const input = { question: "Q?", labeledAnswer: "A.", proof: ["a.ts:1"], answer: "A." };

describe("the judge", () => {
  it("returns the verdict and the reason of the model", async () => {
    const t = scripted([JSON.stringify({ verdict: "partial", reason: "half" })]);
    const v = await modelJudge(t, settings).judgeAnswer(input);
    expect(v).toEqual({ verdict: Verdict.Partial, reason: "half" });
    expect(t.requests).toHaveLength(1);
  });

  it("shows the model the question, the label, the proof and the answer, and for a diff the issue and the reference", async () => {
    const t = scripted([
      JSON.stringify({ verdict: "correct", reason: "ok" }),
      JSON.stringify({ verdict: "wrong", reason: "no" }),
    ]);
    const judge = modelJudge(t, settings);
    await judge.judgeAnswer({ ...input, answer: "My answer" });
    const text = t.requests[0]?.messages[0]?.content ?? "";
    for (const part of ["Q?", "A.", "a.ts:1", "My answer"]) expect(text).toContain(part);
    await judge.judgeDiff({ issue: "Issue text", referencePatch: "REFERENCE", diff: "DIFF" });
    const diffText = t.requests[1]?.messages[0]?.content ?? "";
    for (const part of ["Issue text", "REFERENCE", "DIFF"]) expect(diffText).toContain(part);
  });

  it("accepts a verdict in a code fence", async () => {
    const t = scripted(["```json\n" + JSON.stringify({ verdict: "correct", reason: "ok" }) + "\n```"]);
    expect((await modelJudge(t, settings).judgeAnswer(input)).verdict).toBe(Verdict.Correct);
  });

  it("asks once more after an invalid answer, and fails after a second one", async () => {
    const retry = scripted(["not json", JSON.stringify({ verdict: "wrong", reason: "r" })]);
    expect((await modelJudge(retry, settings).judgeAnswer(input)).verdict).toBe(Verdict.Wrong);
    expect(retry.requests).toHaveLength(2);
    const bad = scripted(["not json", JSON.stringify({ verdict: "maybe", reason: "r" })]);
    await expect(modelJudge(bad, settings).judgeAnswer(input)).rejects.toThrow(/no valid verdict/);
  });
});
