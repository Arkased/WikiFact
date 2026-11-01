import { describe, expect, it } from "vitest";
import { decisionLinksOutsideLists, plainDecisionMentions, rewriteLinks } from "../lib/export-links.js";

// Kept apart from the link, so that the check of the doc anchors does not read the fake file as a real link.
const ANCHOR = "#top";
const STANDARD = "../code-standard.md";
// The text of a decision link, built from parts so that this file holds no plain mention of a record.
const name = (digits: string): string => ["decision", digits].join(" ");
const excluded = (p: string): boolean =>
  p === "CLAUDE.md" || p.startsWith("reports/") || p.startsWith("docs/decisions/");

describe("rewriteLinks", () => {
  it("turns a link to an excluded path into its text, with the anchor and the folder resolved", () => {
    const text = `See [rules](../CLAUDE.md), [log](../reports/a.md${ANCHOR}) and [folder](../reports/).`;
    expect(rewriteLinks("docs/a.md", text, excluded)).toBe("See rules, log and folder.");
  });

  it("keeps a link to a kept path, an anchor, a URL and a path outside the root", () => {
    const text = "[a](b.md) [b](#x) [c](https://example.invalid/CLAUDE.md) [d](../../CLAUDE.md)";
    expect(rewriteLinks("docs/a.md", text, excluded)).toBe(text);
  });

  it("drops an image of an excluded path", () => {
    expect(rewriteLinks("docs/a.md", "x ![shot](../reports/s.png) y", excluded)).toBe("x  y");
  });

  it("removes the only decision link of a reference list, with the parenthesis and the space before it", () => {
    const text = `text ([${name("0183")}](../decisions/0183-x.md)).`;
    expect(rewriteLinks("docs/requirements/a.md", text, excluded)).toBe("text.");
  });

  it("removes a decision link before an issue id with its separator", () => {
    const text = `text ([${name("0164")}](../decisions/0164-x.md), #60).`;
    expect(rewriteLinks("docs/requirements/a.md", text, excluded)).toBe("text (#60).");
  });

  it("removes a last decision link with the separator before it", () => {
    const text = `text ([Tests](${STANDARD}${ANCHOR}), [${name("0155")}](../decisions/0155-x.md)).`;
    expect(rewriteLinks("docs/requirements/a.md", text, excluded)).toBe(`text ([Tests](${STANDARD}${ANCHOR})).`);
  });

  it("removes a decision link after a semicolon and keeps the other items", () => {
    const text = "x ([a](a.md); [d](../decisions/0001-x.md); #5)";
    expect(rewriteLinks("docs/requirements/a.md", text, excluded)).toBe("x ([a](a.md); #5)");
  });

  it("turns a decision link outside a reference list into its text", () => {
    const text = `See [${name("0001")}](../decisions/0001-x.md) and (see [d](../decisions/0001-x.md) here).`;
    expect(rewriteLinks("docs/requirements/a.md", text, excluded)).toBe(`See ${name("0001")} and (see d here).`);
  });

  it("finds the lines of the decision links that are not in a reference list", () => {
    const text =
      "a ([d](../decisions/0001-x.md))\nb [d](../decisions/0001-x.md)\nc ([k](k.md), [d](../decisions/0002-x.md))";
    expect(decisionLinksOutsideLists("docs/requirements/a.md", text)).toEqual([2]);
  });

  it("leaves a reference list inside a code span", () => {
    const list = `\`text ([${name("0183")}](../decisions/0183-x.md)).\``;
    const text = `Write ${list} here ([d](../decisions/0183-x.md)).`;
    expect(rewriteLinks("docs/requirements/a.md", text, excluded)).toBe(`Write ${list} here.`);
  });

  it("leaves a reference list inside a fenced block", () => {
    const fence = "```md\ntext ([d](../decisions/0183-x.md)).\n```";
    const text = `a\n${fence}\nb ([d](../decisions/0183-x.md)).`;
    expect(rewriteLinks("docs/requirements/a.md", text, excluded)).toBe(`a\n${fence}\nb.`);
  });

  it("leaves a link to an excluded path inside a code span", () => {
    const text = "`[rules](../CLAUDE.md)` and [rules](../CLAUDE.md)";
    expect(rewriteLinks("docs/a.md", text, excluded)).toBe("`[rules](../CLAUDE.md)` and rules");
  });

  it("does not count a decision link inside code", () => {
    const link = "[d](../decisions/0001-x.md)";
    const text = `\`${link}\`\n\`\`\`\n${link}\n\`\`\`\n${link}`;
    expect(decisionLinksOutsideLists("docs/requirements/a.md", text)).toEqual([5]);
  });

  it("turns a link with a code label to an excluded path into its label text", () => {
    const text = "See [`0183`](../decisions/0183-x.md) and `code`.";
    expect(rewriteLinks("docs/requirements/a.md", text, excluded)).toBe("See `0183` and `code`.");
  });

  it("removes a reference list that holds a decision link with a code label", () => {
    const text = `text ([\`${name("0183")}\`](../decisions/0183-x.md)).`;
    expect(rewriteLinks("docs/requirements/a.md", text, excluded)).toBe("text.");
  });

  it("counts a decision link with a code label only outside a reference list", () => {
    const link = "[`d`](../decisions/0001-x.md)";
    const text = `a (${link})\nb ${link}`;
    expect(decisionLinksOutsideLists("docs/requirements/a.md", text)).toEqual([2]);
  });

  it("does not read a link across a code span", () => {
    const text = "[a `b](../CLAUDE.md) d`";
    expect(rewriteLinks("docs/a.md", text, excluded)).toBe(text);
    expect(decisionLinksOutsideLists("docs/requirements/a.md", "[a `b](../decisions/0001-x.md) d`")).toEqual([]);
  });

  it("leaves a link inside a fenced block and rewrites the one after it", () => {
    const fence = "```md\n[rules](../CLAUDE.md)\n```";
    const text = `${fence}\n[rules](../CLAUDE.md)`;
    expect(rewriteLinks("docs/a.md", text, excluded)).toBe(`${fence}\nrules`);
  });

  it("keeps the code span of the label of a link to an excluded path", () => {
    const text = "[a `b` c](../CLAUDE.md) and [`x](y)`](../CLAUDE.md)";
    expect(rewriteLinks("docs/a.md", text, excluded)).toBe("a `b` c and `x](y)`");
  });
});

