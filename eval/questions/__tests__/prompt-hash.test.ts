import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { QuestionId } from "../../../src/domain/enums.js";
import { SPECS } from "../../../src/updates/index.js";
import { currentPromptHash, promptHashOf } from "../prompt-hash.js";
import { readResultFile } from "../results.js";
import { selectCurrent } from "../summarize.js";
import { hashedEntry as entry } from "./helpers/entries.js";

const hashOf = () => "current";

describe("promptHash", () => {
  const spec = { system: "Answer the question.", output: z.object({ answer: z.string() }) };

  it("is stable and changes with the prompt text or the output schema", () => {
    expect(promptHashOf(spec)).toBe(promptHashOf({ ...spec }));
    expect(promptHashOf({ ...spec, system: "Answer the question briefly." })).not.toBe(promptHashOf(spec));
    expect(promptHashOf({ ...spec, output: z.object({ answer: z.string(), why: z.string() }) })).not.toBe(
      promptHashOf(spec),
    );
  });

  it("changes with the layout: a spec with a wiki block hashes apart from the same spec with none", () => {
    const withBlock = { ...spec, wiki: () => "<wiki>\nSubject: x\n</wiki>" };
    expect(promptHashOf(withBlock)).not.toBe(promptHashOf(spec));
    for (const q of Object.values(QuestionId)) {
      const real = SPECS[q];
      if (real.wiki === undefined) continue;
      expect(currentPromptHash(q), q).not.toBe(promptHashOf({ system: real.system, output: real.output }));
    }
  });

  it("summarize reads a run of the new layout as its own pool, apart from a run of the old layout", () => {
    const real = SPECS[QuestionId.Q2];
    const oldLayout = promptHashOf({ system: real.system, output: real.output });
    const { kept, counts } = selectCurrent(
      [entry(QuestionId.Q2, oldLayout), entry(QuestionId.Q2, currentPromptHash(QuestionId.Q2))],
      currentPromptHash,
    );
    expect(kept.map((e) => e.promptHash)).toEqual([currentPromptHash(QuestionId.Q2)]);
    expect(counts.Q2).toEqual({ pooled: 1, leftOut: 1 });
  });

  it("selectCurrent pools the entries of the current hash and counts the others as left out", () => {
    const { kept, counts } = selectCurrent(
      [
        entry(QuestionId.Q4, "current"),
        entry(QuestionId.Q4, "old"),
        entry(QuestionId.Q4), // no hash while the question has hashed entries: another prompt
        entry(QuestionId.Q4, "current"),
      ],
      hashOf,
    );
    expect(kept).toHaveLength(2);
    expect(counts.Q4).toEqual({ pooled: 2, leftOut: 2 });
  });

  it("selectCurrent keeps entries without a hash for a question that has no hashed entry", () => {
    const { kept, counts } = selectCurrent(
      [entry(QuestionId.Q4), entry(QuestionId.Q4), entry(QuestionId.Q5, "old"), entry(QuestionId.Q5, "current")],
      hashOf,
    );
    expect(kept.filter((e) => e.question === QuestionId.Q4)).toHaveLength(2);
    expect(counts.Q4).toEqual({ pooled: 2, leftOut: 0 });
    expect(counts.Q5).toEqual({ pooled: 1, leftOut: 1 });
  });

  it("a result file without the field still loads", () => {
    const dir = mkdtempSync(join(tmpdir(), "qhash-"));
    const path = join(dir, "old.json");
    writeFileSync(path, JSON.stringify({ results: [entry(QuestionId.Q4), entry(QuestionId.Q5, "abc")] }));
    const read = readResultFile(path).results;
    expect(read[0]?.promptHash).toBeUndefined();
    expect(read[1]?.promptHash).toBe("abc");
  });
});
