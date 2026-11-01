import type { Config } from "../../src/config/index.js";
import type { ChangeOutcome } from "../../src/domain/index.js";
import type { CurrentFactRow } from "../../src/store/index.js";
import type { Questions } from "../../src/updates/index.js";
import type { StubScript } from "../../fakes/scripted-stub.js";
import type { CriticalKind, RunMode } from "../lib/enums.js";

/** One fact of the seed wiki in replay.json. */
export interface SeedFact {
  /** The name that the cases and the other seed facts use for this fact. */
  key: string;
  header: string;
  content: string;
  /** The justification of the newest version. */
  just: string;
  /** Keys of the seed facts this fact depends on. */
  refs?: string[];
  deleted?: boolean;
  /** Earlier versions, newest first. */
  older?: { content: string; just: string }[];
}

/** One recorded change request with its expected outcome. */
export interface ReplayCase {
  id: string;
  note: string;
  critical?: CriticalKind;
  /** `priorQuery`: the text of the search that the case ran before it sent the change; the harness runs it for real and sends its `searchId`. */
  request: { change: string; justification: string; targets?: string[]; priorQuery?: string };
  expect: {
    outcome: ChangeOutcome;
    liveDelta: number | number[];
    newFacts?: number | number[];
    contentHas?: string[];
    headerContent?: Record<string, string[]>;
    deleted?: string[];
    revived?: string;
    unchanged?: string[];
  };
  /** The answers of the stub in `--stub` mode. "@key" names a seed fact id. */
  stub?: StubScript;
}

/** The whole replay.json: the seed wiki and the cases. */
export interface ReplayFile {
  subject: string;
  facts: SeedFact[];
  cases: ReplayCase[];
}

/** One row of `current_fact_versions`, as the checks read it. */
export type FactRow = CurrentFactRow;

/** The facts of a store by fact id. */
export type FactSnapshot = Map<string, FactRow>;

/** The result of one case. */
export interface CaseResult {
  id: string;
  note: string;
  critical?: string;
  outcome: string;
  liveDelta: number;
  newFacts: number;
  /** Misses of the pass condition. */
  criticalMisses: string[];
  /** Other misses, reported only. */
  misses: string[];
  errors: string[];
  tokens?: { input: number; output: number };
  startedAt?: string;
  finishedAt?: string;
}

/** The results of a run and whether it passed. */
export interface ReplayReport {
  results: CaseResult[];
  pass: boolean;
}

/** The options of `runReplay`. */
export interface ReplayOptions {
  makeQuestions: (c: ReplayCase, ids: Record<string, string>) => Questions;
  config: Config;
  only?: string;
  log?: (line: Record<string, unknown>) => void;
  /** Cases in flight. Each case has its own store. Default 6. */
  concurrency?: number;
  /** Called when a case finishes, in the order of finishing. */
  onResult?: (r: CaseResult) => void;
}

/** What the results file records about the run besides the cases. */
export interface ReplayMeta {
  mode: RunMode;
  transport: string;
  /** The models of config.questions that the run used; empty in stub mode. */
  models: string[];
}

/** The results file of a run. */
export interface ReplayResultFile {
  startedAt: string;
  finishedAt?: string;
  /** False until the run ends; a file from a run that was stopped early stays false. */
  complete: boolean;
  mode: RunMode;
  transport: string;
  models: string[];
  concurrency: number;
  /** Absent until the run ends. */
  pass?: boolean;
  usage: { input: number; output: number };
  results: CaseResult[];
}

/** The inputs of `checkCase`. */
export interface CheckInput {
  c: ReplayCase;
  file: ReplayFile;
  /** Seed fact ids by key. */
  ids: Record<string, string>;
  before: FactSnapshot;
  after: FactSnapshot;
  /** The outcome of the case request. */
  outcome: string;
  errors: string[];
  questions: Questions;
}