describe("plainDecisionMentions", () => {
  const mention = name("0160");

  it("fails a plain mention in markdown", () => {
    expect(plainDecisionMentions("docs/a.md", `a\nsee (${mention}) here`)).toEqual([2]);
  });

  it("fails a mention in a code comment", () => {
    expect(plainDecisionMentions("src/a.ts", `// ${mention}\nconst a = 1;`)).toEqual([1]);
  });

  it("passes a mention as link text", () => {
    expect(plainDecisionMentions("docs/a.md", `([${mention}](decisions/0160-x.md))`)).toEqual([]);
  });

  it("fails a mention in the text of a link to a URL or to a file that is not a decision", () => {
    expect(plainDecisionMentions("docs/a.md", `[${mention}](https://example.invalid/x)`)).toEqual([1]);
    expect(plainDecisionMentions("docs/a.md", `[${mention}](../design/updates.md)`)).toEqual([1]);
  });

  it("fails a mention in the alt text of an image", () => {
    expect(plainDecisionMentions("docs/a.md", `![${mention}](decisions/0160-x.md)`)).toEqual([1]);
  });

  it("passes a mention in a markdown code span and a code block", () => {
    const text = `\`${mention}\`\n\n\`\`\`\n${mention}\n\`\`\`\n${mention}`;
    expect(plainDecisionMentions("docs/a.md", text)).toEqual([6]);
  });
});
