import { RuleTester } from "eslint";
import tseslint from "typescript-eslint";
import { describe, it } from "vitest";
import rule from "../no-magic-numbers.js";

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({ languageOptions: { parser: tseslint.parser } });

describe("no-magic-numbers", () => {
  tester.run("no-magic-numbers", rule, {
    valid: [
      "const a = 0; const b = 1; const c = -1;",
      "const DAY_MS = 24 * 60 * 60 * 1000;",
      "const STEPS = [1, 2, 4, 8];",
      "const LIMITS = { low: 5, high: { max: 10 } };",
      "enum E { A = 5, B = 6 }",
      "type T = 5 | -5;",
      "const x = list[2];",
      "use(list[3]);",
      "const s = 'text'; const t = `${s}`;",
    ],
    invalid: [
      { code: "f(2);", errors: [{ messageId: "magic" }] },
      { code: "let n = 5 * 60;", errors: [{ messageId: "magic" }, { messageId: "magic" }] },
      { code: "x.slice(2);", errors: [{ messageId: "magic" }] },
      { code: "const f = () => 7;", errors: [{ messageId: "magic" }] },
      { code: "const f = () => { return 30 * 1000; };", errors: [{ messageId: "magic" }, { messageId: "magic" }] },
      { code: "const o = { run: function () { return 3; } };", errors: [{ messageId: "magic" }] },
      { code: "function f(n = 10) { return n; }", errors: [{ messageId: "magic" }] },
      { code: "let y = -2;", errors: [{ messageId: "magic", data: { value: "-2" } }] },
      { code: "use(list[1 + 2]);", errors: [{ messageId: "magic" }] },
      { code: "var v = 9;", errors: [{ messageId: "magic" }] },
    ],
  });
});
