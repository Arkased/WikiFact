// technical/console.md, "Fact", "Request" and "Change": the word diff of a fact version against the version before it.
import { DiffOp } from "../domain/enums.js";
import { html, type SafeHtml } from "./html.js";

/** A run of words with its operation. */
export interface DiffRun {
  op: DiffOp;
  text: string;
}

const WORD_BOUNDARY = /\s+/;

function words(text: string): string[] {
  const trimmed = text.trim();
  return trimmed === "" ? [] : trimmed.split(WORD_BOUNDARY);
}

/**
 * Computes the word diff of 2 texts by the longest common subsequence of their words.
 *
 * @param before - the old text
 * @param after - the new text
 * @returns the runs in reading order; one `Keep` run when the texts are equal, an empty list when both are empty
 * @sideEffects none
 */
export function wordDiff(before: string, after: string): DiffRun[] {
  const a = words(before);
  const b = words(after);
  // Hand-rolled: a textbook LCS table over 2 word lists under about 30 lines; a diff library would add a dependency
  // for one page element.
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      const ai = lcs[i + 1]?.[j + 1] ?? 0;
      const down = lcs[i + 1]?.[j] ?? 0;
      const right = lcs[i]?.[j + 1] ?? 0;
      const row = lcs[i];
      if (row) row[j] = a[i] === b[j] ? ai + 1 : Math.max(down, right);
    }
  }
  const runs: DiffRun[] = [];
  const push = (op: DiffOp, text: string): void => {
    const last = runs[runs.length - 1];
    if (last?.op === op) last.text = `${last.text} ${text}`;
    else runs.push({ op, text });
  };
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const ai = a[i] ?? "";
    const bj = b[j] ?? "";
    if (ai === bj) {
      push(DiffOp.Keep, ai);
      i++;
      j++;
    } else if ((lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0)) {
      push(DiffOp.Delete, ai);
      i++;
    } else {
      push(DiffOp.Insert, bj);
      j++;
    }
  }
  for (; i < a.length; i++) push(DiffOp.Delete, a[i] ?? "");
  for (; j < b.length; j++) push(DiffOp.Insert, b[j] ?? "");
  return runs;
}

/**
 * Renders a word diff as marked-up text: inserts in `<ins>`, deletes in `<del>`, kept words as text.
 *
 * @param before - the old text
 * @param after - the new text
 * @returns the markup, every word escaped
 * @sideEffects none
 */
export function diffHtml(before: string, after: string): SafeHtml {
  const parts = wordDiff(before, after).map((run) => {
    switch (run.op) {
      case DiffOp.Keep:
        return html`${run.text}`;
      case DiffOp.Insert:
        return html`<ins>${run.text}</ins>`;
      case DiffOp.Delete:
        return html`<del>${run.text}</del>`;
    }
  });
  return html`<span class="diff">${parts.map((p, k) => (k === 0 ? p : html` ${p}`))}</span>`;
}
