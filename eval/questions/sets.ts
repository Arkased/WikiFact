// The labeled sets of technical/questions.md, "Test plan": load a set file, expand the compact fact notation to `FactMaterial`.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  Q2Stands,
  QuestionId,
  RejectReason,
  Q4Relation,
  SupportKind,
  WrongRelatedAction,
  questionMethod,
} from "../../src/domain/index.js";
import { factMaterial, type FactMaterial, type QuestionContext } from "../../src/updates/index.js";
import { CaseGroup, HardNegativeKind } from "../lib/enums.js";

/** An earlier version of a fact in short form. */
interface CompactOlder {
  header?: string;
  content: string;
  just?: string;
  refs?: string[];
  /** This earlier version is a deletion; absent means it is not. */
  deleted?: boolean;
}

/** A fact in short form. `older` lists the earlier versions, newest first. */
interface CompactFact {
  id: string;
  header: string;
  content: string;
  just?: string;
  refs?: string[];
  deleted?: boolean;
  older?: CompactOlder[];
}

/** The label of a case (`expect`): what a correct answer holds. Which fields apply depends on the question; see `score.ts`. */
export interface Label {
  /** Q1: the ids of the matching facts. */
  matches?: string[];
  /** Q2: which fact stands. */
  stands?: Q2Stands;
  /** Q7: whether the change is one claim a reader can act on alone. */
  oneClaim?: boolean;
  /** Q7: the kind of support the justification gives; absent means the case does not check it. */
  support?: SupportKind;
  /**
   * Q7, oneClaim false: the claims of the compound change. The answer must list exactly this many claims, and each entry
   * (words separated by "|", any one of them) must be in a different claim of the answer. Absent means the case does not
   * check the claims.
   */
  claims?: string[];
  /** Q4: whether the claim is supported. */
  supported?: boolean;
  rejectReason?: RejectReason;
  relation?: Q4Relation;
  /** Q4: the related facts to act on; absent means none. */
  wrongRelated?: { factId: string; action: WrongRelatedAction }[];
  /** Q8: whether the dependent fact still holds. */
  holds?: boolean;
  stillDepends?: string[];
  /** Drafting questions: the number of drafts. */
  drafts?: number;
  contentHas?: string[];
  contentLacks?: string[];
  headerHas?: string[];
  headerLacks?: string[];
  refsHas?: string[];
  refsLacks?: string[];
  refsExactly?: string[];
  isDeleted?: boolean;
}

/** One labeled input. */
export interface Case {
  id: string;
  /** The failure mode or the point of the case. */
  note: string;
  /** The input of the question, with facts in short form. */
  input: Record<string, unknown>;
  expect: Label;
  /** Replaces the subject of the set for this case only. */
  ctx?: Partial<QuestionContext>;
  /** Where the case comes from; absent means `CaseGroup.Designed`. */
  group?: CaseGroup;
  /**
   * True for a case of the held-out half: a prompt change is kept only when the score on these cases does not drop
   * ([Test plan](../../docs/technical/questions.md#test-plan)). Absent means the tuning half. Q5 and Q7 mark it.
   */
  heldOut?: boolean;
  /** The kind of hard negative that the case is; absent means the case is none ([Hard negatives](../../docs/technical/questions.md#test-plan)). */
  kind?: HardNegativeKind;
  /** Names the pair of facts that the case is built from; the cases of one family stay on one side of the held-out split. */
  family?: string;
}

/**
 * Gives the group of a case.
 *
 * @param c - the case
 * @returns its `group`, or `CaseGroup.Designed` when the field is absent
 * @sideEffects none
 */
export function groupOf(c: Pick<Case, "group">): CaseGroup {
  return c.group ?? CaseGroup.Designed;
}

/** A set file: the cases of one question and the context that they share. */
export interface SetFile {
  question: QuestionId;
  ctx?: Partial<QuestionContext>;
  cases: Case[];
}

/** The subject that a set uses when its file names none. */
const DEFAULT_CTX: QuestionContext = {
  subject: "The game Minecraft: mobs, damage, health, potions and crafting.",
};

/** The version number step: `seq` of a fact in short form counts in threes. */
const SEQ_STEP = 3;
/** The creation time of the fixture versions, in ms since the epoch; each version adds one second. */
const FIXTURE_EPOCH_MS = 1_700_000_000_000;
const MS_PER_SECOND = 1000;

const compactOlder: z.ZodType<CompactOlder> = z.object({
  header: z.string().optional(),
  content: z.string(),
  just: z.string().optional(),
  refs: z.array(z.string()).optional(),
  deleted: z.boolean().optional(),
});

const compactFact: z.ZodType<CompactFact> = z.object({
  id: z.string(),
  header: z.string(),
  content: z.string(),
  just: z.string().optional(),
  refs: z.array(z.string()).optional(),
  deleted: z.boolean().optional(),
  older: z.array(compactOlder).optional(),
});

/**
 * Expands a fact in short form to the `FactMaterial` that a question takes.
 *
 * @param c - the fact in short form
 * @returns the fact with its versions, newest first
 * @sideEffects none
 */
function expandFact(c: CompactFact): FactMaterial {
  const older = c.older ?? [];
  const total = older.length + 1;
  const versions: FactMaterial["versions"] = [
    {
      seq: total * SEQ_STEP,
      header: c.header,
      content: c.content,
      justification: c.just ?? "",
      references: c.refs ?? [],
      isDeleted: !!c.deleted,
      created: FIXTURE_EPOCH_MS + total * MS_PER_SECOND,
    },
  ];
  older.forEach((o, i) => {
    versions.push({
      seq: (total - 1 - i) * SEQ_STEP,
      header: o.header ?? c.header,
      content: o.content,
      justification: o.just ?? "",
      references: o.refs ?? [],
      isDeleted: !!o.deleted,
      created: FIXTURE_EPOCH_MS + (total - 1 - i) * MS_PER_SECOND,
    });
  });
  return { factId: c.id, isDeleted: !!c.deleted, versions };
}

