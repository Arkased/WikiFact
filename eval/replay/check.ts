import { required } from "../lib/required-value.js";
import type { CaseResult, CheckInput, FactRow, FactSnapshot } from "./types.js";

const live = (m: FactSnapshot): FactRow[] => [...m.values()].filter((r) => !r.is_deleted);
const lc = (s: string): string => s.toLowerCase();
const inSet = (v: number, want: number | number[]): boolean => (Array.isArray(want) ? want.includes(v) : v === want);

/**
 * Compares the store before and after one case with what the case expects.
 *
 * @param input - the case, the seed ids, the 2 snapshots, the outcome and errors of the run, and the questions (for token usage)
 * @returns the result of the case: critical misses (the pass condition), other misses, and the counts
 * @sideEffects reads and resets the token usage of `input.questions`
 */
export function checkCase(input: CheckInput): CaseResult {
  const { c, file, ids, before, after, outcome, errors, questions } = input;
  const e = c.expect;
  const critical: string[] = [];
  const misses: string[] = [];
  const liveDelta = live(after).length - live(before).length;
  const added = [...after.values()].filter((r) => !before.has(r.fact_id) && !r.is_deleted);
  const touched = live(after).filter((r) => before.get(r.fact_id)?.seq !== r.seq);
  const touchedText = touched.map((r) => r.content).join(" || ");
  const byHeader = (h: string): FactRow | undefined => live(after).find((r) => lc(r.header) === lc(h));
  const seedIdOf = (header: string): string => {
    const f = required(
      file.facts.find((x) => lc(x.header) === lc(header)),
      `replay.json ${c.id}: no seed fact with the header "${header}"`,
    );
    return required(ids[f.key], `replay.json: no id for the seed fact ${f.key}`);
  };

  // The pass condition.
  const flow: string[] = [];
  if (outcome !== String(e.outcome))
    flow.push(`outcome ${outcome}, expected ${e.outcome}${errors.length ? ` (${errors[0] ?? ""})` : ""}`);
  if (!inSet(liveDelta, e.liveDelta))
    flow.push(`live facts changed by ${liveDelta}, expected ${JSON.stringify(e.liveDelta)}`);
  if (e.newFacts !== undefined && !inSet(added.length, e.newFacts))
    flow.push(`${added.length} new facts, expected ${JSON.stringify(e.newFacts)}`);
  (c.critical ? critical : misses).push(...flow);

  const seen = new Set<string>();
  for (const r of live(after)) {
    const k = lc(r.header.trim());
    if (seen.has(k)) critical.push(`duplicate: 2 live facts share the header "${r.header}"`);
    seen.add(k);
  }

  // Everything else is reported only.
  for (const s of e.contentHas ?? [])
    if (!lc(touchedText).includes(lc(s))) misses.push(`no new or changed fact has "${s}"`);
  for (const [h, subs] of Object.entries(e.headerContent ?? {})) {
    const row = byHeader(h);
    if (!row) misses.push(`no live fact "${h}"`);
    else for (const s of subs) if (!lc(row.content).includes(lc(s))) misses.push(`"${h}" lacks "${s}": ${row.content}`);
  }
  for (const h of e.deleted ?? []) {
    if (!after.get(seedIdOf(h))?.is_deleted) misses.push(`"${h}" is not deleted`);
  }
  if (e.revived) {
    const row = after.get(seedIdOf(e.revived));
    if (!row || row.is_deleted) misses.push(`"${e.revived}" is not live again under its old id`);
  }
  for (const h of e.unchanged ?? []) {
    const id = seedIdOf(h);
    if (after.get(id)?.seq !== before.get(id)?.seq) misses.push(`"${h}" was rewritten`);
  }

  const u = questions.takeUsage?.();
  return {
    id: c.id,
    note: c.note,
    critical: c.critical,
    outcome,
    liveDelta,
    newFacts: added.length,
    criticalMisses: critical,
    misses,
    errors,
    tokens: u ? { input: u.input, output: u.output } : undefined,
  };
}
