// `--validate`: check the set files against the input schemas of the questions. No API call.
import { QuestionId, isMember } from "../../src/domain/index.js";
import { SPECS } from "../../src/updates/index.js";
import { CaseGroup, HardNegativeKind } from "../lib/enums.js";
import { expandInput, groupOf, loadSet, type Case, type SetFile } from "./sets.js";

/**
 * Counts the families that have cases on both sides of the held-out split.
 *
 * @param q - the question, for the report
 * @param cases - the cases of its set
 * @param print - receives each line of the report
 * @returns the number of families that straddle the split; 0 when no case is marked held-out
 * @sideEffects prints through `print`
 */
function splitFamilies(q: QuestionId, cases: Case[], print: (s: string) => void): number {
  if (!cases.some((c) => c.heldOut === true)) return 0;
  const sides = new Map<string, Set<boolean>>();
  for (const c of cases) {
    if (c.family === undefined) continue;
    sides.set(c.family, (sides.get(c.family) ?? new Set<boolean>()).add(c.heldOut === true));
  }
  const split = [...sides].filter(([, s]) => s.size > 1).map(([family]) => family);
  for (const family of split)
    print(`${q}: family ${JSON.stringify(family)} has cases on both sides of the held-out split`);
  return split.length;
}

/**
 * Checks that every case of the given sets has a unique id, a known group and kind, and an input that matches the input
 * schema of its question, and that no family has cases on both sides of the held-out split.
 *
 * @param qs - the questions whose sets to check
 * @param print - receives each line of the report; default: `console.log`
 * @param load - reads the set of a question; default: `loadSet`
 * @returns the number of problems found
 * @sideEffects reads the set files; prints through `print`
 */
export function validateSets(
  qs: QuestionId[],
  print: (s: string) => void = console.log,
  load: (q: QuestionId) => SetFile = loadSet,
): number {
  let bad = 0;
  for (const q of qs) {
    const set = load(q);
    const ids = new Set<string>();
    let okCount = 0;
    bad += splitFamilies(q, set.cases, print);
    for (const c of set.cases) {
      if (ids.has(c.id)) {
        print(`${q} ${c.id}: duplicate id`);
        bad++;
      }
      ids.add(c.id);
      if (!isMember(CaseGroup, groupOf(c))) {
        print(`${q} ${c.id}: unknown group ${JSON.stringify(c.group)}`);
        bad++;
        continue;
      }
      if (c.kind !== undefined && !isMember(HardNegativeKind, c.kind)) {
        print(`${q} ${c.id}: unknown kind ${JSON.stringify(c.kind)}`);
        bad++;
        continue;
      }
      const r = SPECS[q].input.safeParse(expandInput(q, c.input));
      if (!r.success) {
        print(`${q} ${c.id}: input does not match the ${q} input schema: ${r.error.message}`);
        bad++;
      } else okCount++;
    }
    print(`${q}: ${set.cases.length} cases, ${okCount} valid`);
  }
  return bad;
}
