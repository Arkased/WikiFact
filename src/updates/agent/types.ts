import type { ProcessOutcome } from "../../domain/enums.js";
import type { Logger } from "../../log/index.js";
import type { Store } from "../../store/index.js";
import type { FactDraft, Questions } from "../types.js";

/** What the agent needs from `wikifact.json`. The `Config` of `src/config/index.ts` satisfies it. */
export interface PipelineConfig {
  subject: string;
}

/** The injection points of the agent. */
export interface AgentDeps {
  /** One JSON line per change goes here. Default: stderr. */
  log?: Logger;
  /** The clock in ms. Default: `Date.now`. */
  now?: () => number;
  /**
   * The write of the request is refused when another request changed a fact that it rests on after its gather
   * (technical/updates.md, "High volume mode", "Stale check"). Default: false.
   */
  staleCheck?: boolean;
  /**
   * The request is one of a batch that runs in parallel on a staging set (technical/updates.md, "High volume mode"; decision
   * 0153): at step 3 a scope with 2 or more live facts defers the request, and step 9 is left to the promotion. Default: false.
   */
  inBatch?: boolean;
  /**
   * Q7 already let the request through in the run of the batch (technical/updates.md, "High volume mode", "Run"): step 1 asks
   * no Q7 and the pipeline goes on to the gather. Default: false.
   */
  claimChecked?: boolean;
  /**
   * The ids of the requests of the group of this request, itself included. The stale check does not count a version that a
   * request of the group staged: the group call saw their claims together. Default: none.
   */
  group?: string[];
}

/** What `processRequest` reports for one request. */
export interface ProcessResult {
  outcome: ProcessOutcome;
  /** The seq of the claim's change. Absent when nothing was written. */
  seq?: number;
  /** The seqs of the merge changes (technical/updates.md, "Step 3. Merge") committed on the way. */
  mergeSeqs: number[];
  /** The passes of the dependents loop (technical/updates.md, "Dependents loop"); 0 when nothing depends on a changed fact. */
  passes: number;
  /** The dependent facts that Q8 re-judged, over all passes. */
  rejudged: number;
  /**
   * Set by a request of a batch instead of step 9: the fact that the prior query of the request should find. The batch runs
   * the prior query check after the promotion (technical/updates.md, "High volume mode"), because no search finds a staged fact.
   */
  relevantFactId?: string;
  /** The fact that the claim of an accepted submission wrote (a new fact or a new version); absent for any other result. */
  claimFactId?: string;
  /** The lookupRepair request that step 9 of technical/updates.md, "Pipeline" enqueued. */
  repairRequestId?: string;
  /** Q7's reason when step 1 rejected the submission. The worker keeps it on the finished row. */
  error?: string;
  /** The child requests that step 1 queued when it split the submission (technical/submit.md, "Split of a compound submission"), in claim order. */
  childIds?: string[];
}

/** A draft failed the code lint twice. The attempt fails. */
export class LintError extends Error {}

/** What every step function of the pipeline needs: the store, the questions, the config, the log and the clock. */
export interface AgentContext {
  store: Store;
  q: Questions;
  config: PipelineConfig;
  log: Logger;
  now: () => number;
  /** The id of the request that this context belongs to. */
  requestId: string;
  /** The time of the last change log line (or of the start). The next line reports the time since. */
  mark: number;
  /** The write of this request is checked against the changes of other writers after its gather. */
  staleCheck: boolean;
  /** The request is one of a batch: step 3 defers a crowded scope and step 9 runs after the promotion. */
  inBatch: boolean;
  /** Q7 already let the request through: step 1 asks it no more. */
  claimChecked: boolean;
  /** The requests of this request's group; the stale check skips their staged versions. */
  group: string[];
}

/** The facts that steps 5 to 7 have drafted so far. */
export interface Pending {
  facts: FactDraft[];
}
