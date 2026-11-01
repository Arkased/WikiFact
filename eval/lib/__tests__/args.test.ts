import { describe, expect, it } from "vitest";
import { parseCommandLine } from "../args.js";
import { resultStamp } from "../stamp.js";

describe("parseCommandLine", () => {
  const spec = { flags: ["stub", "verbose"], options: ["out", "runs"], repeatable: ["model"] };

  it("reads flags, options, repeated options and positionals", () => {
    const a = parseCommandLine(["Q1", "--stub", "--model", "a", "--out=x.json", "--model", "b", "Q7"], spec);
    expect([...a.flags]).toEqual(["stub"]);
    expect(a.options.get("out")).toBe("x.json");
    expect(a.lists.get("model")).toEqual(["a", "b"]);
    expect(a.positionals).toEqual(["Q1", "Q7"]);
  });

  it("passes everything after -- through as positionals", () => {
    const a = parseCommandLine(["--stub", "--", "--not-a-flag", "x"], spec);
    expect(a.flags.has("stub")).toBe(true);
    expect(a.positionals).toEqual(["--not-a-flag", "x"]);
  });

  it("omits what was not given and rejects an unknown option", () => {
    const a = parseCommandLine([], spec);
    expect(a.flags.size + a.options.size + a.lists.size + a.positionals.length).toBe(0);
    expect(() => parseCommandLine(["--nope"], spec)).toThrow();
  });
});

describe("resultStamp", () => {
  it("is the ISO time with the colons replaced", () => {
    expect(resultStamp(new Date("2026-10-10T04:07:29.171Z"))).toBe("2026-10-10T04-07-29.171Z");
  });
});