/**
 * Which input fields hold facts in short form, per question. A path is the keys from the input to the fact, joined by
 * ".". A `[]` after a key marks a list: each element of it is a fact (the last key) or holds the rest of the path.
 */
const FACT_FIELDS: Record<QuestionId, string[]> = {
  [QuestionId.Q1]: [],
  [QuestionId.Q2]: ["kept", "other"],
  [QuestionId.Q3]: ["kept", "others[]"],
  [QuestionId.Q4]: ["existing", "related[]"],
  [QuestionId.Q5]: ["existing", "related[]"],
  [QuestionId.Q6]: ["wrong"],
  [QuestionId.Q7]: [],
  [QuestionId.Q8]: [],
  [QuestionId.Q9]: ["dependent"],
  [QuestionId.Q10]: ["target"],
};

/**
 * Expands the facts of a case input from the short form to `FactMaterial`.
 *
 * @param q - the question, which says which fields hold facts
 * @param input - the input of the case as it stands in the set file
 * @returns a copy of the input with the facts expanded
 * @sideEffects none; throws a ZodError when a fact field is not a fact in short form
 */
export function expandInput(q: QuestionId, input: Record<string, unknown>): Record<string, unknown> {
  let out: unknown = input;
  for (const f of FACT_FIELDS[q]) out = mapPath(out, f.split("."), (v) => expandFact(compactFact.parse(v)));
  return out as Record<string, unknown>;
}

// Applies `fn` to the value at the path of a field of FACT_FIELDS, in a copy. A missing key leaves the value as it is.
function mapPath(value: unknown, path: string[], fn: (fact: unknown) => unknown): unknown {
  const [seg, ...rest] = path;
  if (seg === undefined) return fn(value);
  if (typeof value !== "object" || value === null) return value;
  const list = seg.endsWith("[]");
  const key = list ? seg.slice(0, -2) : seg;
  const record = value as Record<string, unknown>;
  const inner = record[key];
  if (inner === undefined) return value;
  if (!list) return { ...record, [key]: mapPath(inner, rest, fn) };
  if (!Array.isArray(inner)) return value;
  return { ...record, [key]: inner.map((x: unknown) => mapPath(x, rest, fn)) };
}

/**
 * Compacts a fact to the short form: the inverse of `expandFact`, up to the `seq` and `created` of the versions,
 * which the short form regenerates. A field equal to the default of the short form is left out.
 *
 * @param m - the fact with its versions
 * @returns the fact in short form; the newest version gives the top level and the others go to `older`, newest first
 * @throws {Error} when the fact has no version
 * @sideEffects none
 */
function compactFactOf(m: FactMaterial): CompactFact {
  const [newest, ...rest] = [...m.versions].sort((a, b) => b.seq - a.seq);
  if (newest === undefined) throw new Error(`fact ${m.factId} has no version`);
  const out: CompactFact = { id: m.factId, header: newest.header, content: newest.content };
  if (newest.justification !== "") out.just = newest.justification;
  if (newest.references.length > 0) out.refs = newest.references;
  if (m.isDeleted) out.deleted = true;
  if (rest.length > 0) {
    out.older = rest.map((v): CompactOlder => {
      const o: CompactOlder = { content: v.content };
      if (v.header !== newest.header) o.header = v.header;
      if (v.justification !== "") o.just = v.justification;
      if (v.references.length > 0) o.refs = v.references;
      if (v.isDeleted) o.deleted = true;
      return o;
    });
  }
  return out;
}

/**
 * Compacts the facts of a case input from the long form to the short form that a set file holds: the inverse of
 * `expandInput`.
 *
 * @param q - the question, which says which fields hold facts
 * @param input - the input as the call log holds it, with `FactMaterial` facts
 * @returns a copy of the input with the facts in short form; a field that is not a fact in long form stays as it is
 * @sideEffects none
 */
export function compactInput(q: QuestionId, input: Record<string, unknown>): Record<string, unknown> {
  let out: unknown = input;
  for (const f of FACT_FIELDS[q]) {
    out = mapPath(out, f.split("."), (v) => {
      const parsed = factMaterial.safeParse(v);
      return parsed.success ? compactFactOf(parsed.data) : v;
    });
  }
  return out as Record<string, unknown>;
}

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Reads the set file of a question.
 *
 * @param q - the question
 * @returns the cases and the context of the set
 * @throws {Error} when the file is for another question
 * @sideEffects reads `<method>.json` next to this module
 */
export function loadSet(q: QuestionId): SetFile {
  const raw = JSON.parse(readFileSync(join(here, `${questionMethod(q)}.json`), "utf8")) as SetFile;
  if (raw.question !== q) throw new Error(`${questionMethod(q)}.json is a set for ${raw.question}`);
  return raw;
}

/**
 * Builds the question context of a set: the defaults, overridden by what the set names.
 *
 * @param set - the set file
 * @returns the subject
 * @sideEffects none
 */
export function ctxOf(set: SetFile): QuestionContext {
  return { ...DEFAULT_CTX, ...set.ctx };
}

/**
 * Builds the question context of one case: the context of its set, overridden by what the case names.
 *
 * @param base - the context of the set, from `ctxOf`
 * @param c - the case
 * @returns the subject for this case
 * @sideEffects none
 */
export function caseCtx(base: QuestionContext, c: Case): QuestionContext {
  return { ...base, ...c.ctx };
}
