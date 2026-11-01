import type { ReplayReport } from "./types.js";

/**
 * Prints one line per case with its misses, then the totals and the verdict.
 *
 * @param r - the report of a run
 * @param write - receives each line; defaults to `console.log`
 * @sideEffects calls `write` (the console by default)
 */
export function printReport(r: ReplayReport, write: (s: string) => void = console.log): void {
  for (const x of r.results) {
    const flag = x.criticalMisses.length ? "FAIL" : x.misses.length ? "miss" : "ok  ";
    const sign = x.liveDelta >= 0 ? "+" : "";
    const tokens = x.tokens ? `, tokens ${x.tokens.input} in / ${x.tokens.output} out` : "";
    write(
      `${flag} ${x.id}  ${x.note}${x.critical ? `  [${x.critical}]` : ""}\n       outcome ${x.outcome}, live facts ${sign}${x.liveDelta}, new ${x.newFacts}${tokens}`,
    );
    for (const m of x.criticalMisses) write(`       CRITICAL ${m}`);
    for (const m of x.misses) write(`       miss ${m}`);
    for (const m of x.errors) write(`       error ${m}`);
  }
  const crit = r.results.filter((x) => x.criticalMisses.length).length;
  const missed = r.results.filter((x) => x.misses.length).length;
  write(
    `\n${r.results.length} cases, ${crit} with a duplicate or compound failure, ${missed} with other misses (reported only).`,
  );
  write(r.pass ? "PASS: no duplicate and no compound fact." : "FAIL: a duplicate or a compound fact.");
}
