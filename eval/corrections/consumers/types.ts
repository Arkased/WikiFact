import type { Data, Task } from "../data.js";
import type { Seeded } from "../seed.js";

/** What a consumer gets besides the task. */
interface ConsumerContext {
  seeded: Seeded;
  data: Data;
  /** True when the Stop hook (the correction nudge) is on. */
  hook: boolean;
  /** The folder of the run, for the files of a consumer. */
  runDir: string;
  /** The model id for the consumer; absent means the consumer's own default. */
  model?: string;
  log: (s: string) => void;
}

/**
 * What a consumer reports for one task.
 * `requestIds` are the requests the consumer knows it made. Without them the harness attributes rows by time window and by what they name.
 */
export interface ConsumerOut {
  answer: string;
  toolCalls?: number;
  costUsd?: number;
  turns?: number;
  error?: string;
  requestIds?: string[];
}

/** An agent that answers one task through the wikifact tools. */
export type Consumer = (task: Task, ctx: ConsumerContext) => Promise<ConsumerOut>;
