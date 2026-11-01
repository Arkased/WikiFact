// The data of the correction test: the seed facts, the tasks and the wrong-term lists.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CORRECTIONS_DIR } from "./paths.js";

/** One fact of the seed. A fact whose `content` differs from `reality` is a wrong fact. */
export interface SeedFact {
  key: string;
  header: string;
  /** What the wiki says. */
  content: string;
  /** What is true in the game. */
  reality: string;
  /** Search queries that should return a new fact (F17). */
  probes?: string[];
}

/** One task: a question whose answer depends on a wrong fact. */
export interface Task {
  id: string;
  /** The key of the wrong fact that the task touches. */
  wrong: string;
  question: string;
  observation: string;
  /** A substring of a right answer, compared in lower case. */
  answerContains: string;
}

/** The words by which a request names a wrong fact without its header: a subject word plus any topic word. */
interface WrongTerms {
  subject: string;
  any: string[];
}

/** Everything the correction test reads from its JSON files. */
export interface Data {
  subject: string;
  facts: SeedFact[];
  newFacts: SeedFact[];
  tasks: Task[];
  terms: Record<string, WrongTerms>;
}

/** The file `facts.json`: the subject and the two fact lists. */
interface FactsFile {
  subject: string;
  facts: SeedFact[];
  newFacts: SeedFact[];
}

/** One `change_requests` row as the result files store it: snake_case names and `targets` as a JSON string. */
export interface RequestRow {
  id: string;
  kind: string;
  change: string | null;
  targets: string;
  justification: string | null;
  received_at: number;
}

// The files are ours and checked in; the cast names the file type once (docs/code-standard.md, section 4).
const readJson = <T>(name: string): T => JSON.parse(readFileSync(join(CORRECTIONS_DIR, name), "utf8")) as T;

/**
 * Reads the seed data from the JSON files next to this module.
 *
 * @returns the facts, new facts, tasks and wrong-term lists
 * @sideEffects reads `facts.json`, `tasks.json` and `wrong-terms.json`
 */
export function loadData(): Data {
  const f = readJson<FactsFile>("facts.json");
  return { ...f, tasks: readJson<Task[]>("tasks.json"), terms: readJson<Data["terms"]>("wrong-terms.json") };
}

/**
 * Tells whether a seed fact is wrong.
 *
 * @param f - the seed fact
 * @returns true when its content differs from the reality
 * @sideEffects none
 */
export function isWrong(f: SeedFact): boolean {
  return f.content !== f.reality;
}
