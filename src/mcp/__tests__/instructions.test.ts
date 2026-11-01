import { describe, expect, it } from "vitest";
import {
  CORRECTION_DUTY,
  INSTRUCTIONS_CAP,
  SEARCH_TRIGGER,
  managementInstructions,
  wikiInstructions,
} from "../instructions.js";

const wikis = (n: number, subject = "A subject.") =>
  Array.from({ length: n }, (_, i) => ({ name: `wiki${i}x`, subject: `${subject} #${i}y` }));

describe("wikiInstructions", () => {
  it("has the name, the subject and both triggers", () => {
    const text = wikiInstructions({ name: "minecraft", subject: "A block game." });
    for (const s of ["minecraft", "A block game.", SEARCH_TRIGGER, CORRECTION_DUTY]) expect(text).toContain(s);
  });

  it("has the name and both triggers when the subject is empty", () => {
    const text = wikiInstructions({ name: "minecraft", subject: "" });
    for (const s of ["minecraft", SEARCH_TRIGGER, CORRECTION_DUTY]) expect(text).toContain(s);
  });

  it("shortens a subject that does not fit, so the text stays within the cap and the triggers arrive whole", () => {
    const text = wikiInstructions({ name: "minecraft", subject: "long ".repeat(2000) });
    expect(text.length).toBeLessThanOrEqual(INSTRUCTIONS_CAP);
    for (const s of ["minecraft", "long", SEARCH_TRIGGER, CORRECTION_DUTY]) expect(text).toContain(s);
  });
});

describe("managementInstructions", () => {
  it("names every wiki when they fit, and has both triggers", () => {
    const list = wikis(3);
    const text = managementInstructions(list);
    for (const w of list) for (const s of [w.name, w.subject]) expect(text).toContain(s);
    for (const s of [SEARCH_TRIGGER, CORRECTION_DUTY]) expect(text).toContain(s);
    expect(text).not.toContain("listWikis");
  });

  it("stays within the cap, names the wikis that fit, leaves the others out and points to listWikis", () => {
    const list = wikis(300, "x".repeat(100));
    const text = managementInstructions(list);
    expect(text.length).toBeLessThanOrEqual(INSTRUCTIONS_CAP);
    const named = list.filter((w) => text.includes(w.name));
    expect(named.length).toBeGreaterThan(0);
    expect(named.length).toBeLessThan(list.length);
    // The wikis that fit are the first ones, in order.
    expect(named).toEqual(list.slice(0, named.length));
    expect(text).toContain("listWikis");
    for (const s of [SEARCH_TRIGGER, CORRECTION_DUTY]) expect(text).toContain(s);
  });

  it("stays within the cap for any count near the edge", () => {
    for (let n = 1; n < 80; n++) {
      const text = managementInstructions(wikis(n, "y".repeat(60)));
      expect(text.length).toBeLessThanOrEqual(INSTRUCTIONS_CAP);
    }
  });
});
