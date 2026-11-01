import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ScriptError } from "../lib/shell.js";
import { applyPairs, findTerms, loadTerms, parseTerms } from "../lib/export-terms.js";

const home = ["C:", "Users", "Fake Person"].join("\\");
const homeJson = JSON.stringify(home).slice(1, -1);
const homeFolder = "C--Users-Fake-Person";
const homeUrl = "C%3A%5CUsers%5CFake%20Person";

describe("parseTerms", () => {
  it("reads block terms and pairs, and skips comments and blank lines", () => {
    const terms = parseTerms(`# note\n\nacme corp\n${home} => /home/user\r\n`);
    expect(terms.blocks).toEqual(["acme corp"]);
    expect(terms.pairs).toEqual([{ term: home, replacement: "/home/user" }]);
  });

  it("rejects a term with no letter or digit, which would match every text", () => {
    expect(() => parseTerms("---")).toThrow(ScriptError);
    expect(() => parseTerms("---")).toThrow(/letter or a digit/);
  });
});

describe("loadTerms", () => {
  it("throws a ScriptError when the file is missing or holds no term", () => {
    const dir = mkdtempSync(join(tmpdir(), "wikifact-terms-"));
    try {
      expect(() => loadTerms(join(dir, "none.txt"))).toThrow(ScriptError);
      expect(() => loadTerms(join(dir, "none.txt"))).toThrow(/missing/);
      writeFileSync(join(dir, "empty.txt"), "# nothing\n");
      expect(() => loadTerms(join(dir, "empty.txt"))).toThrow(/holds no term/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("findTerms", () => {
  it("names the line and the term, and ignores case and separators", () => {
    const hits = findTerms("one\nthe Acme-Corp office\nthree", ["acme corp", "other"]);
    expect(hits).toEqual([{ line: 2, term: "acme corp" }]);
  });

  it("finds a path in its JSON form", () => {
    expect(findTerms(`{"cwd":"${homeJson}"}`, [home])).toEqual([{ line: 1, term: home }]);
  });

  it("finds a path in the folder name of Claude Code", () => {
    expect(findTerms(`~/.claude/projects/${homeFolder}/x.jsonl`, [home])).toEqual([{ line: 1, term: home }]);
  });

  it("finds a path in a URL form", () => {
    expect(findTerms(`file:///${["C:", "Users", "Fake%20Person"].join("/")}/x`, [home])).toEqual([
      { line: 1, term: home },
    ]);
  });

  it("finds a term that a line break splits, on the line where it starts", () => {
    expect(findTerms("one\nthe acme\ncorp office\nthree", ["acme corp"])).toEqual([{ line: 2, term: "acme corp" }]);
    expect(findTerms("acme\r\ncorp", ["Acme Corp"])).toEqual([{ line: 1, term: "Acme Corp" }]);
  });

  it("finds a term with an accent in NFD text", () => {
    expect(findTerms("by Jose\u0301 Doe", ["José Doe"])).toEqual([{ line: 1, term: "José Doe" }]);
  });

  it("finds a term that an escape spells in latin1", () => {
    expect(findTerms("by Jos%E9", ["José"])).toEqual([{ line: 1, term: "José" }]);
  });

  it("finds a term that an escape spells in UTF-8, and a double-encoded term", () => {
    expect(findTerms("by Jos%C3%A9 Doe", ["José Doe"])).toEqual([{ line: 1, term: "José Doe" }]);
    expect(findTerms("see Acme%2520Corp", ["Acme Corp"])).toEqual([{ line: 1, term: "Acme Corp" }]);
  });

  it("finds a term after a percent sign that a word follows", () => {
    expect(findTerms("ratio 100%Acme Corp", ["Acme Corp"])).toEqual([{ line: 1, term: "Acme Corp" }]);
  });

  it("finds a term that starts with a digit and hex letters after a percent sign, with an encoded space", () => {
    expect(findTerms("growth 20%4Desk%20Ltd", ["4Desk Ltd"])).toEqual([{ line: 1, term: "4Desk Ltd" }]);
  });

  it("reports the original line for a match found in a decoded view", () => {
    expect(findTerms("a\nb\nJos%E9\nc", ["José"])).toEqual([{ line: 3, term: "José" }]);
  });
});

describe("applyPairs", () => {
  const replacement = ["C:", "Users", "dev", "home"].join("\\");
  const pairs = [{ term: home, replacement }];

  it("replaces the plain spelling by the plain spelling of the replacement", () => {
    expect(applyPairs(`a ${home} b`, pairs)).toBe(`a ${replacement} b`);
  });

  it("replaces the forward spelling by the forward spelling of the replacement", () => {
    expect(applyPairs(`a ${home.replaceAll("\\", "/")} b`, pairs)).toBe(`a ${replacement.replaceAll("\\", "/")} b`);
  });

  it("replaces the JSON spelling by the JSON spelling of the replacement", () => {
    expect(applyPairs(`a ${homeJson} b`, pairs)).toBe(`a ${JSON.stringify(replacement).slice(1, -1)} b`);
  });

  it("replaces the folder name by the folder name of the replacement", () => {
    expect(applyPairs(`~/${homeFolder}/x`, pairs)).toBe("~/C--Users-dev-home/x");
  });

  it("replaces the URL spelling by the URL spelling of the replacement", () => {
    expect(applyPairs(`u=${homeUrl}&v=c%3a%5cusers%5cfake%20person`, pairs)).toBe(
      "u=C%3A%5CUsers%5Cdev%5Chome&v=C%3A%5CUsers%5Cdev%5Chome",
    );
    expect(applyPairs("%2Fx%2Fy%2Fz", [{ term: "/x/y", replacement: "/q" }])).toBe("%2Fq%2Fz");
  });

  it("keeps a JSON text valid, and the replaced path is the replacement", () => {
    const fake = ["C:", "Users", "Fake"].join("\\");
    const out = applyPairs(JSON.stringify({ p: `${fake}\\x` }), [{ term: fake, replacement }]);
    expect(JSON.parse(out)).toEqual({ p: `${replacement}\\x` });
  });

  it("replaces the longest spelling first", () => {
    const both = [
      { term: "acme", replacement: "X" },
      { term: "acme corp", replacement: "Y" },
    ];
    expect(applyPairs("acme corp and ACME", both)).toBe("Y and X");
  });

  it("leaves a spelling outside the 5, and the scan then finds it", () => {
    const term = ["C:", "Users"].join("\\");
    const text = "C:\\\\\\\\Users";
    const out = applyPairs(text, [{ term, replacement: "dev" }]);
    expect(out).toBe(text);
    expect(findTerms(out, [term])).toEqual([{ line: 1, term }]);
  });
});

describe("findTerms, the views of the contract", () => {
  const found = (text: string, term: string) => findTerms(text, [term]).length > 0;

  it("reads each round of the full decode as its own view", () => {
    expect(found("100%25252024%2520Report", "2024 Report")).toBe(true);
    expect(found("50%2525ACME%2520Corp", "ACME Corp")).toBe(true);
  });

  it("stops after 3 rounds of the full decode", () => {
    expect(found("Acme%252520Corp", "Acme Corp")).toBe(true);
    expect(found("Acme%25252520Corp", "Acme Corp")).toBe(false);
  });

  it("finds a term after a literal percent sign and an encoded space", () => {
    expect(found("50%ACME%20Corp", "ACME Corp")).toBe(true);
  });

  it("folds accents and compatibility forms in the text and in the term", () => {
    expect(found("by Jose Doe", "José Doe")).toBe(true);
    expect(found("by José Doe", "Jose Doe")).toBe(true);
    expect(found("by Ｆａｋｅ Person", "Fake Person")).toBe(true);
    expect(found("by Fake Person", "Ｆａｋｅ Person")).toBe(true);
  });

  it("does not find a folder name in which the accented letter became a dash", () => {
    expect(found("C--Users-Jos-", ["C:", "Users", "José"].join("\\"))).toBe(false);
  });

  it("decodes JSON and HTML escapes, 3 rounds at most", () => {
    expect(found("Fak\\u0065 Person", "Fake Person")).toBe(true);
    expect(found("Fak&#101; Person", "Fake Person")).toBe(true);
    expect(found("Fak&#x65; Person", "Fake Person")).toBe(true);
    expect(found("Fake&nbsp;Person", "Fake Person")).toBe(true);
    expect(found("Fak&amp;amp;#101; Person", "Fake Person")).toBe(true);
    expect(found("Fak&amp;amp;amp;amp;#101; Person", "Fake Person")).toBe(false);
  });

  it("decodes the named HTML entities of Latin-1 and Latin Extended-A", () => {
    expect(found("Jos&eacute; Doe", "José Doe")).toBe(true);
    expect(found("Jos&Eacute; Doe", "José Doe")).toBe(true);
    expect(found("Pe&ntilde;a", "Peña")).toBe(true);
    expect(found("Stra&szlig;e", "Straße")).toBe(true);
    expect(found("&Scaron;mid", "Šmid")).toBe(true);
  });

  it("decodes a numeric entity without its semicolon and with leading zeros", () => {
    expect(found("Fak&#101 Person", "Fake Person")).toBe(true);
    expect(found("Fake&#x0000020;Person", "Fake Person")).toBe(true);
    expect(found("Fake&#0000032Person", "Fake Person")).toBe(true);
  });

  it("decodes a name that is not an own key of the table to nothing", () => {
    expect(found("a &constructor; b", "native code")).toBe(false);
    expect(found("a &__proto__; b", "object Object")).toBe(false);
    expect(found("a &toString; b", "native code")).toBe(false);
  });

  it("finds a term in the combined chain of the percent decode and the HTML unescape", () => {
    expect(found("Fak%26%23101%3B Person", "Fake Person")).toBe(true);
  });

  it("finds a term that a line break splits inside a word", () => {
    expect(findTerms("a\nKev\nin", ["Kevin"])).toEqual([{ line: 2, term: "Kevin" }]);
  });

  it("names the line of a match after empty lines", () => {
    expect(findTerms("\n\n\nthe Acme Corp", ["Acme Corp"])).toEqual([{ line: 4, term: "Acme Corp" }]);
    expect(findTerms("\n\n\nthe Acme%20Corp", ["Acme Corp"])).toEqual([{ line: 4, term: "Acme Corp" }]);
  });
});

describe("findTerms, the size", () => {
  it("reports the lines of 3 hits in a text of 10,000 lines", () => {
    const lines = Array.from({ length: 10_000 }, () => "filler");
    for (const line of [1, 5000, 10_000]) lines[line - 1] = "the Acme Corp";
    expect(findTerms(lines.join("\n"), ["Acme Corp"])).toEqual([
      { line: 1, term: "Acme Corp" },
      { line: 5000, term: "Acme Corp" },
      { line: 10_000, term: "Acme Corp" },
    ]);
  });
});

describe("applyPairs, the spellings", () => {
  it("skips the folder spelling of a term with no ASCII letter or digit", () => {
    expect(applyPairs("npm run check -- --fix", [{ term: "李明", replacement: "Li Ming" }])).toBe(
      "npm run check -- --fix",
    );
    expect(applyPairs("a - b", [{ term: "Ö", replacement: "O" }])).toBe("a - b");
    expect(applyPairs("x 李明 y", [{ term: "李明", replacement: "Li Ming" }])).toBe("x Li Ming y");
  });

  it("replaces a term whose lower case is longer", () => {
    expect(applyPairs("in İstanbul now", [{ term: "İstanbul", replacement: "Town" }])).toBe("in Town now");
  });

  it("writes every character that is not an ASCII letter or digit as a dash in the folder name", () => {
    const pairs = [
      { term: ["C:", "Users", "fake.person_x"].join("\\"), replacement: ["C:", "Users", "dev"].join("\\") },
    ];
    expect(applyPairs("~/C--Users-fake-person-x/y", pairs)).toBe("~/C--Users-dev/y");
  });

  it("replaces the URL spelling that keeps %2F as a slash", () => {
    const pairs = [{ term: "a/b c", replacement: "d/e f" }];
    expect(applyPairs("x a/b%20c y", pairs)).toBe("x d/e%20f y");
    expect(applyPairs("x a%2Fb%20c y", pairs)).toBe("x d%2Fe%20f y");
  });
});
