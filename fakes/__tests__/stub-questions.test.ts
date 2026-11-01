import { describe, expect, it } from "vitest";
import { Q2Stands } from "../../src/domain/enums.js";
import { StubQuestions } from "../stub-questions.js";

const ctx = { subject: "S" };

describe("StubQuestions", () => {
  it("answers Q1 with no match and Q2 with the kept fact by default, and records the calls", async () => {
    const s = new StubQuestions();
    expect(await s.q1({ change: "c", candidates: [] }, ctx)).toEqual({ matches: [] });
    const fact = { factId: "F1", versions: [{ header: "h", content: "c", references: [] }] };
    const r = await s.q2({ kept: fact, other: fact } as never, ctx);
    expect(r.stands).toBe(Q2Stands.Kept);
    expect(s.calls.map((c) => c.q)).toEqual(["q1", "q2"]);
  });

  it("drafts a fact from the change", async () => {
    const s = new StubQuestions();
    const r = await s.q5({ change: "Creepers explode.", justification: "j", related: [] }, ctx);
    expect(r).toEqual({ drafts: [{ header: "Creepers explode.", content: "Creepers explode.", references: [] }] });
  });

  it("takes a scripted answer per call, and the last repeats", async () => {
    const s = new StubQuestions({
      q1: [{ matches: [{ factId: "F1", reason: "a" }] } as never, { matches: [] }],
    });
    const input = { change: "c", candidates: [] };
    expect((await s.q1(input, ctx)).matches).toHaveLength(1);
    expect((await s.q1(input, ctx)).matches).toHaveLength(0);
    expect((await s.q1(input, ctx)).matches).toHaveLength(0);
    expect(s.count("q1")).toBe(3);
  });
});
