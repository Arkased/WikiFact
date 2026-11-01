// technical/deployment.md, "Install and run": the zod schema of `wikifact.json` and the `Config` type. technical/README.md, "Open settings" gives the defaults.
// The key names are fixed.
import { z } from "zod";
import { REMOVED_QUESTION_IDS } from "../constants.js";
import { Effort, Mode, Quality, QuestionId, enumValues } from "../domain/enums.js";
import {
  DEFAULT_AGENT_SEARCH_CAP,
  DEFAULT_RELEVANCE_FLOOR,
  DEFAULT_SEARCH_CAP,
  type Weights,
} from "../store/types/index.js";

/** The ids Q1 to Q10 in order. */
export const QUESTION_IDS = enumValues(QuestionId);

/** The zod schema of an `Effort` value: how hard the model thinks on one question. */
export const effort = z.enum(Effort);

const questionSettings = z.object({ model: z.string().min(1), effort }).strict();

/**
 * The zod schema of a table that maps a question id to a value; an entry of a removed question (`REMOVED_QUESTION_IDS`) is
 * dropped on parse, so that a file written before the removal still loads.
 *
 * @param value - the schema of one entry
 * @returns the schema of the table
 * @sideEffects none
 */
export function questionTable<T extends z.ZodType>(value: T): z.ZodType<Partial<Record<QuestionId, z.output<T>>>> {
  return z.preprocess(
    (table) =>
      typeof table === "object" && table !== null
        ? Object.fromEntries(Object.entries(table).filter(([q]) => !REMOVED_QUESTION_IDS.has(q)))
        : table,
    z.partialRecord(z.enum(QuestionId), value),
  );
}

/** The model and effort of one question. */
export type QuestionSettings = z.infer<typeof questionSettings>;

/** The embedding model that a wiki uses when `wikifact.json` names none. */
const DEFAULT_EMBEDDING_MODEL = "Xenova/bge-small-en-v1.5";

/** The wall-clock timeout of one model call, in seconds. */
export const DEFAULT_QUESTION_TIMEOUT_S = 120;

/** technical/deployment.md, "Local mode". The sentence that states the local-mode limits; named in the first log line of `serve` and `worker`. */
export const LOCAL_CONDITION = "local mode: one user, one account, one machine";

const nonNeg = z.number().finite().nonnegative();
const posNum = z.number().finite().positive();
const weightsSchema = z
  .object({
    wUpdate: nonNeg,
    wConfirm: nonNeg,
    wRead: nonNeg,
    halfLifeConf: posNum,
    wUse: nonNeg,
    useBound: nonNeg,
    halfLifeUse: posNum,
  })
  .partial()
  .strict();

/** technical/updates.md, "High volume mode". The default number of requests in one batch. */
const DEFAULT_BATCH_SIZE = 10;
/** The wait in ms of the oldest front submission at which a batch starts. */
const DEFAULT_BATCH_WAIT_MS = 60_000;
/** The default number of requests and groups of a batch that run at the same time. */
const DEFAULT_BATCH_CONCURRENCY = 4;
/** The cosine distance under which 2 requests of a batch join 1 group (#60). */
const DEFAULT_GROUP_CUT = 0.215;

const posInt = z.number().int().positive();
// Not strict: a `wikifact.json` that still holds a removed key (min, groupCheck, groupDraft, groupReconcile,
// neighborDistance) loads, and zod drops the key.
const highVolumeSchema = z.object({
  batchSize: posInt.default(DEFAULT_BATCH_SIZE),
  waitMs: posInt.default(DEFAULT_BATCH_WAIT_MS),
  concurrency: posInt.default(DEFAULT_BATCH_CONCURRENCY),
  groupCut: z.number().finite().min(0).max(2).default(DEFAULT_GROUP_CUT),
});

/** The settings of the batch (technical/updates.md, "High volume mode"). */
export interface HighVolumeConfig {
  /** BATCH_SIZE: the submissions at the front of the queue at which a batch starts, and its most requests. */
  batchSize: number;
  /** The ms that the oldest front submission waits before a batch starts with fewer than `batchSize`. */
  waitMs: number;
  /** BATCH_CONCURRENCY: requests (the heads) and groups (the judgments) of a batch at the same time. */
  concurrency: number;
  /** 2 requests join 1 group when the cosine distance of the embeddings of their changes is under this cut. */
  groupCut: number;
}

/** The schema of `wikifact.json`: the keys that the file may hold, with their defaults. */
export const configSchema = z
  .object({
    /** technical/deployment.md, "Local mode". `local`: one user, one account, one machine. */
    mode: z.enum(Mode).default(Mode.Deployed),
    /** technical/questions.md, "Quality presets". Picks the preset table that fills `questions`. */
    quality: z.enum(Quality).default(Quality.Standard),
    subject: z.string().default(""),
    /** technical/console.md, "Mount in the service". A longer text for the operator. `listWikis` and the console show it; no question gets it. */
    description: z.string().optional(),
    embeddingModel: z.string().min(1).default(DEFAULT_EMBEDDING_MODEL),
    questions: questionTable(questionSettings).default({}),
    /** Seconds. Wall-clock timeout of one model call. */
    questionTimeout: posNum.default(DEFAULT_QUESTION_TIMEOUT_S),
    /** Half-lives are in ms. */
    weights: weightsSchema.default({}),
    searchCap: z.number().int().positive().default(DEFAULT_SEARCH_CAP),
    agentSearchCap: z.number().int().positive().default(DEFAULT_AGENT_SEARCH_CAP),
    /** technical/lookup.md, "Retrieval pipeline", step 7. Cosine distance; a result that only the vector list holds is dropped beyond it. */
    relevanceFloor: z.number().finite().min(0).max(2).default(DEFAULT_RELEVANCE_FLOOR),
    /** technical/updates.md, "High volume mode". */
    highVolume: highVolumeSchema.default(() => highVolumeSchema.parse({})),
  })
  .strict();

/** The settings of a wiki after `wikifact.json` and the presets are merged. */
export interface Config {
  mode: Mode;
  quality: Quality;
  subject: string;
  /** Absent when `wikifact.json` has no `description`. The worker never reads it. */
  description?: string;
  embeddingModel: string;
  /** Model and effort per question, every one of Q1 to Q10 present. */
  questions: Record<QuestionId, QuestionSettings>;
  /** Seconds. */
  questionTimeout: number;
  weights: Weights;
  searchCap: number;
  agentSearchCap: number;
  /** Cosine distance. */
  relevanceFloor: number;
  highVolume: HighVolumeConfig;
}
