// The cases of the benefit test (technical/evaluation.md, "The benefit test", Inputs): the file, its schema, the checks
// of its shape and the selection by the command line.
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import {
  BenefitGroup,
  BenefitKind,
  Complexity,
  GroupChoice,
  KindChoice,
  QuestionType,
  TaskType,
} from "../lib/enums.js";

/** The wiki fact that a "stale" case writes into the copy before its runs; it is wrong on purpose. */
const staleFact = z.object({
  header: z.string().min(1),
  content: z.string().min(1),
  /** The justification of the wrong fact; default `Stated in <proof file> at line <line>.` from the proof of the case. */
  justification: z.string().min(1).optional(),
});

/** The file and the line that prove the labeled answer at the fill commit. */
const proof = z.object({ file: z.string().min(1), line: z.number().int().min(1) });

const questionCase = z.object({
  id: z.string().min(1),
  kind: z.literal(BenefitKind.Question),
  group: z.nativeEnum(BenefitGroup),
  type: z.nativeEnum(QuestionType),
  complexity: z.nativeEnum(Complexity),
  question: z.string().min(1),
  answer: z.string().min(1),
  answerContains: z.array(z.string().min(1)).min(1),
  proof: z.array(proof).min(1),
  staleFact: staleFact.optional(),
});

const taskCase = z.object({
  id: z.string().min(1),
  kind: z.literal(BenefitKind.Task),
  taskType: z.nativeEnum(TaskType),
  group: z.enum([BenefitGroup.Held, BenefitGroup.Stale]),
  issue: z.string().min(1),
  /** The patch file under the task folder that plants the bug; absent for a feature. */
  setupPatch: z.string().min(1).optional(),
  /** The paths in the repo, relative to its root, of the hidden test files; each is stored in the task folder under `hidden/<path>.hidden`. */
  hiddenTests: z.array(z.string().min(1)).min(1),
  /** The patch file under the task folder with the right change, on top of the setup. */
  referencePatch: z.string().min(1),
  staleFact: staleFact.optional(),
});

const caseSchema = z.discriminatedUnion("kind", [questionCase, taskCase]);

/** The wiki fact that a "stale" case writes into the copy. */
export type StaleFact = z.infer<typeof staleFact>;
/** A repo question and its label. */
export type QuestionCase = z.infer<typeof questionCase>;
/** A repo task. */
export type TaskCase = z.infer<typeof taskCase>;
/** A case of either kind. */
export type BenefitCase = QuestionCase | TaskCase;

/** The suffix of a hidden test in the task folder, so that the test runner of the repo does not run it. */
export const HIDDEN_SUFFIX = ".hidden";
/** The folder of a task under the task folder of the cases file: `hidden/` holds the test files. */
export const HIDDEN_FOLDER = "hidden";

/**
 * Parses the text of a cases file.
 *
 * @param text - the JSON text: an array of cases
 * @returns the cases in file order
 * @throws {Error} when the text is not JSON or a case does not match the schema; the message names the case
 * @sideEffects none
 */
export function parseCases(text: string): BenefitCase[] {
  const parsed = z.array(z.unknown()).safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error("the cases file is not a JSON array");
  return parsed.data.map((raw, i) => {
    const one = caseSchema.safeParse(raw);
    if (!one.success) {
      const id = typeof raw === "object" && raw !== null && "id" in raw ? String(raw.id) : `#${i}`;
      throw new Error(
        `case ${id} is invalid: ${one.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ")}`,
      );
    }
    return one.data;
  });
}

/**
 * Reads and checks a cases file.
 *
 * @param path - the cases file
 * @returns the cases in file order
 * @throws {Error} when the file cannot be read, is invalid, or breaks `checkCases`
 * @sideEffects reads the file
 */
export function loadCases(path: string): BenefitCase[] {
  const cases = parseCases(readFileSync(path, "utf8"));
  const problems = checkCases(cases);
  if (problems.length > 0) throw new Error(`the cases file ${path} has problems:\n${problems.join("\n")}`);
  return cases;
}

/**
 * The folder of the files of a task: next to the cases file, in a folder with the name of the file without its
 * extension, under `tasks/<id>`. For `eval/benefit.json` it is `eval/benefit/tasks/<id>`.
 *
 * @param casesPath - the cases file
 * @param taskId - the id of the task
 * @returns the folder path
 * @sideEffects none
 */
export function taskFolder(casesPath: string, taskId: string): string {
  const stem = basename(casesPath).replace(/\.json$/i, "");
  return join(dirname(casesPath), stem, "tasks", taskId);
}

/**
 * Checks what every cases file must hold: each id once, a staleFact exactly on the "stale" cases, and a setupPatch on
 * a bug fix. A file of an operator may hold any number of cases.
 *
 * @param cases - the cases
 * @returns the problems, one text each; empty when the cases are sound
 * @sideEffects none
 */
export function checkCases(cases: BenefitCase[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const c of cases) {
    if (seen.has(c.id)) problems.push(`the id ${c.id} is used twice`);
    seen.add(c.id);
    if (c.group === BenefitGroup.Stale && !c.staleFact) problems.push(`${c.id} is stale and has no staleFact`);
    if (c.group !== BenefitGroup.Stale && c.staleFact) problems.push(`${c.id} has a staleFact and is not stale`);
    if (c.kind === BenefitKind.Task && c.staleFact && c.staleFact.justification === undefined)
      problems.push(`${c.id} is a stale task and its staleFact has no justification (a task has no proof file)`);
    if (c.kind === BenefitKind.Task && c.setupPatch === undefined && c.taskType === TaskType.Bugfix)
      problems.push(`${c.id} is a bug fix and has no setupPatch`);
  }
  return problems;
}

/**
 * Checks the balance that the design asks for ("The questions", design/evaluation.md): in each group that has
 * questions, 1 simple and 1 complex question of each type. The shipped file keeps it; a file of an operator may not.
 *
 * @param cases - the cases
 * @returns the problems, one text each; empty when the questions are balanced
 * @sideEffects none
 */
export function checkBalance(cases: BenefitCase[]): string[] {
  const problems: string[] = [];
  const questions = cases.filter((c): c is QuestionCase => c.kind === BenefitKind.Question);
  for (const group of Object.values(BenefitGroup)) {
    const inGroup = questions.filter((q) => q.group === group);
    if (inGroup.length === 0) continue;
    for (const type of Object.values(QuestionType)) {
      for (const complexity of Object.values(Complexity)) {
        const n = inGroup.filter((q) => q.type === type && q.complexity === complexity).length;
        if (n !== 1) problems.push(`the group ${group} has ${n} ${complexity} questions of the type ${type}, not 1`);
      }
    }
  }
  return problems;
}

/** The selection of the command line. */
export interface Selection {
  kind: KindChoice;
  group: GroupChoice;
  /** The first `limit` cases after the other filters; absent means all. */
  limit?: number;
}

/**
 * Selects the cases that the command line asks for.
 *
 * @param cases - all cases
 * @param sel - the kind, the group and the limit
 * @returns the cases in file order
 * @sideEffects none
 */
export function selectCases(cases: BenefitCase[], sel: Selection): BenefitCase[] {
  const kept = cases.filter(
    (c) =>
      (sel.kind === KindChoice.All || String(sel.kind) === String(c.kind)) &&
      (sel.group === GroupChoice.All || String(sel.group) === String(c.group)),
  );
  return sel.limit === undefined ? kept : kept.slice(0, sel.limit);
}
