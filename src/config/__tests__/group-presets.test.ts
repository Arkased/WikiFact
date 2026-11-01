import { describe, expect, it } from "vitest";
import { Quality } from "../../domain/enums.js";
import { QUESTION_IDS, parseConfig } from "../index.js";

describe("the presets of the questions", () => {
  it("every quality table has the model and the effort of every question", () => {
    for (const quality of Object.values(Quality)) {
      const q = parseConfig({ quality }).questions;
      expect(Object.keys(q).sort(), quality).toEqual([...QUESTION_IDS].sort());
    }
  });

  it("loads a config with the removed group keys of the high volume mode and ignores them", () => {
    const old = {
      embeddingModel: "m",
      highVolume: {
        min: 7,
        groupCheck: { min: 1 },
        groupDraft: { min: 1 },
        groupReconcile: { min: 1 },
        neighborDistance: 0.3,
      },
    };
    expect(parseConfig(old).highVolume).toEqual(parseConfig({ embeddingModel: "m" }).highVolume);
  });
});
