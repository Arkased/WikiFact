import { describe, expect, it } from "vitest";
import { Q2Stands, QuestionId, QuestionKind } from "../../../domain/enums.js";
import { SPECS, type QuestionSpec } from "../index.js";

const ctx = { subject: "The game Minecraft" };
const fact = {
  factId: "F1",
  isDeleted: false,
  versions: [
    {
      seq: 2,
      header: "Creeper damage",
      content: "Creepers do 10 damage.",
      justification: "I lost 10 health.",
      references: ["F0"],
      isDeleted: false,
      created: 1,
    },
  ],
};
const draft = {
  header: "Creeper fuse",
  content: "A creeper explodes 1.5 seconds after it starts to hiss.",
  references: [],
};
const draftResult = { drafts: [draft] };
const changed = [
  { factId: "F0", before: { header: "H", content: "A." }, after: { header: "H", content: "B.", isDeleted: false } },
];

const inputs: Record<string, unknown> = {
  Q1: { change: "Creepers explode for 10.", candidates: [{ factId: "F1", header: "Creeper damage" }] },
  Q2: { kept: fact, other: fact },
  Q3: { kept: fact, others: [fact], content: "Creepers do 10 damage.", lintFailure: "lint-problem" },
  Q4: { change: "c", justification: "j", existing: fact, related: [fact] },
  Q5: { change: "c", justification: "j", related: [fact], lintFailure: "two claims" },
  Q6: {
    wrong: fact,
    claim: { factId: "F9", header: "h", content: "c", justification: "j", references: [] },
  },
  Q7: { change: "Creepers do 10 damage.", justification: "I measured 10 damage." },
  Q8: {
    dependent: { factId: "F1", header: "h", content: "c", justification: "j" },
    changed,
    unchanged: [{ factId: "F5", header: "h", content: "c" }],
  },
  Q9: { dependent: fact, reason: "r", changed },
  Q10: {
    priorQuery: "skellies",
    target: fact,
    results: [{ id: "F2", header: "H" }],
  },
};

const outputs: Record<string, unknown> = {
  Q1: { matches: ["F1"] },
  Q2: { stands: "other", reason: "r" },
  Q3: draftResult,
  Q4: { supported: true, relation: "different", wrongRelated: [{ factId: "F2", action: "narrow" }], reason: "r" },
  Q5: draftResult,
  Q6: draftResult,
  Q7: { oneClaim: false, claims: ["a", "b"], support: "report", reason: "two claims" },
  Q8: { holds: true, stillDepends: ["F0"], reason: "r" },
  Q9: draftResult,
  Q10: draftResult,
};

const ids = Object.keys(SPECS) as (keyof typeof SPECS)[];

// A spec with its input and output types erased, so a fixture can be passed without a cast per call.
const specOf = (id: QuestionId) => SPECS[id] as QuestionSpec<unknown, unknown>;

describe("the 10 questions", () => {
  it("are the 10 questions of the update worker", () => {
    expect(ids).toHaveLength(10);
  });

  for (const id of ids) {
    it(`${id}: input and output schemas accept the design shapes`, () => {
      const spec = specOf(id);
      expect(spec.input.safeParse(inputs[id]).success).toBe(true);
      expect(spec.output.safeParse(outputs[id]).success).toBe(true);
      expect(spec.check?.(outputs[id], inputs[id], ctx)).toBeUndefined();
      expect(typeof spec.render(inputs[id], ctx)).toBe("string");
    });

    it(`${id}: schemas reject a wrong input and a wrong output`, () => {
      const spec = specOf(id);
      expect(spec.input.safeParse({}).success).toBe(false);
      expect(spec.output.safeParse({}).success).toBe(false);
      expect(spec.output.safeParse({ ...(outputs[id] as object), extra: 1 }).success).toBe(true); // unknown keys are stripped, not trusted
    });
  }

  it("Q2 accepts each stands value, unrelated included", () => {
    for (const stands of Object.values(Q2Stands)) {
      expect(specOf(QuestionId.Q2).output.safeParse({ stands, reason: "r" }).success).toBe(true);
    }
    expect(Object.values(Q2Stands)).toContain("unrelated");
  });

  it("judgment and drafting questions put the subject in the wiki block, and no wiki block in the message", () => {
    for (const id of ids) {
      const spec = specOf(id);
      expect(spec.render(inputs[id], ctx), id).not.toContain("<wiki>");
      const text = spec.wiki?.(ctx) ?? spec.render(inputs[id], ctx);
      if (spec.kind === QuestionKind.Classification) continue;
      expect(text, id).toContain("The game Minecraft");
    }
  });

  it("the wiki block of every question is the subject alone", () => {
    for (const id of ids) {
      const spec = specOf(id);
      if (spec.kind === QuestionKind.Classification || !spec.wiki) continue;
      expect(spec.wiki(ctx), id).toContain("Minecraft");
    }
  });

  it("Q5 and Q3 messages carry the lint failure", () => {
    expect(specOf(QuestionId.Q5).render(inputs.Q5, ctx)).toContain("two claims");
    expect(specOf(QuestionId.Q3).render(inputs.Q3, ctx)).toContain("lint-problem");
  });
});
